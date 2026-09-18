import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { installAccessControl, resolveAccessConfig } from '../access-control.js';
import { createRequestLimiter, DEFAULT_REQUEST_LIMITS, requestLane, RequestWindow, resolveRequestLimits } from '../request-rate.js';

describe('bounded rolling request windows', () => {
  it('limits the actual preceding minute, not two bursts around a wall-clock boundary', () => {
    let time = 59999;
    const limiter = new RequestWindow(2, () => time);
    expect(limiter.take()).toBe(0); expect(limiter.take()).toBe(0);
    time = 60000; expect(limiter.take()).toBe(60);
    time = 119998; expect(limiter.take()).toBe(1);
    time = 119999; expect(limiter.take()).toBe(0);
  });
  it('does not keep rejected traffic in memory or extend recovery; clock rollback cannot refill', () => {
    let time = 100000;
    const limiter = new RequestWindow(1, () => time);
    expect(limiter.take()).toBe(0);
    time = 90000; expect(limiter.take()).toBe(60);
    time = 159999;
    for (let i = 0; i < 20000; i++) expect(limiter.take()).toBe(1);
    time = 160000; expect(limiter.take()).toBe(0);
  });
  it('keeps external work, reads, controls and login in independent bounded lanes', () => {
    const take = createRequestLimiter({ ...DEFAULT_REQUEST_LIMITS, external: 1 }, () => 0);
    expect(take('external')).toBe(0); expect(take('external')).toBe(60);
    for (const lane of ['read', 'write', 'control', 'login', 'public', 'websocket'] as const) expect(take(lane)).toBe(0);
  });
  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '10001', ' 30', '30x'])('rejects invalid deployment limit %s instead of disabling protection', value => {
    expect(() => resolveRequestLimits({ TAGENT_API_EXTERNAL_PER_MINUTE: value })).toThrow();
  });
  it('uses bounded defaults, permits explicit integer settings, and does not mutate defaults', () => {
    expect(resolveRequestLimits({})).toEqual(DEFAULT_REQUEST_LIMITS);
    expect(resolveRequestLimits({ TAGENT_API_READ_PER_MINUTE: '200', TAGENT_API_WRITE_PER_MINUTE: '1', TAGENT_API_EXTERNAL_PER_MINUTE: '10000' }))
      .toMatchObject({ read: 200, write: 1, external: 10000, control: 120, login: 10 });
    expect(DEFAULT_REQUEST_LIMITS.read).toBe(600);
  });
});

describe('request classification', () => {
  it.each(['/api/agent/run', '/api/agent/orchestrate', '/api/discovery/search', '/api/skills/search', '/api/mcp/search',
    '/api/skills/suggest', '/api/skills/import', '/api/mcp/import/preview', '/api/mcp/a/test', '/api/skills/a/test',
    '/api/research-search/test', '/api/model-connection/test', '/api/agents/a/benchmark/live/start',
    '/api/workspaces/w/sessions/s/fork'])('shares external-work quota for %s', path => {
    expect(requestLane('POST', path, true)).toBe('external');
  });
  it.each(['/api/auth/logout', '/api/runs/a/cancel', '/api/approval/a', '/api/model-connection/a/cancel', '/api/model-connection/a/retry-save',
    '/api/agents/a/benchmark/live/runs/b/cancel', '/api/workspaces/w/sessions/s/summary-forks/f/cancel',
    '/api/workspaces/w/sessions/s/summary-forks/f/retry-save'])('reserves control quota for %s without dropping authentication', path => {
    expect(requestLane('POST', path, true)).toBe('control');
    expect(requestLane('POST', path, false)).toBe('public');
  });
  it('treats network health as work, reads as reads and does not grant control quota to creation/unknown routes', () => {
    expect(requestLane('GET', '/api/discovery/health', true)).toBe('external');
    expect(requestLane('GET', '/api/workspaces', true)).toBe('read');
    expect(requestLane('GET', '/api/health', true)).toBe('public');
    expect(requestLane('GET', '/ws', true)).toBe('websocket');
    expect(requestLane('POST', '/api/mcp/a/approval', true)).toBe('write');
    expect(requestLane('POST', '/api/agents/cancel', true)).toBe('write');
    expect(requestLane('POST', '/api/unknown/cancel', true)).toBe('write');
  });
});

