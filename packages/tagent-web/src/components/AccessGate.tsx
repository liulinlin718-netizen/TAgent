'use client';

import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, LoaderCircle, LockKeyhole, LogOut, RefreshCw } from 'lucide-react';
import { API_BASE, apiFetch, AUTH_REQUIRED_EVENT } from '../lib/api-client';
import styles from './AccessGate.module.css';
import { ConversationProvider } from './ConversationProvider';

const AccessContext = createContext<{ protected: boolean; logout: () => Promise<void> }>({ protected: false, logout: async () => {} });

export default function AccessGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'login' | 'ready' | 'offline'>('checking');
  const [required, setRequired] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checkVersion, setCheckVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch(`${API_BASE}/api/auth/session`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    }).then(async response => {
      if (!response.ok) throw new Error('Session status unavailable');
      const result = await response.json();
      if (typeof result.required !== 'boolean' || typeof result.authenticated !== 'boolean') throw new Error('Invalid session status');
      if (controller.signal.aborted) return;
      setRequired(result.required);
      setState(result.authenticated ? 'ready' : 'login');
    }).catch(() => { if (!controller.signal.aborted) setState('offline'); });
    const expired = () => {
      controller.abort();
      setRequired(true); setCode(''); setError('登录已过期，请重新输入访问码'); setState('login');
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, expired);
    return () => { controller.abort(); window.removeEventListener(AUTH_REQUIRED_EVENT, expired); };
  }, [checkVersion]);

  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const response = await apiFetch(`${API_BASE}/api/auth/login`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: code }), signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (!response.ok) { setError(result.error || '登录失败，请重试'); return; }
      setCode('');
      // Confirm the cookie was accepted, including cross-origin deployment misconfiguration.
      const session = await apiFetch(`${API_BASE}/api/auth/session`);
      if (!(await session.json()).authenticated) { setError('登录凭据未能保留，请检查站点地址与 Cookie 设置'); return; }
      setRequired(result.required); setState('ready');
    } catch { setError('无法连接服务，请稍后重试'); }
    finally { setBusy(false); }
  }
  async function logout() {
    try {
      const response = await apiFetch(`${API_BASE}/api/auth/logout`, { method: 'POST' });
      if (!response.ok && response.status !== 401) throw new Error('Logout failed');
      setCode(''); setError(''); setState('login');
    } catch { window.alert('退出未成功，请检查网络后重试'); }
  }
  if (state === 'ready') return <AccessContext.Provider value={{ protected: required, logout }}><ConversationProvider>{children}</ConversationProvider></AccessContext.Provider>;
  return <main className={styles.screen}>
    <section className={styles.content} aria-label="工作区访问">
      <div className={styles.brand}><LockKeyhole size={24} aria-hidden /><span>TAgent</span></div>
      {state === 'checking' ? <p role="status" className={styles.status}><LoaderCircle className={styles.spin} size={18} />连接工作区...</p>
        : state === 'offline' ? <><h1>暂时无法连接工作区</h1><p>服务未就绪或当前站点无访问权限。</p>
          <button className={styles.submit} onClick={() => { setState('checking'); setCheckVersion(version => version + 1); }}><RefreshCw size={18} />重新连接</button></>
        : <form onSubmit={login}>
          <h1>登录工作区</h1>
          <label htmlFor="access-code">访问码</label>
          <input id="access-code" type="password" autoComplete="current-password" required maxLength={512}
            value={code} onChange={event => setCode(event.target.value)} disabled={busy} aria-describedby={error ? 'login-error' : undefined} />
          {error && <p id="login-error" role="alert" className={styles.error}>{error}</p>}
          <button className={styles.submit} type="submit" disabled={busy || !code}>
            {busy ? <LoaderCircle className={styles.spin} size={18} /> : <ArrowRight size={18} />}{busy ? '登录中...' : '进入工作区'}
          </button>
        </form>}
    </section>
  </main>;
}

export function AccessControl() {
  const access = useContext(AccessContext);
  const [busy, setBusy] = useState(false);
  if (!access.protected) return null;
  return <button type="button" className={styles.logout} aria-label="退出登录" title="退出登录" disabled={busy}
    onClick={async () => { setBusy(true); try { await access.logout(); } finally { setBusy(false); } }}>
    <LogOut size={18} aria-hidden />
  </button>;
}
