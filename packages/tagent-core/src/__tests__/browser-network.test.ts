import { createServer, request } from 'node:http';
import type { Socket } from 'node:net';
import type { Browser } from 'playwright';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), proxy: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('../tools/browser-proxy-config.js', () => ({ browserUpstreamProxy: mocks.proxy }));
import { createPublicBrowserContext } from '../tools/browser-network.js';

afterEach(() => vi.clearAllMocks());

async function context() {
  let close = () => {};
  let settings: { server: string; username: string; password: string; bypass: string };
  const ctx = { on: (_name: string, fn: () => void) => { close = fn; }, route: vi.fn(), routeWebSocket: vi.fn() };
  const browser = { newContext: vi.fn(async (options: { proxy: typeof settings }) => { settings = options.proxy; return ctx; }) };
  await createPublicBrowserContext(browser as unknown as Browser);
  return { close: () => close(), settings: settings!, browser, ctx };
}

function proxyRequest(server: string, path: string, headers: Record<string, string>, connect = false): Promise<number> {
  const url = new URL(server);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, method: connect ? 'CONNECT' : 'GET', path, headers });
    req.once('response', response => { response.resume(); resolve(response.statusCode!); });
    req.once('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode!); });
    req.once('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Test proxy timed out')));
    req.end();
  });
}

it('authenticates the local proxy and blocks private targets even without Playwright routing', async () => {
  mocks.proxy.mockResolvedValue(undefined);
  const instance = await context();
  const { server, username, password } = instance.settings;
  const auth = { 'Proxy-Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  try {
    expect(instance.settings.bypass).toBe('<-loopback>');
    expect(instance.browser.newContext.mock.calls[0][0]).toMatchObject({ serviceWorkers: 'block', acceptDownloads: false });
    expect(await proxyRequest(server, 'http://public.example/', {})).toBe(407);
    for (const target of ['http://127.0.0.1:3001/api', 'http://169.254.169.254/', 'http://[::1]/']) {
      expect(await proxyRequest(server, target, auth)).toBe(403);
    }
    for (const target of ['127.0.0.1:443', '[::ffff:127.0.0.1]:443', 'public.example:22']) {
      expect(await proxyRequest(server, target, auth, true)).toBe(403);
    }
    expect(mocks.lookup).not.toHaveBeenCalled();
  } finally { instance.close(); }
});

it('sends only a checked IP to the trusted upstream proxy, never an attacker-controlled DNS name', async () => {
  const sockets = new Set<Socket>();
  let authority = '';
  const upstream = createServer();
  upstream.on('connect', (req, socket) => { authority = req.url!; socket.write('HTTP/1.1 200 OK\r\n\r\n'); });
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  mocks.proxy.mockResolvedValue(new URL(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
  mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  const instance = await context();
  const { server, username, password } = instance.settings;
  const auth = { 'Proxy-Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  try {
    expect(await proxyRequest(server, 'public.example:443', auth, true)).toBe(200);
    expect(authority).toBe('1.1.1.1:443');
    authority = '';
    mocks.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    expect(await proxyRequest(server, 'rebound.example:443', auth, true)).toBe(403);
    expect(authority).toBe('');
  } finally {
    instance.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
