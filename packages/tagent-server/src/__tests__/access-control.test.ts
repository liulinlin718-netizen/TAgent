import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { installAccessControl, resolveAccessConfig } from '../access-control.js';

const token = 'test-only-random-access-key-with-over-32-characters';
const base = 'http://127.0.0.1:3001';
const origin = 'http://localhost:3000';
function setup(protectedMode = true) {
  const app = new Hono();
  let tick = 0;
  const config = resolveAccessConfig(protectedMode ? { TAGENT_ACCESS_TOKEN: token } : {}, '127.0.0.1', 3001);
  config.sessionTtlMs = 1000;
  const access = installAccessControl(app, config, () => tick);
  const action = vi.fn(() => ({ ok: true }));
  app.all('/api/private', c => c.json(action()));
  app.get('/api/health', c => c.json({ status: 'ok' }));
  app.get('/ws', c => c.json({ valid: access.isAuthorized(c) }));
  const request = (path: string, init: RequestInit = {}) => app.request(base + path, init);
  const login = (value = token) => request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token: value }) });
  return { app, action, request, login, advance: (ms: number) => { tick += ms; } };
}

describe('instance access configuration', () => {
  it.each(['0.0.0.0', '::', '192.168.1.8'])('refuses unprotected external binding %s', host => {
    expect(() => resolveAccessConfig({}, host, 3001)).toThrow('requires');
  });
  it('requires credentials and an explicit HTTPS origin for production/reverse-proxy deployment', () => {
    expect(() => resolveAccessConfig({ NODE_ENV: 'production' }, '127.0.0.1', 3001)).toThrow();
    expect(() => resolveAccessConfig({ TAGENT_ACCESS_TOKEN: 'weak' }, '127.0.0.1', 3001)).toThrow();
    expect(() => resolveAccessConfig({ TAGENT_ACCESS_TOKEN: token, TAGENT_PUBLIC_ORIGIN: 'http://example.com' }, '0.0.0.0', 3001)).toThrow();
    const config = resolveAccessConfig({ TAGENT_ACCESS_TOKEN: token, TAGENT_PUBLIC_ORIGIN: 'https://office.example.com' }, '0.0.0.0', 3001);
    expect(config).toMatchObject({ secure: true, origins: ['https://office.example.com'] });
    expect(config.hosts).toContain('office.example.com');
  });
  it.each(['https://example.com.attacker.test/path', 'null', '*', 'http://evil.test', 'https://user:pass@example.com'])('rejects unsafe origin configuration %s', value => {
    expect(() => resolveAccessConfig({ TAGENT_WEB_ORIGINS: value }, '127.0.0.1', 3001)).toThrow();
  });
});

describe('HTTP and WebSocket access boundary', () => {
  it('blocks every private route before any action; leaves only status/login public', async () => {
    const { request, action } = setup();
    for (const path of ['/api/private', '/ws']) expect((await request(path)).status).toBe(401);
    expect((await request('/api/private', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect(action).not.toHaveBeenCalled();
    expect(await (await request('/api/auth/session')).json()).toEqual({ required: true, authenticated: false });
    expect((await request('/api/health')).status).toBe(200);
  });
  it('mints HttpOnly session cookies, permits authenticated access, and revokes old cookies on logout', async () => {
    const { request, login, action } = setup();
    const response = await login();
    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain(token);
    const cookie = setCookie.split(';')[0];
    expect((await request('/api/private', { headers: { Cookie: cookie, Origin: origin } })).status).toBe(200);
    expect((await request('/ws', { headers: { Cookie: cookie, Origin: origin } })).status).toBe(200);
    expect((await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-Tagent-Request': '1' } })).status).toBe(200);
    expect((await request('/api/private', { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await request('/ws', { headers: { Cookie: cookie } })).status).toBe(401);
    expect(action).toHaveBeenCalledTimes(1);
  });
  it('expires sessions and does not trust token query parameters', async () => {
    const { request, login, advance } = setup();
    const cookie = (await login()).headers.get('set-cookie')!.split(';')[0];
    advance(1001);
    expect((await request('/api/private', { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await request('/ws?token=' + token)).status).toBe(401);
  });
  it('issues host-only secure cookies for HTTPS deployments', async () => {
    const app = new Hono();
    installAccessControl(app, resolveAccessConfig({ TAGENT_ACCESS_TOKEN: token, TAGENT_PUBLIC_ORIGIN: 'https://office.example.com' }, '127.0.0.1', 3001));
    const response = await app.request('https://office.example.com/api/auth/login', { method: 'POST',
      headers: { Origin: 'https://office.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-tagent_session=/);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain=');
  });
  it('checks the original WS Host rather than trusting an adapter URL or forwarded host', async () => {
    const { app } = setup();
    expect((await app.request('http://127.0.0.1:3001/ws', { headers: {
      Host: 'evil.example', 'X-Forwarded-Host': '127.0.0.1:3001', Authorization: `Bearer ${token}`,
    } })).status).toBe(403);
  });
  it('rejects evil origins, form posts and DNS-rebinding hosts even with valid credentials', async () => {
    const { app, request, login, action } = setup();
    const cookie = (await login()).headers.get('set-cookie')!.split(';')[0];
    for (const path of ['/api/private', '/ws']) {
      expect((await request(path, { headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status).toBe(403);
    }
    expect((await request('/api/private', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(403);
    expect((await request('/api/private', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await app.request('http://attacker.test:3001/api/private', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);
    expect(action).not.toHaveBeenCalled();
  });
  it('allows explicit bearer API use, without forwarding or exposing credentials', async () => {
    const { request } = setup();
    const response = await request('/api/private', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(token);
  });
  it('allows known credentialed CORS and applies a bounded request body', async () => {
    const { request } = setup();
    const response = await request('/api/private', { headers: { Origin: origin } });
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    const large = await request('/api/private', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'a'.repeat(2 * 1024 * 1024 + 1) });
    expect(large.status).toBe(413);
  });
  it('limits repeated login attempts without trusting forwarded IP headers', async () => {
    const { request, login, advance } = setup();
    for (let index = 0; index < 10; index++) expect((await login('wrong')).status).toBe(401);
    const blocked = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': 'different' }, body: JSON.stringify({ token }) });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
    advance(60_000);
    expect((await login()).status).toBe(200);
  });
  it('keeps local development usable while rejecting hostile browser origins', async () => {
    const { request } = setup(false);
    expect((await request('/api/private')).status).toBe(200);
    expect((await request('/api/private', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect(await (await request('/api/auth/session')).json()).toEqual({ required: false, authenticated: true });
  });
});
