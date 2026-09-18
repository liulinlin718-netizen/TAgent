const defaultBase = () => {
  if (process.env.NODE_ENV === 'production') return '';
  if (typeof window !== 'undefined' && window.location.hostname === '127.0.0.1') return 'http://127.0.0.1:3001';
  return 'http://localhost:3001';
};

export const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? defaultBase()).replace(/\/$/, '');
export const AUTH_REQUIRED_EVENT = 'tagent:auth-required';

/** Only TAgent requests carry its session cookie. External discovery requests must use native fetch. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const origin = typeof window === 'undefined' ? 'http://localhost:3000' : window.location.origin;
  const base = new URL(API_BASE || '/', origin);
  const target = new URL(input, origin);
  if (target.origin !== base.origin || !target.pathname.startsWith('/api/')) throw new Error('拒绝向外部站点发送工作区凭据');
  const headers = new Headers(init.headers);
  if (!['GET', 'HEAD'].includes((init.method || 'GET').toUpperCase())) headers.set('X-Tagent-Request', '1');
  const response = await globalThis.fetch(target, { ...init, headers, credentials: 'include', cache: 'no-store', redirect: 'error' });
  if (response.status === 401 && !target.pathname.startsWith('/api/auth/') && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  }
  return response;
}