describe('rate limits at the access boundary', () => {
  const token = 'test-only-instance-token-longer-than-thirty-two-characters';
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const origin = 'http://localhost:3000';
  function setup() {
    let time = 0;
    const app = new Hono();
    const config = resolveAccessConfig({ TAGENT_ACCESS_TOKEN: token, TAGENT_API_READ_PER_MINUTE: '2', TAGENT_API_EXTERNAL_PER_MINUTE: '2', TAGENT_API_WRITE_PER_MINUTE: '2' }, '127.0.0.1', 3001);
    config.requestLimits.public = 2;
    installAccessControl(app, config, () => time);
    const work = vi.fn();
    app.all('*', async c => { work(c.req.path); return c.json({ ok: true }); });
    const request = (path: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:3001${path}`, { ...init, headers: { ...headers, ...init.headers } });
    return { app, work, request, advance: (ms: number) => { time += ms; } };
  }
  it('rejects before reading a body or entering handlers, with a readable task-not-accepted contract', async () => {
    const { request, work, advance } = setup();
    await request('/api/skills/search', { method: 'POST', body: '{}' });
    await request('/api/mcp/import/preview', { method: 'POST', body: '{}' });
    const response = await request('/api/agent/orchestrate', { method: 'POST', body: '{invalid', headers: { origin } });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-expose-headers')).toContain('Retry-After');
    expect(await response.json()).toMatchObject({ code: 'REQUEST_RATE_LIMITED', accepted: false, retryAfterSeconds: 60 });
    expect(work).toHaveBeenCalledTimes(2);
    expect((await request('/api/runs/a/cancel', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await request('/api/approval/a', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await request('/api/workspaces')).status).toBe(200);
    advance(60000);
    expect((await request('/api/agent/run', { method: 'POST', body: '{}' })).status).toBe(200);
  });
  it('cannot partition quotas by forged IP, query, cookie or route ids; rejected requests do not consume other lanes', async () => {
    const { request } = setup();
    for (let i = 0; i < 2; i++) expect((await request(`/api/workspaces/${i}`, { headers: { 'X-Forwarded-For': `192.0.2.${i}`, Cookie: `session=${i}` } })).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await request(`/api/agents?q=${i}`, { headers: { Forwarded: `for=192.0.2.${i}` } })).status).toBe(429);
    expect((await request('/api/skills', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await request('/api/discovery/search', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await request('/api/auth/logout', { method: 'POST', body: '{}' })).status).toBe(200);
  });
  it('cannot use unauthenticated traffic to exhaust authenticated API lanes or bypass host/origin protection', async () => {
    const { request, work } = setup();
    for (let i = 0; i < 2; i++) expect((await request('/api/skills', { headers: { authorization: 'Bearer invalid' } })).status).toBe(401);
    expect((await request('/api/workspaces', { headers: { authorization: 'Bearer invalid' } })).status).toBe(429);
    expect(work).not.toHaveBeenCalled();
    expect((await request('/api/workspaces')).status).toBe(200);
    expect((await request('/api/workspaces', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await request('/api/workspaces', { headers: { host: 'evil.example' } })).status).toBe(403);
  });
  it('throttles malformed login requests before the body parser; normal bearer requests and logout remain usable', async () => {
    const { request } = setup();
    for (let i = 0; i < 10; i++) expect((await request('/api/auth/login', { method: 'POST', body: '{' })).status).toBe(400);
    const blocked = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ token }) });
    expect(blocked.status).toBe(429); expect((await blocked.json()).code).toBe('LOGIN_RATE_LIMITED');
    expect((await request('/api/workspaces')).status).toBe(200);
    expect((await request('/api/auth/logout', { method: 'POST', body: '{}' })).status).toBe(200);
  });
});
