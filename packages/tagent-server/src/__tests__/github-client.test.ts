import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../github-client.js';

const route = '/repos/fixture/skills/commits/main';
const fixed = `/repos/fixture/skills/git/trees/${'a'.repeat(40)}`;
const json = (data: unknown = { sha: 'fixture' }, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', ...headers } });
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => { vi.stubEnv('GITHUB_TOKEN', ''); vi.stubEnv('GH_TOKEN', ''); });
afterEach(() => vi.unstubAllEnvs());

describe('shared GitHub read cache', () => {
  it('returns isolated copies and preserves the original fetch date on a memory hit', async () => {
    let now = 1000;
    const request = vi.fn(async () => json({ files: ['SKILL.md'] }));
    const client = new GitHubClient(request, () => now);
    const first = await client.get<{ files: string[] }>(route);
    first.data.files.push('not-real');
    now += 1000;
    expect(await client.get(route)).toMatchObject({ data: { files: ['SKILL.md'] }, cache: 'memory', fetchedAt: 1000 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('revalidates mutable refs with ETag and adopts the new validator', async () => {
    let now = 0;
    const request = vi.fn(async (_url: string | URL, _options?: RequestInit) => json());
    request.mockResolvedValueOnce(json({ sha: 'old' }, { etag: '"v1"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"v2"' } }))
      .mockResolvedValueOnce(json({ sha: 'new' }));
    const client = new GitHubClient(request, () => now);
    await client.get(route);
    now = 30001;
    expect(await client.get(route)).toMatchObject({ cache: 'revalidated', fetchedAt: now, data: { sha: 'old' } });
    expect(new Headers(request.mock.calls[1][1]?.headers).get('if-none-match')).toBe('"v1"');
    now += 30001;
    expect((await client.get(route)).data).toEqual({ sha: 'new' });
    expect(new Headers(request.mock.calls[2][1]?.headers).get('if-none-match')).toBe('"v2"');
  });

  it('keeps fixed commit trees longer, with a bounded lifetime', async () => {
    let now = 0;
    const request = vi.fn(async () => json());
    const client = new GitHubClient(request, () => now);
    await client.get(fixed);
    now = 599999;
    expect((await client.get(fixed)).cache).toBe('memory');
    now = 600001;
    expect((await client.get(fixed)).cache).toBe('network');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('isolates credentials and reads token changes at request time', async () => {
    const request = vi.fn(async (_url: string | URL, options?: RequestInit) => json({ auth: new Headers(options?.headers).get('authorization') }));
    const client = new GitHubClient(request);
    expect((await client.get(route)).data).toEqual({ auth: null });
    vi.stubEnv('GITHUB_TOKEN', 'fixture-token');
    expect((await client.get(route)).data).toEqual({ auth: 'Bearer fixture-token' });
    vi.stubEnv('GITHUB_TOKEN', '');
    expect((await client.get(route)).data).toEqual({ auth: null });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(['no-store', 'no-cache', 'max-age=0'])('honors %s', async control => {
    const request = vi.fn(async () => json({}, { 'cache-control': control }));
    const client = new GitHubClient(request);
    await client.get(route);
    expect((await client.get(route)).cache).toBe('network');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('preserves no-cache across 304 and does not ignore upstream Age', async () => {
    const request = vi.fn(async () => new Response(null, { status: 304 }));
    request.mockResolvedValueOnce(json({}, { etag: '"v1"', 'cache-control': 'no-cache' }));
    const client = new GitHubClient(request);
    await client.get(route); await client.get(route); await client.get(route);
    expect(request).toHaveBeenCalledTimes(3);
    const aged = vi.fn(async () => json({}, { 'cache-control': 'max-age=60', age: '60' }));
    const agedClient = new GitHubClient(aged);
    await agedClient.get(route); await agedClient.get(route);
    expect(aged).toHaveBeenCalledTimes(2);
  });

  it('does not return stale content after a network failure', async () => {
    let now = 0;
    const request = vi.fn(async () => json());
    const client = new GitHubClient(request, () => now);
    await client.get(route);
    now = 31000;
    request.mockRejectedValueOnce(new Error('private diagnostic'));
    await expect(client.get(route)).rejects.toMatchObject({ code: 'network' });
    expect((await client.get(route)).cache).toBe('network');
  });

  it('briefly caches missing refs without turning them into successful imports', async () => {
    let now = 0;
    const request = vi.fn(async () => new Response(null, { status: 404 }));
    const client = new GitHubClient(request, () => now);
    expect(await client.get(route, { allowMissing: true })).toMatchObject({ status: 404, data: null });
    await expect(client.get(route)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(request).toHaveBeenCalledTimes(1);
    now = 5001;
    await client.get(route, { allowMissing: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('evicts by entry count and bytes', async () => {
    const request = vi.fn(async () => json());
    const client = new GitHubClient(request);
    for (let i = 0; i < 65; i++) await client.get(`${route}?i=${i}`);
    await client.get(`${route}?i=0`);
    expect(request).toHaveBeenCalledTimes(66);
    const large = vi.fn(async () => json({ body: 'x'.repeat(2800000) }));
    const bounded = new GitHubClient(large);
    for (let i = 0; i < 3; i++) await bounded.get(`${route}?i=${i}`);
    await bounded.get(`${route}?i=0`);
    expect(large).toHaveBeenCalledTimes(4);
  });
});

describe('GitHub rate limits and read queue', () => {
  it('pauses the limited resource until reset but allows a different resource', async () => {
    let now = 100000;
    const request = vi.fn(async () => json());
    request.mockResolvedValueOnce(new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '200' } }));
    const client = new GitHubClient(request, () => now);
    await expect(client.get(route)).rejects.toMatchObject({ code: 'rate_limit', retryAt: 200000 });
    await expect(client.get(`${route}?other`)).rejects.toMatchObject({ code: 'rate_limit' });
    expect(request).toHaveBeenCalledTimes(1);
    await client.get('/search/repositories?q=skill');
    now = 200001;
    await client.get(route);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('respects limit headers on successful revalidation and the declared resource', async () => {
    let now = 0;
    const request = vi.fn(async () => json());
    request.mockResolvedValueOnce(json({}, { etag: '"v1"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '200', 'x-ratelimit-resource': 'core' } }));
    const client = new GitHubClient(request, () => now);
    await client.get('/search/code?q=skill');
    now = 31000;
    expect((await client.get('/search/code?q=skill')).cache).toBe('revalidated');
    expect((await client.get('/search/code?q=skill')).cache).toBe('memory');
    await expect(client.get(route)).rejects.toMatchObject({ code: 'rate_limit' });
    await expect(client.get('/search/code?q=other')).rejects.toMatchObject({ code: 'rate_limit' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(['90', new Date(190000).toUTCString()])('respects secondary Retry-After %s across resources', async retry => {
    const request = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': retry } }));
    const client = new GitHubClient(request, () => 100000);
    await expect(client.get(route)).rejects.toMatchObject({ code: 'rate_limit', retryAt: 190000 });
    await expect(client.get('/search/repositories?q=skill')).rejects.toMatchObject({ code: 'rate_limit', retryAt: 190000 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses a finite wait for malformed limit headers without echoing provider diagnostics', async () => {
    const request = vi.fn(async () => new Response('{"message":"secret"}', { status: 429, headers: { 'retry-after': '9'.repeat(40) } }));
    const client = new GitHubClient(request, () => 100000);
    await expect(client.get(route)).rejects.toMatchObject({ code: 'rate_limit', retryAt: 160000 });
  });

  it.each([[401, 'authentication'], [403, 'permission']] as const)('distinguishes HTTP %s from a rate limit', async (status, code) => {
    const request = vi.fn(async () => new Response('{"message":"secret"}', { status }));
    const client = new GitHubClient(request);
    await expect(client.get(route)).rejects.toMatchObject({ code });
    await expect(client.get(route)).rejects.not.toHaveProperty('retryAt', expect.any(Number));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('coalesces identical reads and lets one caller cancel without cancelling the other', async () => {
    const response = deferred();
    const request = vi.fn(async () => response.promise);
    const client = new GitHubClient(request);
    const controller = new AbortController();
    const cancelled = client.get(route, { signal: controller.signal });
    const outcome = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const survivor = client.get(route);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    controller.abort();
    await outcome;
    response.resolve(json());
    expect((await survivor).status).toBe(200);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not cache late responses after all subscribers cancel', async () => {
    const response = deferred();
    const request = vi.fn(async () => json()).mockImplementationOnce(async () => response.promise);
    const client = new GitHubClient(request);
    const controller = new AbortController();
    const outcome = expect(client.get(route, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    controller.abort(); await outcome;
    const again = client.get(route);
    response.resolve(json({ obsolete: true }));
    expect(await again).toMatchObject({ data: { sha: 'fixture' }, cache: 'network' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('serializes different reads and rejects excess queued work', async () => {
    const response = deferred();
    const request = vi.fn(async () => json()).mockImplementationOnce(async () => response.promise);
    const client = new GitHubClient(request);
    const work = Array.from({ length: 24 }, (_, i) => client.get(`${route}?i=${i}`));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await expect(client.get(`${route}?excess`)).rejects.toMatchObject({ code: 'busy' });
    response.resolve(json());
    await Promise.all(work);
    expect(request).toHaveBeenCalledTimes(24);
  });

  it('rechecks the rate limit before executing already queued reads', async () => {
    const response = deferred();
    const request = vi.fn(async () => response.promise);
    const client = new GitHubClient(request);
    const first = expect(client.get(route)).rejects.toMatchObject({ code: 'rate_limit' });
    const second = expect(client.get(`${route}?other`)).rejects.toMatchObject({ code: 'rate_limit' });
    response.resolve(new Response('{}', { status: 429 }));
    await first; await second;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('follows API redirects but never forwards credentials to another host', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'fixture-token');
    const request = vi.fn(async () => json());
    request.mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/repositories/123' } }));
    const client = new GitHubClient(request);
    await client.get(route);
    expect(request).toHaveBeenLastCalledWith('https://api.github.com/repositories/123', expect.anything());
    request.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://foreign.example/data' } }));
    await expect(client.get(`${route}?new`)).rejects.toMatchObject({ code: 'permission' });
    expect(request).toHaveBeenCalledTimes(3);
    await expect(client.get('//foreign.example/data')).rejects.toMatchObject({ code: 'permission' });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('rejects malformed payloads and 304 without a cache entry', async () => {
    const request = vi.fn(async () => new Response('not json'));
    const client = new GitHubClient(request);
    await expect(client.get(route)).rejects.toMatchObject({ code: 'invalid_response' });
    request.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await expect(client.get(route)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
