import { createHash } from 'node:crypto';
import { publicFetch } from '@tagent/core';

type CacheState = 'network' | 'memory' | 'revalidated';
export interface GitHubResponse<T = unknown> { data: T; status: number; cache: CacheState; fetchedAt: number }
type Entry = GitHubResponse & { expiresAt: number; etag?: string; bytes: number; cacheControl?: string };
type Pending = { controller: AbortController; promise: Promise<GitHubResponse>; waiters: number; settled: boolean };
type Resource = 'core' | 'search' | 'code_search';
export type GitHubFailure = 'rate_limit' | 'authentication' | 'permission' | 'not_found' | 'invalid_response' | 'network' | 'busy';

export class GitHubRequestError extends Error {
  constructor(message: string, readonly code: GitHubFailure, readonly status?: number, readonly retryAt?: number) { super(message); }
}

const credential = () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const resourceFor = (url: URL): Resource => url.pathname === '/search/code' ? 'code_search' : url.pathname.startsWith('/search/') ? 'search' : 'core';
const ttlFor = (url: URL, status: number) => status !== 200 ? 5000
  : /\/(?:git\/(?:trees|blobs)|commits)\/[a-f0-9]{40}$/.test(url.pathname) ? 600000 : 30000;
const abortError = () => new DOMException('GitHub request cancelled', 'AbortError');

/** One bounded, credential-isolated read queue for discovery and imports. No background retries or disk cache. */
export class GitHubClient {
  private cache = new Map<string, Entry>();
  private pending = new Map<string, Pending>();
  private blocked = new Map<string, number>();
  private tail: Promise<unknown> = Promise.resolve();
  private bytes = 0;
  constructor(private request: typeof publicFetch = publicFetch, private now = () => Date.now()) {}

  clear() { this.cache.clear(); this.blocked.clear(); this.bytes = 0; }

  async get<T = unknown>(route: string, options: { signal?: AbortSignal; allowMissing?: boolean } = {}): Promise<GitHubResponse<T>> {
    let url: URL;
    try { url = new URL(route, 'https://api.github.com'); }
    catch { throw new GitHubRequestError('GitHub 请求地址无效。', 'permission'); }
    if (url.origin !== 'https://api.github.com' || url.username || url.password || !route.startsWith('/') || route.startsWith('//')) throw new GitHubRequestError('GitHub 请求地址无效。', 'permission');
    if (options.signal?.aborted) throw abortError();
    const token = credential();
    const identity = createHash('sha256').update(token).digest('hex');
    const key = `${identity}:${url.href}`;
    const previous = this.cache.get(key);
    let result: GitHubResponse;
    if (previous && previous.expiresAt > this.now()) {
      this.cache.delete(key); this.cache.set(key, previous);
      result = { ...previous, cache: 'memory' };
    } else {
      this.checkLimit(identity, resourceFor(url));
      let active = this.pending.get(key);
      if (active?.controller.signal.aborted) { this.pending.delete(key); active = undefined; }
      if (!active) {
        if (this.pending.size >= 24) throw new GitHubRequestError('GitHub 请求队列已满，请稍后再试。', 'busy');
        const controller = new AbortController();
        const item: Pending = { controller, waiters: 0, settled: false, promise: Promise.resolve(undefined as never) };
        // Serial reads avoid GitHub secondary limits; identical reads share one queue entry.
        item.promise = this.tail.then(async () => {
          if (controller.signal.aborted) throw abortError();
          this.checkLimit(identity, resourceFor(url));
          return this.read(url, token, identity, key, previous, controller.signal);
        }).finally(() => { item.settled = true; if (this.pending.get(key) === item) this.pending.delete(key); });
        this.tail = item.promise.catch(() => undefined);
        this.pending.set(key, item);
        active = item;
      }
      result = await this.subscribe(active, options.signal);
    }
    if (result.status !== 200 && !options.allowMissing) throw new GitHubRequestError(`GitHub 内容不存在或不可访问（HTTP ${result.status}）。`, 'not_found', result.status);
    return { data: structuredClone(result.data) as T, status: result.status, cache: result.cache, fetchedAt: result.fetchedAt };
  }

