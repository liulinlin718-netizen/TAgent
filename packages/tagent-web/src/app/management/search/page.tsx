'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, ExternalLink, FlaskConical, LoaderCircle, LockKeyhole, RefreshCw, Save, Search, ShieldCheck } from 'lucide-react';
import type { ResearchSearchProvider, SearchProbeResult, SearchSettingsView } from '@tagent/core';
import { API_BASE, apiFetch } from '../../../lib/api-client';
import styles from './search.module.css';

const endpoint = `${API_BASE}/api/research-search`;
const probeLabels = { available: '找到相关候选', empty: '未找到相关候选', failed: '搜索测试失败' };
const diagnosticLabels = { ok: '有相关候选', empty: '无相关候选', failed: '请求失败' };

class SettingsRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new SettingsRequestError(typeof body.error === 'string' ? body.error : `请求失败（${response.status}）。`, response.status);
  return body as T;
}

export default function ResearchSearchPage() {
  const [settings, setSettings] = useState<SearchSettingsView | null>(null);
  const [selected, setSelected] = useState<ResearchSearchProvider | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'loading' | 'testing' | 'saving' | null>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const [result, setResult] = useState<SearchProbeResult | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    return apiFetch(`${endpoint}/settings`, { signal }).then(readResponse<SearchSettingsView>).then(view => {
      if (signal?.aborted) return;
      setSettings(view);
      setSelected(view.provider === 'invalid' ? null : view.provider);
      setResult(null);
      setRequiresRefresh(false);
    }).catch(() => {
      if (!signal?.aborted) {
        setError('无法读取搜索配置，请检查后端连接后重试。');
        setRequiresRefresh(true);
      }
    }).finally(() => { if (!signal?.aborted) setBusy(null); });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const option = settings?.options.find(item => item.id === selected);
  const activeName = settings?.options.find(item => item.id === settings.provider)?.name || '配置无效';
  const canAct = !!settings && !!option && confirmed && !busy && !requiresRefresh;

  function choose(provider: ResearchSearchProvider) {
    setSelected(provider);
    setConfirmed(false);
    setResult(null);
    setError('');
    setNotice('');
  }

  async function submit(action: 'testing' | 'saving') {
    if (!canAct || !settings || !selected || (action === 'saving' && settings.locked)) return;
    setBusy(action);
    setError('');
    setNotice('');
    if (action === 'testing') setResult(null);
    try {
      const response = await apiFetch(`${endpoint}/${action === 'saving' ? 'settings' : 'test'}`, {
        method: action === 'saving' ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: selected, confirmed: true, confirmationVersion: settings.confirmationVersion,
          ...(action === 'saving' ? { expectedRevision: settings.revision } : {}) }),
      });
      if (action === 'saving') {
        const view = await readResponse<SearchSettingsView>(response);
        setSettings(view);
        setConfirmed(false);
        setNotice('配置已保存，对之后发起的任务生效；正在运行的任务保持原搜索源。');
      } else {
        setResult(await readResponse<SearchProbeResult>(response));
      }
    } catch (cause) {
      if (cause instanceof SettingsRequestError) {
        setError(cause.message);
        if (cause.status === 409 || cause.status === 400) { setRequiresRefresh(true); setConfirmed(false); }
      } else {
        // A lost response does not prove that a durable save failed.
        setError(action === 'saving' ? '未能确认保存结果，请刷新核对当前配置。不要重复提交。' : '未收到测试结果。搜索配置未改变，后台测试可能仍在进行。');
        if (action === 'saving') { setRequiresRefresh(true); setConfirmed(false); }
      }
    } finally { setBusy(null); }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.title}><Search size={24} aria-hidden="true" /><h1>调研搜索</h1></div>
        <button type="button" className={styles.iconButton} onClick={() => {
          setBusy('loading'); setError(''); setNotice(''); setConfirmed(false); void load();
        }} disabled={!!busy} aria-label="刷新搜索配置" title="刷新搜索配置">
          <RefreshCw size={18} aria-hidden="true" />
        </button>
      </header>

      {error && <div className={styles.error} role="alert"><AlertCircle size={18} aria-hidden="true" /><span>{error}</span></div>}
      {notice && <p className={styles.success} role="status"><CheckCircle2 size={18} aria-hidden="true" />{notice}</p>}
      {busy === 'loading' && <p className={styles.progress} role="status"><LoaderCircle className={styles.spinner} size={18} aria-hidden="true" />正在读取配置...</p>}

      {settings && <>
        <section className={styles.current} aria-label="当前搜索配置">
          <div><span className={styles.caption}>当前启用</span><strong>{activeName}</strong></div>
          <span className={styles.origin}>{settings.origin === 'environment' ? '部署环境指定' : settings.origin === 'saved' ? '已保存的选择' : '默认配置'}</span>
          {settings.updatedAt && settings.origin === 'saved' && <time dateTime={settings.updatedAt}>{new Date(settings.updatedAt).toLocaleString('zh-CN')}</time>}
        </section>
        {settings.locked && <p className={styles.locked}><LockKeyhole size={18} aria-hidden="true" />搜索源由部署环境固定。更改请联系部署管理员。</p>}
        {settings.provider === 'invalid' && <p className={styles.error} role="alert">部署中的搜索源无效，当前不能检索；请检查 TAGENT_SEARCH_PROVIDER。</p>}

        <fieldset className={styles.providers} disabled={settings.locked || !!busy || requiresRefresh}>
          <legend>搜索来源</legend>
          <div className={styles.options}>{settings.options.map(item => (
            <label key={item.id} className={`${styles.option} ${selected === item.id ? styles.selected : ''}`}>
              <input type="radio" name="search-provider" value={item.id} checked={selected === item.id} onChange={() => choose(item.id)} />
              <span><strong>{item.name}</strong><small>{item.id === settings.provider ? '当前启用' : '尚未启用'}</small></span>
            </label>
          ))}</div>
        </fieldset>

        {option && <section className={styles.disclosure} aria-labelledby="disclosure-title">
          <h2 id="disclosure-title"><ShieldCheck size={19} aria-hidden="true" />{option.name} · 外发范围与费用</h2>
          <p>{option.disclosure}</p>
          <details><summary>接收服务（{option.recipients.length}）</summary><ul>{option.recipients.map(recipient => <li key={recipient}><code>{recipient}</code></li>)}</ul></details>
          <p className={styles.cost}>{option.costNotice}</p>
          {option.documentationUrl && <a className={styles.externalLink} href={option.documentationUrl} target="_blank" rel="noopener noreferrer">服务说明<ExternalLink size={14} aria-hidden="true" /></a>}
          <label className={styles.confirm}>
            <input type="checkbox" checked={confirmed} disabled={!!busy || requiresRefresh} onChange={event => setConfirmed(event.target.checked)} />
            <span>我同意按上述范围向 {option.name} 发送检索内容，并了解相关费用与限制。</span>
          </label>
          <div className={styles.actions}>
            <button type="button" className={styles.button} disabled={!canAct} onClick={() => void submit('testing')}>
              {busy === 'testing' ? <LoaderCircle className={styles.spinner} size={17} aria-hidden="true" /> : <FlaskConical size={17} aria-hidden="true" />}
              {busy === 'testing' ? '测试中...' : '测试来源'}
            </button>
            <button type="button" className={`${styles.button} ${styles.primary}`} disabled={!canAct || settings.locked} onClick={() => void submit('saving')}>
              {busy === 'saving' ? <LoaderCircle className={styles.spinner} size={17} aria-hidden="true" /> : <Save size={17} aria-hidden="true" />}
              {busy === 'saving' ? '保存中...' : '确认并启用'}
            </button>
          </div>
          <p className={styles.testScope}>测试仅发送固定公开关键词 <code>{settings.testQuery}</code>，不会保存配置或调用语言模型。</p>
          {busy === 'testing' && <p className={styles.progress} role="status">正在测试 {option.name}，当前启用源尚未改变。网络受限时可能需要等待。</p>}
        </section>}

        {result && <section className={styles.results} aria-labelledby="result-title" aria-live="polite">
          <h2 id="result-title">{settings.options.find(item => item.id === result.provider)?.name} · 测试结果</h2>
          <p className={result.status === 'available' ? styles.success : styles.warning}>
            {result.status === 'available' ? <CheckCircle2 size={18} aria-hidden="true" /> : <AlertCircle size={18} aria-hidden="true" />}
            {probeLabels[result.status]}
          </p>
          <p className={styles.resultMeta}><time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString('zh-CN')}</time> · {(result.elapsedMs / 1000).toFixed(1)} 秒</p>
          <p>此测试没有切换搜索源。候选可用不代表正文、日期或事实已经核实。</p>
          <ul className={styles.diagnostics}>{result.diagnostics.map((item, index) => (
            <li key={`${item.source}-${index}`}>
              <div><strong>{item.source}</strong><span>{diagnosticLabels[item.status]}</span></div>
              <p>解析 {item.parsedCount} 条 · 相关 {item.relevantCount} 条</p>
              {item.error && <p className={styles.diagnosticError}>{item.error}</p>}
            </li>
          ))}</ul>
        </section>}
      </>}
    </div>
  );
}
