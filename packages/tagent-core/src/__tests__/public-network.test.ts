import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));
import { assertPublicUrl, createPublicLookup, isPublicAddress, publicFetch, PublicNetworkError } from '../public-network.js';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('public network policy', () => {
  it.each([
    'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1',
    'http://localhost.', 'https://host.localhost', 'http://intranet', 'http://app.corp',
    'http://169.254.169.254/latest', 'http://168.63.129.16', 'http://100.64.0.1',
    'http://192.0.2.1', 'http://198.18.0.1', 'http://224.0.0.1', 'http://240.0.0.1',
    'http://[::]', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://[fc00::1]',
    'http://[fe80::1]', 'http://[2001:db8::1]', 'http://[64:ff9b::7f00:1]',
    'file:///etc/passwd', 'https://name:secret@public.example/',
  ])('rejects non-public address without fetching: %s', async url => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(publicFetch(url)).rejects.toBeInstanceOf(PublicNetworkError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('matches domain boundaries and validates public IPv4/IPv6', () => {
    expect(assertPublicUrl('https://docs.example.com', ['.example.com']).hostname).toBe('docs.example.com');
    expect(() => assertPublicUrl('https://notexample.com', ['.example.com'])).toThrow('允许范围');
    expect(() => assertPublicUrl('https://docs.example.com', ['example.com'])).toThrow('允许范围');
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('pins checked DNS results and rejects mixed public/private answers', async () => {
    const resolve = vi.fn().mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
      .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }, { address: '::1', family: 6 }]);
    const guarded = createPublicLookup(resolve);
    const run = () => new Promise<unknown>((done, fail) => guarded('public.example', { all: true }, (error, result) => error ? fail(error) : done(result)));
    expect(await run()).toEqual([{ address: '1.1.1.1', family: 4 }]);
    await expect(run()).rejects.toThrow('解析包含');
    await expect(run()).rejects.toThrow('解析包含');
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('blocks DNS-to-loopback at the real HTTP connection, not only in a URL precheck', async () => {
    let requests = 0;
    const server = createServer((_req, res) => { requests++; res.end('private'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    try {
      await expect(publicFetch(`http://attacker.example:${port}/private`)).rejects.toThrow('解析包含');
      expect(lookup).toHaveBeenCalled();
      expect(requests).toBe(0);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('checks redirects before fetching and does not leak credentials to another origin', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://other.example/end' } }))
      .mockResolvedValueOnce(new Response('result'));
    vi.stubGlobal('fetch', fetch);
    const response = await publicFetch('https://first.example/start', { headers: { Authorization: 'Bearer private', Cookie: 'secret', 'X-Api-Key': 'private', Accept: 'text/plain' } });
    expect(response.url).toBe('https://other.example/end');
    expect(await response.text()).toBe('result');
    const headers = fetch.mock.calls[1][1].headers as Headers;
    expect([...headers]).toEqual([['accept', 'text/plain']]);
    fetch.mockReset().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://[::ffff:127.0.0.1]/' } }));
    await expect(publicFetch('https://first.example/start')).rejects.toThrow('拦截');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects POST redirects, TLS downgrades and unbounded redirect chains', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 307, headers: { location: '/again' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(publicFetch('https://first.example', { method: 'POST', body: 'private' })).rejects.toThrow('重定向');
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    await expect(publicFetch('https://first.example')).rejects.toThrow('重定向');
    expect(fetch).toHaveBeenCalledTimes(6);
    fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://first.example/' } }));
    await expect(publicFetch('https://first.example')).rejects.toThrow('降级');
  });

  it('keeps redirect cookies scoped to the issuing domain and isolated between requests', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: {
      location: 'https://sub.example.com/final', 'set-cookie': 'region=public; Domain=example.com; Path=/; Secure',
    } })).mockResolvedValueOnce(new Response('ok')).mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    await publicFetch('https://www.example.com/start');
    expect(fetch.mock.calls[1][1].headers.get('cookie')).toBe('region=public');
    await publicFetch('https://sub.example.com/final');
    expect(fetch.mock.calls[2][1].headers.get('cookie')).toBeNull();
  });

  it('cancels a header-only connectivity probe without waiting for an SSE stream', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/event-stream' } })));
    const response = await publicFetch('https://first.example/mcp', { readBody: false });
    expect(response.ok).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('limits actual body bytes even without Content-Length and retains UTF-8', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('中文'.repeat(100)))
      .mockResolvedValueOnce(new Response('中文', { headers: { 'content-encoding': 'gzip', 'content-length': '20' } })));
    await expect(publicFetch('https://first.example', { maxBytes: 100 })).rejects.toThrow('大小限制');
    const response = await publicFetch('https://first.example', { maxBytes: 100 });
    expect(await response.text()).toBe('中文');
    expect(response.headers.has('content-encoding')).toBe(false);
  });

  it('streams before EOF and releases the upstream reader on consumer cancellation', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: 中文\n\n')); }, cancel }))));
    const response = await publicFetch('https://stream.example/mcp', { streamBody: true });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('中文');
    await reader.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds streaming bytes and interrupts an open stream on abort', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(200)); }, cancel }))));
    const large = await publicFetch('https://stream.example/mcp', { streamBody: true, maxBytes: 100 });
    await expect(large.text()).rejects.toThrow('大小限制');
    expect(cancel).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const cancelled = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }))));
    const response = await publicFetch('https://stream.example/mcp', { streamBody: true, signal: controller.signal });
    const reading = response.text();
    controller.abort(new Error('fixture cancellation'));
    await expect(reading).rejects.toThrow('fixture cancellation');
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