  private subscribe(active: Pending, signal?: AbortSignal): Promise<GitHubResponse> {
    active.waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: GitHubResponse) => {
        if (settled) return;
        settled = true; signal?.removeEventListener('abort', cancelled); active.waiters--;
        if (!active.waiters && !active.settled) active.controller.abort();
        if (error) reject(error); else resolve(value!);
      };
      const cancelled = () => finish(abortError());
      signal?.addEventListener('abort', cancelled, { once: true });
      active.promise.then(value => finish(undefined, value), error => finish(error));
      if (signal?.aborted) cancelled();
    });
  }

  private checkLimit(identity: string, resource: Resource) {
    const retryAt = Math.max(this.blocked.get(`${identity}:${resource}`) || 0, this.blocked.get(`${identity}:secondary`) || 0);
    if (retryAt > this.now()) throw new GitHubRequestError(`GitHub 已限流，约 ${Math.ceil((retryAt - this.now()) / 1000)} 秒后可重试。`, 'rate_limit', 429, retryAt);
    for (const [key, value] of this.blocked) if (value <= this.now()) this.blocked.delete(key);
  }

  private rememberLimit(response: Response, identity: string, resource: Resource, secondary: boolean) {
    const retry = response.headers.get('retry-after');
    const reset = response.headers.get('x-ratelimit-reset');
    const validTime = (value: number) => Number.isFinite(value) && value <= 8640000000000000 ? value : 0;
    const retryAt = retry && /^\d+$/.test(retry) ? this.now() + Number(retry) * 1000 : retry ? Date.parse(retry) : NaN;
    const resetAt = response.headers.get('x-ratelimit-remaining') === '0' && reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : NaN;
    const at = Math.max(validTime(retryAt), validTime(resetAt), this.now() + 1000);
    const until = at > this.now() + 1000 ? at : this.now() + 60000;
    const key = `${identity}:${secondary ? 'secondary' : resource}`;
    this.blocked.set(key, Math.max(until, this.blocked.get(key) || 0));
    const declaredResource = response.headers.get('x-ratelimit-resource');
    if (!secondary && ['core', 'search', 'code_search'].includes(declaredResource || '')) {
      const declaredKey = `${identity}:${declaredResource}`;
      this.blocked.set(declaredKey, Math.max(until, this.blocked.get(declaredKey) || 0));
    }
    while (this.blocked.size > 64) this.blocked.delete(this.blocked.keys().next().value!);
    return until;
  }

  private async read(initial: URL, token: string, identity: string, key: string, previous: Entry | undefined, callerSignal: AbortSignal): Promise<GitHubResponse> {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(15000)]);
    let url = initial;
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'TAgent Discovery Import/0.3', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (previous?.etag) headers['If-None-Match'] = previous.etag;
    for (let hop = 0; hop <= 3; hop++) {
      let response: Response;
      try { response = await this.request(url.toString(), { signal, headers, maxBytes: 3000000, redirect: 'manual' }); }
      catch {
        if (callerSignal.aborted) throw abortError();
        throw new GitHubRequestError(signal.aborted ? 'GitHub 请求超时，请稍后重试。' : 'GitHub 网络连接失败，请检查网络或代理。', 'network');
      }
      if (callerSignal.aborted) throw abortError();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        let next: URL | undefined;
        try { next = location ? new URL(location, url) : undefined; } catch { /* Rejected below without forwarding credentials. */ }
        if (!next || next.origin !== initial.origin || next.username || next.password || hop === 3) throw new GitHubRequestError('GitHub 跳转地址无效或跨站，未转发认证信息。', 'permission');
        url = next; continue;
      }
      const resource = resourceFor(initial);
      const limited = response.headers.get('x-ratelimit-remaining') === '0';
      if (response.status === 304) {
        if (!previous || previous.status !== 200) throw new GitHubRequestError('GitHub 返回了无对应缓存的304响应。', 'invalid_response');
        if (limited) this.rememberLimit(response, identity, resource, false);
        const cacheControl = response.headers.get('cache-control') ?? previous.cacheControl;
        const etag = response.headers.get('etag');
        const entry = { ...previous, cacheControl, etag: etag && etag.length <= 1024 ? etag : previous.etag,
          fetchedAt: this.now(), expiresAt: this.expiration(initial, response, cacheControl), cache: 'revalidated' as const };
        this.storeResponse(key, entry, response); return entry;
      }
      if (response.status === 403 || response.status === 429) {
        const body = await response.json().catch(() => ({})) as { message?: unknown };
        const secondary = Boolean(response.headers.get('retry-after')) || /secondary rate limit|abuse detection/i.test(typeof body.message === 'string' ? body.message : '')
          || (!limited && (response.status === 429 || /rate limit exceeded/i.test(typeof body.message === 'string' ? body.message : '')));
        if (limited || secondary) {
          const at = this.rememberLimit(response, identity, resource, secondary);
          throw new GitHubRequestError(`GitHub 已限流，约 ${Math.ceil((at - this.now()) / 1000)} 秒后可重试。`, 'rate_limit', response.status, at);
        }
        throw new GitHubRequestError('GitHub 拒绝访问，请检查仓库权限或 GITHUB_TOKEN。', 'permission', 403);
      }
      if (limited) this.rememberLimit(response, identity, resource, false);
      if (response.status === 401) throw new GitHubRequestError('GitHub 认证失败，请检查 GITHUB_TOKEN 是否有效。', 'authentication', 401);
      if (![200, 404, 422].includes(response.status)) throw new GitHubRequestError(`GitHub 读取失败（HTTP ${response.status}）。`, 'network', response.status);
      const data = response.status === 200 ? await response.json().catch(() => { throw new GitHubRequestError('GitHub 返回内容不是有效 JSON。', 'invalid_response'); }) : null;
      if (signal.aborted) throw abortError();
      const etag = response.headers.get('etag');
      const entry: Entry = { data, status: response.status, cache: 'network', fetchedAt: this.now(), expiresAt: this.expiration(initial, response),
        etag: etag && etag.length <= 1024 ? etag : undefined, bytes: Buffer.byteLength(JSON.stringify(data)), cacheControl: response.headers.get('cache-control') ?? undefined };
      this.storeResponse(key, entry, response);
      return entry;
    }
    throw new GitHubRequestError('GitHub 跳转次数过多。', 'network');
  }

  private expiration(url: URL, response: Response, control = response.headers.get('cache-control') || '') {
    const maxAge = /\bmax-age=(\d+)/i.exec(control);
    const age = Number(response.headers.get('age') || 0);
    const freshness = maxAge ? Math.max(0, Number(maxAge[1]) - (Number.isFinite(age) && age > 0 ? age : 0)) * 1000 : Infinity;
    return this.now() + (/\bno-cache\b/i.test(control) ? 0 : Math.min(ttlFor(url, response.status === 304 ? 200 : response.status), freshness));
  }

  private storeResponse(key: string, entry: Entry, response: Response) {
    if (/\bno-store\b/i.test(response.headers.get('cache-control') || '')) {
      const previous = this.cache.get(key);
      if (previous) { this.bytes -= previous.bytes; this.cache.delete(key); }
    } else this.put(key, entry);
  }

  private put(key: string, value: Entry) {
    const old = this.cache.get(key);
    if (old) this.bytes -= old.bytes;
    this.cache.delete(key);
    if (value.bytes > 3000000) return;
    this.cache.set(key, value); this.bytes += value.bytes;
    while (this.cache.size > 64 || this.bytes > 8000000) {
      const first = this.cache.keys().next().value!;
      this.bytes -= this.cache.get(first)!.bytes; this.cache.delete(first);
    }
  }
}

export const githubClient = new GitHubClient();
