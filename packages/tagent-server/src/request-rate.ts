export type RequestLane = 'login' | 'public' | 'read' | 'write' | 'external' | 'control' | 'websocket';
export type RequestLimits = Record<RequestLane, number>;

export const DEFAULT_REQUEST_LIMITS: Readonly<RequestLimits> = Object.freeze({
  login: 10, public: 120, read: 600, write: 120, external: 30, control: 120, websocket: 30,
});

export function resolveRequestLimits(env: Record<string, string | undefined>): RequestLimits {
  const limits = { ...DEFAULT_REQUEST_LIMITS };
  for (const lane of ['read', 'write', 'external'] as const) {
    const name = `TAGENT_API_${lane.toUpperCase()}_PER_MINUTE`;
    const value = env[name];
    if (value === undefined || value === '') continue;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 10000) {
      throw new Error(`${name} must be an integer between 1 and 10000.`);
    }
    limits[lane] = Number(value);
  }
  return limits;
}

/** A bounded rolling window; rejected requests never extend the recovery deadline. */
export class RequestWindow {
  private admitted: number[] = [];
  private lastTime = -Infinity;
  constructor(private readonly capacity: number, private readonly now = () => performance.now()) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) throw new Error('Invalid request capacity');
  }
  take(): number {
    const time = Math.max(this.lastTime, this.now());
    this.lastTime = time;
    this.admitted = this.admitted.filter(value => value > time - 60000);
    if (this.admitted.length >= this.capacity) return Math.max(1, Math.ceil((this.admitted[0] + 60000 - time) / 1000));
    this.admitted.push(time);
    return 0;
  }
}

const taskPaths = new Set(['/api/agent/run', '/api/agent/orchestrate']);
export const isTaskSubmission = (path: string) => taskPaths.has(path);

export function requestLane(method: string, path: string, authorized: boolean): RequestLane {
  if (method === 'POST' && path === '/api/auth/login') return 'login';
  if (!authorized || ['/api/health', '/api/auth/session'].includes(path)) return 'public';
  if (path === '/ws') return 'websocket';
  if (method === 'POST' && (path === '/api/auth/logout'
    || /^\/api\/(?:runs\/[^/]+\/cancel|approval\/[^/]+|model-connection\/[^/]+\/(?:cancel|retry-save))$/.test(path)
    || /^\/api\/agents\/[^/]+\/benchmark\/live\/runs\/[^/]+\/cancel$/.test(path)
    || /^\/api\/workspaces\/[^/]+\/sessions\/[^/]+\/summary-forks\/[^/]+\/(?:cancel|retry-save)$/.test(path))) return 'control';
  if (path === '/api/discovery/health' || (method === 'POST' && (isTaskSubmission(path)
    || ['/api/discovery/search', '/api/skills/search', '/api/mcp/search', '/api/skills/suggest',
      '/api/research-search/test', '/api/model-connection/test'].includes(path)
    || /^\/api\/(?:skills|mcp)\/import(?:\/preview)?$/.test(path)
    || /^\/api\/(?:skills|mcp)\/[^/]+\/test$/.test(path)
    || /^\/api\/agents\/[^/]+\/benchmark\/live\/start$/.test(path)
    || /^\/api\/workspaces\/[^/]+\/sessions\/[^/]+\/fork$/.test(path)))) return 'external';
  return ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'read' : 'write';
}

export function createRequestLimiter(limits: RequestLimits, now?: () => number) {
  // Instance-owner limits use no caller-controlled path, cookie, token or forwarded-IP keys.
  const windows = Object.fromEntries(Object.entries(limits).map(([lane, size]) => [lane, new RequestWindow(size, now)])) as Record<RequestLane, RequestWindow>;
  return (lane: RequestLane) => windows[lane].take();
}
