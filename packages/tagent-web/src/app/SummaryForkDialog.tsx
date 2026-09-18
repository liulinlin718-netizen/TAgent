'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, Check, FileText, LoaderCircle, RefreshCw, Save, Square, X } from 'lucide-react';
import type { SummaryForkConsent, SummaryForkView } from '@tagent/core';
import { API_BASE, apiFetch } from '../lib/api-client';
import type { Session } from '../lib/conversations';
import { summaryPending, summaryStatus, validSummaryConsent, validSummaryView } from '../lib/session-summary';
import { useConversations } from '../components/ConversationProvider';
import shared from './SessionDiffView.module.css';
import styles from './SummaryForkDialog.module.css';

class RequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await apiFetch(API_BASE + path, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    ...(body !== undefined ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new RequestError(value.error || `请求失败（${response.status}）`, response.status);
  return value;
}
const dollars = (value: number) => `$${value.toFixed(6)}`;

export default function SummaryForkDialog({ workspaceId, sessionId, onClose, restoreFocus }: {
  workspaceId: string; sessionId: string; onClose: () => void; restoreFocus: () => void;
}) {
  const conversations = useConversations();
  const [source, setSource] = useState<Session>();
  const [operations, setOperations] = useState<SummaryForkView[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [consent, setConsent] = useState<SummaryForkConsent>();
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const action = useRef<AbortController | null>(null), pollRead = useRef<AbortController | null>(null);
  const revision = useRef(0), received = useRef('');
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`;
  const blocked = operations.some(view => !view.persisted || summaryPending(view));
  const normalRunning = source?.messages.some(message => message.run?.status === 'running');
  const preservedCharacters = source?.messages.filter(message => selected.includes(message.id)).reduce((sum, message) => sum + Array.from(message.content).length, 0) || 0;

  useEffect(() => () => { action.current?.abort(); }, []);
  useEffect(() => {
    const read = new AbortController(); pollRead.current = read;
    const generation = revision.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load(first: boolean) {
      try {
        if (first) {
          const value = await request<Session & { workspaceId: string }>(base, read.signal);
          if (value.id !== sessionId || value.workspaceId !== workspaceId || !Array.isArray(value.messages)) throw new Error('来源会话回执不一致。');
          if (!read.signal.aborted && generation === revision.current) setSource(value);
        }
        const value = await request<{ operations: unknown[] }>(base + '/summary-forks', read.signal);
        if (!Array.isArray(value.operations) || !value.operations.every(item => validSummaryView(item, workspaceId, sessionId))) throw new Error('摘要记录回执不完整。');
        if (read.signal.aborted || generation !== revision.current) return;
        const views = value.operations as SummaryForkView[];
        setOperations(views); setLoading(false);
        setConsent(current => current && views.some(view => view.record.id === current.id) ? undefined : current);
        const fingerprint = JSON.stringify(views.map(view => [view.record.id, view.record.status, view.persisted]));
        if (received.current !== fingerprint) {
          received.current = fingerprint;
          void conversations.refreshWorkspaces();
          void conversations.refreshSession(workspaceId, sessionId);
        }
        if (views.some(summaryPending)) timer = setTimeout(() => void load(false), 1000);
      } catch (failure) {
        if (!read.signal.aborted) { setError(failure instanceof Error ? failure.message : '摘要记录读取失败'); setLoading(false); }
      }
    }
    void load(true);
    return () => { read.abort(); clearTimeout(timer); };
  }, [base, sessionId, workspaceId, reload, conversations]);

  const refresh = () => { revision.current++; pollRead.current?.abort(); setError(''); setLoading(true); setReload(value => value + 1); };
  async function perform(kind: 'preview' | 'confirm' | 'retry-save' | 'cancel' | 'open', view?: SummaryForkView) {
    if (action.current) return;
    const active = new AbortController(); action.current = active;
    revision.current++; pollRead.current?.abort(); setBusy(true); setError('');
    try {
      if (kind === 'preview') {
        const value = await request<unknown>(base + '/fork/preview', active.signal, { preservedMessageIds: selected });
        if (!source || !validSummaryConsent(value, source.messages, selected)) throw new Error('摘要预览范围或安全回执不一致，未调用模型。');
        if (!active.signal.aborted) setConsent(value);
      } else if (kind === 'open' && view) {
        const value = await request<Session & { workspaceId: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(view.record.targetSessionId)}`, active.signal);
        if (value.id !== view.record.targetSessionId || value.parentSessionId !== sessionId || value.workspaceId !== workspaceId) throw new Error('新分支归属不一致。');
        if (!active.signal.aborted) { await conversations.selectSession(workspaceId, value.id); onClose(); }
      } else {
        const value = kind === 'confirm' && consent
          ? await request<unknown>(base + '/fork', active.signal, { forkType: 'fork_summary', confirmed: true, previewId: consent.id, token: consent.token })
          : view ? await request<unknown>(`${base}/summary-forks/${encodeURIComponent(view.record.id)}/${kind}`, active.signal, {}) : undefined;
        if (!validSummaryView(value, workspaceId, sessionId) || value.record.id !== (kind === 'confirm' ? consent?.id : view?.record.id)) throw new Error('操作回执不一致，请重新读取记录核对。');
        if (!active.signal.aborted) {
          setOperations(current => [value, ...current.filter(item => item.record.id !== value.record.id)]); setConsent(undefined);
          void conversations.refreshWorkspaces(); void conversations.refreshSession(workspaceId, sessionId);
        }
      }
    } catch (failure) {
      if (!active.signal.aborted) {
        if (kind === 'confirm' && failure instanceof RequestError && failure.status === 409) setConsent(undefined);
        setError((failure instanceof Error ? failure.message : '请求未完成') + (kind === 'confirm' ? ' 请先重新读取记录核对；同一确认不会重复调用模型。' : ''));
      }
    } finally {
      action.current = null;
      if (!active.signal.aborted) { setBusy(false); setLoading(false); if (kind !== 'preview') setReload(value => value + 1); }
    }
  }

  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className={shared.overlay} />
    <Dialog.Content className={`${shared.panel} ${styles.panel}`} onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}>
      <header className={shared.header}><div><Dialog.Title className={shared.title}><FileText size={18} />摘要分支</Dialog.Title>
        <Dialog.Description className={shared.meta}>{source?.title || '正在读取来源会话'}</Dialog.Description></div>
        <Dialog.Close className={shared.icon} disabled={busy} title="关闭摘要分支" aria-label="关闭摘要分支"><X size={18} /></Dialog.Close></header>
      <div className={shared.notices}>
        {(loading || busy) && <p role="status"><LoaderCircle size={16} />{busy ? '正在提交操作...' : '正在读取摘要记录...'}</p>}
        {error && <p role="alert">{error}<button className={shared.icon} disabled={busy || loading} title="重新读取摘要记录" aria-label="重新读取摘要记录" onClick={refresh}><RefreshCw size={16} /></button></p>}
      </div>
      <div className={styles.body}>
        {!!operations.length && <section className={styles.section} aria-label="摘要操作记录"><div className={styles.row}><h3>摘要操作记录</h3>
          <button className={shared.icon} disabled={busy || loading} title="刷新摘要记录" aria-label="刷新摘要记录" onClick={refresh}><RefreshCw size={16} /></button></div>
          {operations.map(view => <article key={view.record.id} className={styles.operation} data-failed={!view.persisted || ['failed', 'interrupted'].includes(view.record.status)}>
            <div className={styles.row}><strong role="status">{summaryStatus(view)}</strong><span className={shared.meta}>{new Date(view.record.startedAt).toLocaleString('zh-CN')}</span></div>
            <p className={shared.meta}>已知费用 {dollars(view.record.usage.knownCost)} · 输入 {view.record.usage.input} / 输出 {view.record.usage.output} tokens</p>
            {(view.record.usage.unsettledRequests > 0 || !view.record.usage.pricingKnown) && <p className={styles.warning}>费用待核对：未收到的用量或未知单价不代表免费，请核对模型供应商账单。</p>}
            {view.record.error && <p className={styles.warning}>{view.record.error}</p>}
            {!view.persisted && <p className={styles.warning}>结果尚未完整保存。请保留此页面并处理存储故障，再重试本地保存；不会重新调用模型。重启可能丢失尚未落盘的内容。</p>}
            {(view.record.output || view.record.rawOutput) && <details><summary>{view.record.output ? '查看提取原文' : '查看模型返回（未通过核对，最多12000字）'}</summary><pre className={styles.original}>{view.record.output || view.record.rawOutput}</pre></details>}
            <div className={shared.actions}>
              {summaryPending(view) && <button className={shared.command} disabled={busy} onClick={() => void perform('cancel', view)}><Square size={15} />停止摘要</button>}
              {view.canRetrySave && <button className={shared.command} disabled={busy} onClick={() => void perform('retry-save', view)}><Save size={15} />重试本地保存</button>}
              {view.persisted && view.record.status === 'completed' && <button className={shared.command} disabled={busy} onClick={() => void perform('open', view)}><ArrowRight size={15} />打开新分支</button>}
            </div>
          </article>)}
        </section>}
        {source && <section className={styles.section} aria-label="创建摘要分支"><h3>创建摘要分支</h3>
          {normalRunning && <p className={styles.warning}>来源任务正在运行，结束后重新读取再创建摘要。</p>}
          {blocked ? <p className={shared.meta}>请先处理上方正在运行或未保存的摘要。关闭窗口不会停止已确认的操作。</p>
            : consent ? <>
              <dl className={styles.facts}><dt>模型</dt><dd>{consent.preview.provider} · {consent.preview.model}</dd><dt>发送至</dt><dd>{consent.preview.endpoint}</dd>
                <dt>外发范围</dt><dd>{consent.preview.inputMessageIds.length} 条待压缩原文，约 {consent.preview.inputBytes} UTF-8 字节（含提取指令）。</dd>
                <dt>完整保留</dt><dd>{consent.preview.preservedMessageIds.length} 条 / {consent.preview.preservedCharacters} 字。这些原文仅复制到分支，本次摘要调用不外发其正文。</dd>
                <dt>费用估算</dt><dd>{consent.preview.estimatedCost === null ? '模型单价未知，费用无法估算。' : dollars(consent.preview.estimatedCost) + '，本地单价粗估，不是账单上限。'}</dd>
                <dt>调用限制</dt><dd>最多一次模型调用，输出最多2048 tokens，不调用工具，不自动重试。</dd></dl>
              <p className={styles.warning}>确认后发送上述历史并产生模型费用，记在来源会话。停止、失败或中断仍可能计费。提取只能核对原文一致性，不能保证没有遗漏关键条件。</p>
              <div className={shared.actions}><button className={shared.command} disabled={busy} onClick={() => setConsent(undefined)}>调整保留范围</button>
                <button className={shared.command} disabled={busy || loading || !!normalRunning} onClick={() => void perform('confirm')}><Check size={16} />确认调用模型并创建</button></div>
            </> : <>
              <details><summary>完整保留的消息 · 已选 {selected.length} 条 / {preservedCharacters} 字</summary>
                <div className={styles.list}>{source.messages.map((message, index) => <div key={message.id} className={styles.message}>
                  <label><input type="checkbox" checked={selected.includes(message.id)} disabled={busy} onChange={event => setSelected(current => event.target.checked ? [...current, message.id] : current.filter(id => id !== message.id))} />
                    {index + 1}. {message.role === 'user' ? '用户' : 'Agent'} · {Array.from(message.content).length} 字</label><p>{message.content}</p>
                </div>)}</div>
              </details>
              {preservedCharacters > 8000 && <p role="alert" className={styles.warning}>完整保留最多8000字，请减少选择或使用完整 Fork。</p>}
              <div className={shared.actions}><button className={shared.command} disabled={busy || loading || !!normalRunning || !source.messages.length || preservedCharacters > 8000 || selected.length > 100}
                onClick={() => void perform('preview')}><FileText size={16} />预览范围与费用</button></div>
            </>}
        </section>}
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
