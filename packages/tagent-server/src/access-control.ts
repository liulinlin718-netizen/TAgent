import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Context, type Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { limitRequestBody } from './request-body.js';
import { createRequestLimiter, isTaskSubmission, requestLane, resolveRequestLimits, type RequestLimits } from './request-rate.js';

interface AccessConfig {
  token?: string;
  origins: string[];
  hosts: string[];
  secure: boolean;
  sessionTtlMs: number;
  requestLimits: RequestLimits;
}

const loopback = (hostname: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
const digest = (value: string) => createHash('sha256').update(value).digest();

export function resolveAccessConfig(env: Record<string, string | undefined>, host: string, port: number): AccessConfig {
  const token = env.TAGENT_ACCESS_TOKEN || undefined;
  if (token && (token.length < 32 || token.length > 512 || /\s/.test(token))) {
    throw new Error('TAGENT_ACCESS_TOKEN must contain 32-512 non-whitespace characters; use a random secret, not a model API key.');
  }
  const publicOrigin = env.TAGENT_PUBLIC_ORIGIN?.trim();
  const values = env.TAGENT_WEB_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean)
    || (publicOrigin ? [publicOrigin] : ['http://localhost:3000', 'http://127.0.0.1:3000']);
  const origins = [...new Set(values.map(value => {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || !['https:', 'http:'].includes(url.protocol)
      || (url.protocol !== 'https:' && !loopback(url.hostname))) throw new Error('TAGENT_WEB_ORIGINS must contain exact HTTPS origins (HTTP is allowed only on loopback).');
    return url.origin;
  }))];
  if (!origins.length) throw new Error('At least one explicit web origin is required.');
  const remote = !loopback(host) || env.NODE_ENV === 'production' || origins.some(value => !loopback(new URL(value).hostname));
  if (remote && (!token || !publicOrigin)) throw new Error('Public/production serving requires TAGENT_ACCESS_TOKEN and TAGENT_PUBLIC_ORIGIN.');
  if (publicOrigin && (!origins.includes(publicOrigin) || new URL(publicOrigin).protocol !== 'https:')) {
    throw new Error('TAGENT_PUBLIC_ORIGIN must be an HTTPS origin included in TAGENT_WEB_ORIGINS.');
  }
  return { token, origins, secure: !!publicOrigin,
    hosts: [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...(publicOrigin ? [new URL(publicOrigin).host] : [])],
    sessionTtlMs: 8 * 60 * 60 * 1000, requestLimits: resolveRequestLimits(env) };
}

