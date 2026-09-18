'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Cable, CheckCircle2, FlaskConical, LoaderCircle, RefreshCw, Save, ShieldCheck, Square } from 'lucide-react';
import type { ModelConnectionPreview, ModelConnectionView } from '@tagent/core';
import { API_BASE, apiFetch } from '../../../lib/api-client';
import styles from './model.module.css';

const endpoint = `${API_BASE}/api/model-connection`;
const statusLabels = { running: '正在测试', succeeded: '已收到完整短回复', failed: '连接测试未通过', cancelled: '测试已停止', interrupted: '测试因服务中断而停止' };
const cost = (value: number | null) => value === null ? '价格未知，不能视为免费' : `约 $${value.toFixed(6)}（本地价格估算）`;
class ModelRequestError extends Error {}

async function response<T>(result: Response): Promise<T> {
  const body = await result.json();
  if (!result.ok) throw new ModelRequestError(typeof body.error === 'string' ? body.error : `请求失败（${result.status}）。`);
  return body as T;
}

export default function ModelConnectionPage() {
  const [view, setView] = useState<ModelConnectionView | null>(null);
  const [preview, setPreview] = useState<ModelConnectionPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>('loading');
  const [error, setError] = useState('');
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const request = useRef<AbortController | null>(null);
  const acting = useRef(false);

  const load = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    return apiFetch(endpoint, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) }).then(response<ModelConnectionView>).then(next => {
      if (controller.signal.aborted) return;
      setView(next); setRequiresRefresh(false);
    }).catch(() => {
      if (!controller.signal.aborted) { setError('无法读取模型连接状态，请检查后端连接后刷新核对。'); setRequiresRefresh(true); }
    }).finally(() => { if (!controller.signal.aborted) setBusy(null); });
  }, []);

  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);

  useEffect(() => {
    if (!view || busy || requiresRefresh || (!view.activeId && !view.retryAfterMs)) return;
    const timer = setTimeout(() => void load(), view.activeId ? 1000 : view.retryAfterMs);
    return () => clearTimeout(timer);
  }, [view, busy, requiresRefresh, load]);

  async function act(action: 'preview' | 'test' | 'cancel' | 'retry-save', id?: string) {
    if (acting.current || busy || (action === 'test' && (!preview || !confirmed))) return;
    acting.current = true;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(action); setError('');
    try {
      const path = action === 'cancel' || action === 'retry-save' ? `/${id}/${action}` : `/${action}`;
      const result = await apiFetch(endpoint + path, { method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]), headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'test' ? { id: preview!.id, token: preview!.token, confirmed: true } : {}) });
      if (action === 'preview') {
        const next = await response<ModelConnectionPreview>(result);
        if (!controller.signal.aborted) { setPreview(next); setConfirmed(false); }
      } else {
        const next = await response<ModelConnectionView>(result);
        if (!controller.signal.aborted) { setView(next); setPreview(null); setConfirmed(false); setRequiresRefresh(false); }
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError((cause instanceof ModelRequestError ? cause.message : '未能确认请求结果，后台测试可能仍在进行。') + ' 请刷新核对；不要连续重复提交。');
        setRequiresRefresh(true); setPreview(null); setConfirmed(false);
      }
    } finally { acting.current = false; if (!controller.signal.aborted) setBusy(null); }
  }

  return <div className={styles.page}>
    <header className={styles.header}>
      <div className={styles.title}><Cable size={24} aria-hidden="true" /><h1>模型连接</h1></div>
      <button type="button" className={styles.iconButton} disabled={!!busy} aria-label="刷新模型状态" title="刷新模型状态" onClick={() => {
        setBusy('loading'); setError(''); setPreview(null); setConfirmed(false); void load();
      }}><RefreshCw size={18} aria-hidden="true" /></button>
    </header>
    {error && <p className={styles.error} role="alert"><AlertCircle size={18} aria-hidden="true" />{error}</p>}
    {busy === 'loading' && <p className={styles.progress} role="status"><LoaderCircle size={18} className={styles.spinner} aria-hidden="true" />正在读取配置...</p>}
    {view && <>
      <section className={styles.section} aria-labelledby="configuration-title">
        <h2 id="configuration-title">当前部署配置</h2>
        {view.configured ? <>
          <dl className={styles.facts}>
            <div><dt>服务商</dt><dd>{view.provider}</dd></div>
            <div><dt>模型</dt><dd>{view.model}</dd></div>
            <div className={styles.full}><dt>服务地址</dt><dd><code>{view.endpoint}</code></dd></div>
          </dl>
          <p className={styles.muted}>配置已读取，当前连通性需单独验证。API Key 不在页面显示或修改。</p>
        </> : <p className={styles.error} role="alert"><AlertCircle size={18} aria-hidden="true" />{view.configurationError}</p>}
        <details className={styles.help}><summary>部署配置核对</summary>
          <dl className={styles.configList}>
            <div><dt><code>TAGENT_LLM_PROVIDER</code></dt><dd>deepseek、anthropic 或 openai，须与对应密钥一致。</dd></div>
            <div><dt>模型密钥</dt><dd><code>DEEPSEEK_API_KEY</code> / <code>ANTHROPIC_API_KEY</code> / <code>OPENAI_API_KEY</code></dd></div>
            <div><dt>模型与地址</dt><dd><code>TAGENT_LLM_MODEL</code> 与所选服务的 <code>*_BASE_URL</code>；部署环境优先于后端 .env。</dd></div>
          </dl>
          <p>密钥仅在服务端配置。修改后需由管理员重启后端；不要关闭 TLS 证书校验，也不要连续重发失败任务。</p>
        </details>
        <div className={styles.actions}>
          <button type="button" className={styles.button} disabled={!!busy || !view.configured || !!view.activeId || requiresRefresh || view.retryAfterMs > 0 || view.checks.some(check => !check.persisted)} onClick={() => void act('preview')}>
            <FlaskConical size={18} aria-hidden="true" />连接测试预览
          </button>
          <Link href="/management/search">检查调研搜索</Link>
        </div>
        {!!view.retryAfterMs && !view.activeId && <p className={styles.muted}>两次测试至少间隔30秒，稍后恢复测试入口。</p>}
      </section>

      {preview && <section className={styles.section} aria-labelledby="consent-title">
        <h2 id="consent-title"><ShieldCheck size={18} aria-hidden="true" />测试内容与费用确认</h2>
        <p>接收方：<code>{preview.endpoint}</code><br />模型：{preview.provider} / {preview.model}</p>
        <blockquote className={styles.prompt}>{preview.prompt}</blockquote>
        <p>仅发送上面的固定文本，不发送对话、工作文件或 Skill 内容。1次模型请求，输出上限64 tokens，等待上限{preview.timeoutMs / 1000}秒；没有工具调用或自动重试。</p>
        <p>预计费用：{cost(preview.estimatedCost)}。估算不是费用硬上限；实际以服务商账单为准，超时或停止也可能计费。</p>
        <label className={styles.confirm}><input type="checkbox" checked={confirmed} disabled={!!busy} onChange={event => setConfirmed(event.target.checked)} />
          <span>我同意发送上述固定测试内容，并承担本次模型请求可能产生的费用。</span></label>
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={!!busy || !confirmed || requiresRefresh} onClick={() => void act('test')}>
          {busy === 'test' ? <LoaderCircle size={18} className={styles.spinner} aria-hidden="true" /> : <FlaskConical size={18} aria-hidden="true" />}确认并测试
        </button>
      </section>}

      <section className={styles.section} aria-labelledby="results-title">
        <h2 id="results-title">最近连接测试</h2>
        {!view.checks.length && <p className={styles.muted}>尚未运行连接测试。</p>}
        {view.checks.map(check => <article className={styles.result} key={check.id}>
          <div className={styles.resultHeader}>
            <strong className={check.status === 'succeeded' ? styles.success : check.status === 'running' ? styles.progress : styles.warning}>
              {check.status === 'succeeded' ? <CheckCircle2 size={18} aria-hidden="true" /> : check.status === 'running' ? <LoaderCircle className={styles.spinner} size={18} aria-hidden="true" /> : <AlertCircle size={18} aria-hidden="true" />}
              {statusLabels[check.status]}
            </strong>
            <time dateTime={new Date(check.startedAt).toISOString()}>{new Date(check.startedAt).toLocaleString('zh-CN')}</time>
          </div>
          <p className={styles.muted}>{check.provider} / {check.model} · <code>{check.endpoint}</code></p>
          {check.error && <p className={styles.error}>{check.error}</p>}
          {check.status === 'succeeded' && <p>此次短请求成功，不保证后续任务、工具调用或联网调研可用。</p>}
          {check.tokens && <p className={styles.muted}>输入 {check.tokens.input} · 输出 {check.tokens.output} tokens · {cost(check.estimatedCost)}</p>}
          {check.unsettled && <p className={styles.warning}>尚未收到完整用量，费用待核对，不能当作零费用。</p>}
          {view.activeId === check.id && <button type="button" className={styles.button} disabled={!!busy} onClick={() => void act('cancel', check.id)}><Square size={16} aria-hidden="true" />停止测试</button>}
          {!check.persisted && <div className={styles.error} role="alert"><span>结果尚未保存，请保留此页面；重试保存不会再次调用模型。</span>
            <button type="button" className={styles.button} disabled={!!busy || !!view.activeId} onClick={() => void act('retry-save', check.id)}><Save size={17} aria-hidden="true" />重试保存</button></div>}
        </article>)}
        <p className={styles.muted}>保留最近20条测试记录，重启不自动重跑。测试费用不计入某个办公会话，不代表完整账单。</p>
      </section>
    </>}
  </div>;
}
