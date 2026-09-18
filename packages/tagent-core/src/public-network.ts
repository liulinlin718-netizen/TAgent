import { lookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';
import { CookieJar } from 'tough-cookie';

export class PublicNetworkError extends Error {
  constructor(message: string) { super(`网络安全拦截: ${message}`); this.name = 'PublicNetworkError'; }
}

export function isPublicAddress(address: string): boolean {
  try {
    const ip = ipaddr.parse(address);
    // Mapped/translated addresses are rejected too, not just IPv4 private ranges.
    return ip.range() === 'unicast' && address !== '168.63.129.16';
  } catch { return false; }
}

export function assertPublicUrl(input: string | URL, allowedDomains?: string[]): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new PublicNetworkError('无效的网页地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new PublicNetworkError('只允许不含凭据的 HTTP(S) 地址');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host)) {
    if (!isPublicAddress(host)) throw new PublicNetworkError('不能访问本机、内网或保留地址');
  } else if (!host.includes('.') || /(^|\.)(localhost|local|internal|corp|home|lan)$/.test(host)) {
    throw new PublicNetworkError('不能访问内部主机名');
  }
  if (allowedDomains?.length && !allowedDomains.some(domain => {
    const normalized = domain.toLowerCase().replace(/\.$/, '');
    return normalized.startsWith('.') ? host === normalized.slice(1) || host.endsWith(normalized) : host === normalized;
  })) throw new PublicNetworkError('目标域名不在允许范围内');
  url.hash = '';
  return url;
}

type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export function createPublicLookup(resolve: Resolver = hostname => lookup(hostname, { all: true, verbatim: true })): LookupFunction {
  // Validation is in the socket's lookup callback. No second DNS lookup can replace the checked IP.
  return (hostname, options, callback) => {
    void resolve(hostname).then(addresses => {
      if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
        throw new PublicNetworkError('域名解析包含内网或保留地址');
      }
      const family = typeof options === 'number' ? options : options.family;
      const eligible = family ? addresses.filter(item => item.family === family) : addresses;
      if (!eligible.length) throw new PublicNetworkError('域名没有可用的公网地址');
      if (typeof options === 'object' && options.all) callback(null, eligible);
      else callback(null, eligible[0].address, eligible[0].family);
    }).catch(error => callback(error, '', 4));
  };
}

export interface PublicFetchOptions extends RequestInit {
  allowedDomains?: string[];
  maxBytes?: number;
  readBody?: boolean;
  streamBody?: boolean;
}

/** Bounded public HTTP only; model endpoints and operator-managed database connections are separate. */
export async function publicFetch(input: string | URL, options: PublicFetchOptions = {}): Promise<Response> {
  const { allowedDomains, maxBytes = 5 * 1024 * 1024, readBody = true, streamBody = false, ...init } = options;
  const cookieJar = new CookieJar();
  let url = assertPublicUrl(input, allowedDomains);
  const method = (init.method || 'GET').toUpperCase();
  let headers = new Headers(init.headers);
  for (const name of ['host', 'connection', 'proxy-authorization', 'content-length']) headers.delete(name);
  const dispatcher = new Agent({ connect: { lookup: createPublicLookup(), timeout: 10_000 } });
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(init.signal ? [init.signal] : [])]);
  let streamOwnsDispatcher = false;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const request = { ...init, headers, signal, redirect: 'manual' as const, dispatcher };
      const response = await fetch(url.toString(), request);
      for (const cookie of response.headers.getSetCookie()) {
        await cookieJar.setCookie(cookie, url.toString(), { ignoreError: true });
      }
      if ([301, 302, 303, 307, 308].includes(response.status) && init.redirect !== 'manual') {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (init.redirect === 'error' || !location || hop === 5 || !['GET', 'HEAD'].includes(method)) {
          throw new PublicNetworkError('不允许此重定向或跳转次数过多');
        }
        const next = assertPublicUrl(new URL(location, url), allowedDomains);
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw new PublicNetworkError('不允许从 HTTPS 降级到 HTTP');
        if (next.origin !== url.origin) {
          // Do not forward API keys/cookies or other private headers to a redirect target.
          headers = new Headers([...headers].filter(([name]) => ['accept', 'accept-language', 'user-agent'].includes(name)));
        }
        const cookies = await cookieJar.getCookieString(next.toString());
        if (cookies) headers.set('cookie', cookies);
        url = next;
        continue;
      }
      if (!readBody) {
        await response.body?.cancel();
        const result = new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
        Object.defineProperty(result, 'url', { value: url.toString() });
        return result;
      }
      const declared = Number(response.headers.get('content-length'));
      if (declared > maxBytes) {
        await response.body?.cancel();
        throw new PublicNetworkError('响应内容超过大小限制');
      }
      if (streamBody && response.body) {
        // SSE must become readable before EOF. Ownership lasts until cancel, EOF, error or timeout.
        const reader = response.body.getReader();
        let closed = false;
        let total = 0;
        let onAbort: () => void;
        const cleanup = async () => {
          if (closed) return;
          closed = true;
          signal.removeEventListener('abort', onAbort);
          await reader.cancel().catch(() => {});
          await dispatcher.destroy();
        };
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            onAbort = () => { if (!closed) { controller.error(signal.reason); void cleanup(); } };
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          },
          async pull(controller) {
            try {
              const { value, done } = await reader.read();
              if (closed) return;
              if (done) { controller.close(); await cleanup(); return; }
              total += value.byteLength;
              if (total > maxBytes) throw new PublicNetworkError('响应内容超过大小限制');
              controller.enqueue(value);
            } catch (error) { if (!closed) controller.error(error); await cleanup(); }
          },
          cancel: cleanup,
        });
        const headers = new Headers(response.headers);
        headers.delete('content-encoding');
        headers.delete('content-length');
        const result = new Response(body, { status: response.status, statusText: response.statusText, headers });
        Object.defineProperty(result, 'url', { value: url.toString() });
        streamOwnsDispatcher = true;
        return result;
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        if (reader) while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) throw new PublicNetworkError('响应内容超过大小限制');
          chunks.push(value);
        }
      } finally { await reader?.cancel().catch(() => {}); }
      const responseHeaders = new Headers(response.headers);
      // fetch has decompressed the body; callers (including browser routes) must not decode it twice.
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');
      const result = new Response(response.body === null ? null : Buffer.concat(chunks), {
        status: response.status, statusText: response.statusText, headers: responseHeaders,
      });
      Object.defineProperty(result, 'url', { value: url.toString() });
      return result;
    }
    throw new PublicNetworkError('网页跳转次数过多');
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause instanceof Error; depth++) {
      if (cause instanceof PublicNetworkError) throw cause;
      cause = cause.cause;
    }
    throw error;
  } finally { if (!streamOwnsDispatcher) await dispatcher.destroy(); }
}