/** Single-owner instance protection. Workspace membership and tenant isolation are separate release gates. */
export function installAccessControl(app: Hono, config: AccessConfig, now = Date.now) {
  const sessions = new Map<string, number>();
  const tokenHash = config.token ? digest(config.token) : undefined;
  const cookieName = config.secure ? '__Host-tagent_session' : 'tagent_session';
  const cookieOptions = { httpOnly: true, secure: config.secure, sameSite: 'Strict' as const, path: '/' };
  const takeRequest = createRequestLimiter(config.requestLimits, now);
  const cookieId = (c: Context) => getCookie(c, cookieName) || '';
  const isToken = (value: string) => !!tokenHash && timingSafeEqual(tokenHash, digest(value));
  const validSession = (c: Context) => {
    const id = cookieId(c);
    if (!/^[a-f0-9]{64}$/.test(id)) return false;
    const key = digest(id).toString('hex');
    const expires = sessions.get(key);
    if (!expires || expires <= now()) { sessions.delete(key); return false; }
    return true;
  };
  const bearer = (c: Context) => {
    const header = c.req.header('authorization');
    return header?.startsWith('Bearer ') && isToken(header.slice(7));
  };
  const isAuthorized = (c: Context) => !config.token || bearer(c) || validSession(c);

  // CORS applies only to HTTP APIs: mutating upgrade response headers breaks WebSocket adapters.
  app.use('/api/*', cors({ origin: config.origins, credentials: true,
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Tagent-Request'], exposeHeaders: ['Retry-After'] }));
  app.use('*', async (c, next) => {
    // The WS adapter builds a synthetic request URL; validate the original Host header, never forwarded headers.
    const requestHost = c.req.header('host') || new URL(c.req.url).host;
    if (!config.hosts.includes(requestHost)) return c.json({ error: '站点地址不在允许范围内', code: 'HOST_DENIED' }, 403);
    const origin = c.req.header('origin');
    if (origin && !config.origins.includes(origin)) return c.json({ error: '请求来源不在允许范围内', code: 'ORIGIN_DENIED' }, 403);
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    // A custom header forces a browser preflight; JSON requests from local CLI tools remain supported.
    if (unsafe && c.req.header('x-tagent-request') !== '1' && !/^application\/json(?:;|$)/i.test(c.req.header('content-type') || '') && !bearer(c)) {
      return c.json({ error: '拒绝未经确认的跨站表单请求', code: 'CSRF_DENIED' }, 403);
    }
    if (unsafe && config.token && validSession(c) && !origin && !bearer(c) && c.req.header('x-tagent-request') !== '1') {
      return c.json({ error: '会话请求缺少来源验证', code: 'CSRF_DENIED' }, 403);
    }
    const publicRoute = (c.req.method === 'GET' && ['/api/health', '/api/auth/session'].includes(c.req.path))
      || (c.req.method === 'POST' && c.req.path === '/api/auth/login');
    if (c.req.path !== '/ws') c.header('Cache-Control', 'no-store');
    const authorized = !!isAuthorized(c);
    const lane = requestLane(c.req.method, c.req.path, authorized);
    const retryAfter = takeRequest(lane);
    if (retryAfter) {
      c.header('Retry-After', String(retryAfter));
      if (c.req.raw.body) c.header('Connection', 'close');
      return c.json({ error: `${lane === 'login' ? '登录尝试' : '此类请求'}过于频繁，请 ${retryAfter} 秒后手动重试。`,
        code: lane === 'login' ? 'LOGIN_RATE_LIMITED' : 'REQUEST_RATE_LIMITED', retryAfterSeconds: retryAfter,
        ...(isTaskSubmission(c.req.path) ? { accepted: false } : {}) }, 429);
    }
    if (!publicRoute && !authorized) return c.json({ error: '请先登录工作区', code: 'AUTH_REQUIRED' }, 401);
    await next();
  });
  app.use('/api/*', limitRequestBody);

  app.get('/api/auth/session', c => c.json({ required: !!config.token, authenticated: !!isAuthorized(c) }));
  app.post('/api/auth/login', async c => {
    if (!config.token) return c.json({ required: false, authenticated: true });
    let body: { token?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: '登录请求格式不正确' }, 400); }
    if (!body || typeof body.token !== 'string' || body.token.length > 512 || !isToken(body.token)) {
      return c.json({ error: '访问码不正确', code: 'INVALID_ACCESS_CODE' }, 401);
    }
    for (const [key, expiry] of sessions) if (expiry <= now()) sessions.delete(key);
    if (sessions.size >= 100) return c.json({ error: '活跃登录过多，请先退出其他设备', code: 'SESSION_LIMIT' }, 429);
    const previous = cookieId(c);
    if (previous) sessions.delete(digest(previous).toString('hex'));
    const id = randomBytes(32).toString('hex');
    sessions.set(digest(id).toString('hex'), now() + config.sessionTtlMs);
    setCookie(c, cookieName, id, { ...cookieOptions, maxAge: config.sessionTtlMs / 1000 });
    return c.json({ authenticated: true, required: true });
  });
  app.post('/api/auth/logout', c => {
    sessions.delete(digest(cookieId(c)).toString('hex'));
    deleteCookie(c, cookieName, cookieOptions);
    return c.json({ ok: true });
  });
  return { isAuthorized, required: !!config.token };
}
