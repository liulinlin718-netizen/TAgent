'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, RefreshCw, ShieldQuestion, X } from 'lucide-react';
import type { ToolApprovalView, WorkflowEvent } from '@tagent/core';
import { API_BASE, apiFetch } from '../lib/api-client';
import styles from './ToolApprovalPanel.module.css';

const labels = { pending: '等待确认', approved: '已批准本次', denied: '已拒绝', expired: '已超时', cancelled: '已失效', failed: '未取得许可' };
export default function ToolApprovalPanel({ traces, runId, sessionId, active }: {
  traces: Pick<WorkflowEvent, 'data'>[]; runId?: string; sessionId: string; active: boolean;
}) {
  const [remote, setRemote] = useState<ToolApprovalView[]>([]), [updates, setUpdates] = useState<Record<string, ToolApprovalView>>({});
  const [error, setError] = useState(''), [busy, setBusy] = useState(''), [reload, setReload] = useState(0);
  const alive = useRef(false), lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    if (runId && active) {
      void apiFetch(`${API_BASE}/api/approvals?${new URLSearchParams({ runId, sessionId })}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
        .then(async response => { if (!response.ok) throw new Error('审批状态读取失败，请核对当前任务。'); return response.json(); })
        .then(value => { if (!controller.signal.aborted) { setRemote(value.approvals); setError(''); } })
        .catch(failure => { if (!controller.signal.aborted) setError(failure.message || '审批状态读取失败'); });
    }
    return () => { alive.current = false; controller.abort(); };
  }, [runId, sessionId, active, reload]);
  const current = new Map(remote.map(view => [view.requestId, view]));
  for (const trace of traces) {
    const view = trace.data?.approval as ToolApprovalView | undefined;
    if (view?.requestId && view.runId === runId && view.sessionId === sessionId) current.set(view.requestId, view);
  }
  for (const view of Object.values(updates)) if (current.get(view.requestId)?.status === 'pending') current.set(view.requestId, view);
  const requests = [...current.values()].filter(view => view.runId === runId && view.sessionId === sessionId);
  if (!requests.length && !error) return null;
  const decide = async (view: ToolApprovalView, approved: boolean) => {
    if (lock.current) return;
    lock.current = true; setBusy(view.requestId); setError('');
    try {
      const response = await apiFetch(`${API_BASE}/api/approval/${encodeURIComponent(view.requestId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ approved, runId: view.runId, sessionId: view.sessionId }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '审批未被接受');
      if (alive.current) setUpdates(previous => ({ ...previous, [view.requestId]: value.approval }));
    } catch (failure) { if (alive.current) setError(`${failure instanceof Error ? failure.message : '审批失败'}；不会自动重试，请刷新状态核对。`); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  };
  return <section className={styles.panel} aria-label="工具执行确认">
    {error && <div className={styles.error} role="alert"><span>{error}</span><button title="刷新审批状态" aria-label="刷新审批状态" onClick={() => setReload(value => value + 1)} disabled={!!busy}><RefreshCw size={16} /></button></div>}
    {requests.map(view => <div className={styles.request} key={view.requestId}>
      <h3><ShieldQuestion size={18} />{view.status === 'pending' && !active ? '已结束，未取得确认' : labels[view.status]} · {view.toolName}</h3>
      <p>{view.reason}</p>
      <p className={styles.meta}>{view.agentId} · {view.taskId || '当前任务'} · 确认截止 {new Date(view.expiresAt).toLocaleTimeString()}</p>
      <details open={view.status === 'pending'}><summary>本次参数{view.redacted ? '（凭据已脱敏）' : ''}</summary><pre>{view.argsPreview}</pre></details>
      {view.truncated && <p className={styles.error}>参数预览不完整，不能批准；请拒绝后缩小请求。</p>}
      {view.status === 'pending' && active ? <div className={styles.actions}>
        <button disabled={!!busy} onClick={() => void decide(view, false)}><X size={16} />拒绝本次</button>
        <button disabled={!!busy || view.truncated} onClick={() => void decide(view, true)}><Check size={16} />{busy === view.requestId ? '正在确认...' : '允许本次'}</button>
      </div> : view.status === 'pending' ? <p className={styles.meta}>任务已结束，历史请求不再接受批准；没有完成回执时不能推断工具已经执行。</p> : null}
    </div>)}
  </section>;
}
