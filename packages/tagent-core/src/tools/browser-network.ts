import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import { assertPublicUrl, createPublicLookup, publicFetch } from '../public-network.js';
import { browserUpstreamProxy } from './browser-proxy-config.js';
import { requestSignal } from '../run-control.js';

export const resolvedPageUrl = (page: Page) => page.url();

async function createBrowserProxy(allowedDomains?: string[]) {
  const lifetime = new AbortController();
  const upstreamProxy = await browserUpstreamProxy();
  const password = randomBytes(24).toString('hex');
  const authorization = `Basic ${Buffer.from(`tagent:${password}`).toString('base64')}`;
  const sockets = new Set<Socket>();
  const server = createServer(async (request, response) => {
    if (request.headers['proxy-authorization'] !== authorization) {
      response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="TAgent"' }).end(); return;
    }
    try {
      const target = assertPublicUrl(request.url || '', allowedDomains);
      if (target.protocol !== 'http:') throw new Error('HTTPS requires CONNECT');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error('Request too large');
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && !['proxy-authorization', 'proxy-connection', 'connection', 'host'].includes(name)) {
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
      }
      const result = await publicFetch(target, {
        method: request.method, headers, body: chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined,
        allowedDomains, redirect: 'manual', signal: requestSignal(15_000, lifetime.signal),
      });
      const outputHeaders = Object.fromEntries(result.headers);
      delete outputHeaders['transfer-encoding'];
      response.writeHead(result.status, { ...outputHeaders, 'set-cookie': result.headers.getSetCookie() });
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch { response.writeHead(403).end('Public network policy blocked this request'); }
  });
  server.maxConnections = 128;
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  });
  server.on('connect', async (request, client, head) => {
    if (request.headers['proxy-authorization'] !== authorization) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="TAgent"\r\n\r\n'); return;
    }
    try {
      const target = assertPublicUrl(`https://${request.url}`, allowedDomains);
      if (target.pathname !== '/' || target.search || (target.port && target.port !== '443')) throw new Error('Not an HTTPS tunnel');
      // Chromium retains end-to-end TLS. The socket receives only an IP approved in its lookup callback.
      const upstream = await openTunnel(target, upstreamProxy, lifetime.signal);
      if (client.destroyed) { upstream.destroy(); return; }
      sockets.add(upstream);
      const destroy = () => { upstream.destroy(); client.destroy(); };
      upstream.setTimeout(30_000, destroy);
      upstream.on('error', destroy);
      client.on('error', destroy);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
      // Bound both directions of each research tunnel, including encrypted/compressed traffic.
      let bytes = 0;
      const count = (data: Buffer) => { bytes += data.length; if (bytes > 20 * 1024 * 1024) destroy(); };
      upstream.on('data', count); client.on('data', count);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    } catch { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  let closed = false;
  return {
    settings: { server: `http://127.0.0.1:${(server.address() as { port: number }).port}`, username: 'tagent', password, bypass: '<-loopback>' },
    close: () => {
      if (closed) return;
      closed = true;
      lifetime.abort();
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

async function openTunnel(target: URL, proxy?: URL, signal?: AbortSignal): Promise<Socket> {
  signal?.throwIfAborted();
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (!proxy) return new Promise((resolve, reject) => {
    const socket = connect({ host, port: 443, lookup: createPublicLookup(), signal });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
    socket.setTimeout(10_000, () => socket.destroy(new Error('Public connection timed out')));
  });
  const ip = await new Promise<string>((resolve, reject) => createPublicLookup()(host, {}, (error, address) => {
    if (error) reject(error); else resolve(String(address));
  }));
  const authority = `${ip.includes(':') ? `[${ip}]` : ip}:443`;
  signal?.throwIfAborted();
  // Forward an already checked IP, not the untrusted hostname, to prevent proxy-side DNS rebinding.
  return new Promise((resolve, reject) => {
    const req = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
      hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT', path: authority, agent: false, signal, headers: {
        Host: authority,
        ...(proxy.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } : {}),
      },
    });
    req.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200 || head.length) { socket.destroy(); reject(new Error('Upstream proxy refused public connection')); return; }
      resolve(socket);
    });
    req.once('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('Upstream proxy timed out')));
    req.end();
  });
}

export async function createPublicBrowserContext(browser: Browser, allowedDomains?: string[], signal?: AbortSignal): Promise<BrowserContext> {
  signal?.throwIfAborted();
  const proxy = await createBrowserProxy(allowedDomains);
  let context: BrowserContext | undefined;
  const onAbort = () => { proxy.close(); void context?.close().catch(() => {}); };
  try {
    signal?.throwIfAborted();
    context = await browser.newContext({
      locale: 'zh-CN', serviceWorkers: 'block', acceptDownloads: false, proxy: proxy.settings,
    });
    context.on('close', proxy.close);
    context.on('close', () => signal?.removeEventListener('abort', onAbort));
    signal?.addEventListener('abort', onAbort, { once: true });
    signal?.throwIfAborted();
    await context.route('**/*', async route => {
      try {
        assertPublicUrl(route.request().url(), allowedDomains);
        if (['image', 'media', 'font'].includes(route.request().resourceType())) { await route.abort(); return; }
        await route.continue();
      } catch { await route.abort('blockedbyclient').catch(() => {}); }
    });
    // The proxy also checks redirected requests that do not re-enter Playwright routing.
    await context.routeWebSocket('**/*', socket => socket.close());
    return context;
  } catch (error) { signal?.removeEventListener('abort', onAbort); await context?.close().catch(() => {}); proxy.close(); throw error; }
}
