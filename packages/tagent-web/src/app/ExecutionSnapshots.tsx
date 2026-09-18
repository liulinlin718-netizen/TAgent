'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { GitFork, RefreshCw, X } from 'lucide-react';
import type { SnapshotSummary } from '@tagent/core';
import { API_BASE, apiFetch } from '../lib/api-client';
import { useConversations } from '../components/ConversationProvider';
import styles from './ExecutionSnapshots.module.css';

type View = SnapshotSummary & { messages: { role: string; content: string; tools?: string[] }[] };
async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await apiFetch(API_BASE + path, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '快照操作失败。');
  return data;
}

export default function ExecutionSnapshots({ workspaceId, sessionId, onClose }: {
  workspaceId: string; sessionId: string; onClose: () => void;
}) {
  const conversations = useConversations();
  const [items, setItems] = useState<SnapshotSummary[]>([]), [selected, setSelected] = useState('');
  const [view, setView] = useState<View>(), [error, setError] = useState('');
  const [revision, setRevision] = useState(0), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const action = useRef<AbortController | null>(null);
  useEffect(() => () => action.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    void request<{ snapshots: SnapshotSummary[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/snapshots`, controller.signal)
      .then(data => { if (!controller.signal.aborted) { setItems(data.snapshots); setError(''); setLoading(false); } })
      .catch(reason => { if (!controller.signal.aborted) { setError(String(reason.message)); setLoading(false); } });
    return () => controller.abort();
  }, [workspaceId, sessionId, revision]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void request<View>(`/api/snapshots/${encodeURIComponent(selected)}`, controller.signal).then(data => {
      if (data.id !== selected || data.workspaceId !== workspaceId || data.sessionId !== sessionId) throw new Error('快照归属不一致。');
      if (!controller.signal.aborted) setView(data);
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason.message)); });
    return () => controller.abort();
  }, [selected, workspaceId, sessionId]);
  async function fork() {
    if (!view || !confirmed || action.current) return;
    const controller = new AbortController(); action.current = controller; setBusy(true); setError('');
    try {
      const data = await request<{ session: { id: string; workspaceId: string; parentSessionId: string }; willExecute: boolean }>(
        `/api/snapshots/${encodeURIComponent(view.id)}/fork`, controller.signal, { confirmed: true });
      if (data.willExecute !== false || data.session.workspaceId !== workspaceId || data.session.parentSessionId !== sessionId) throw new Error('分支回执不一致，请刷新会话列表核对。');
      if (!controller.signal.aborted) {
        await conversations.refreshWorkspaces(); await conversations.selectSession(workspaceId, data.session.id); onClose();
      }
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '分支创建失败。'); }
    finally { action.current = null; if (!controller.signal.aborted) setBusy(false); }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className={styles.overlay} />
    <Dialog.Content className={styles.panel} onCloseAutoFocus={event => {
      event.preventDefault(); document.getElementById('execution-snapshots-trigger')?.focus();
    }}>
      <header><Dialog.Title>执行快照</Dialog.Title><div>
        <button disabled={busy || loading} title="刷新快照" aria-label="刷新快照" onClick={() => { setLoading(true); setRevision(value => value + 1); }}><RefreshCw size={18} /></button>
        <Dialog.Close disabled={busy} aria-label="关闭快照" title="关闭快照"><X size={18} /></Dialog.Close>
      </div></header>
      <Dialog.Description>历史输入和中间材料。创建分支不会执行任务，也不会回滚文件或重放工具。</Dialog.Description>
      {error && <p role="alert">{error}</p>}
      {loading ? <p role="status">正在读取快照...</p> : !items.length ? <p>此会话暂无保留的执行快照，旧任务不会自动补造。</p> : <>
        <label>执行时刻<select value={selected} disabled={busy} onChange={event => {
          setSelected(event.target.value); setView(undefined); setConfirmed(false); setError('');
        }}><option value="">选择快照</option>{items.map(item => <option key={item.id} value={item.id}>
          {new Date(item.timestamp).toLocaleString('zh-CN')} · {item.agentId} · 第{item.iteration}轮
        </option>)}</select></label>
        {selected && !view && !error && <p role="status">正在读取当时材料...</p>}
        {view && <><div className={styles.messages}>{view.messages.map((message, index) => <details key={index}>
          <summary>{index + 1}. {message.role === 'user' ? '输入材料' : message.role === 'tool' ? '工具结果' : '中间回复'} · {message.content.length}字</summary>
          <pre>{message.content || '无文字内容'}</pre>{!!message.tools?.length && <p>历史工具：{message.tools.join('、')}（不会重放）</p>}
        </details>)}</div>
          <label className={styles.confirm}><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />
            保留为新分支的参考材料，不视为最终报告或当前授权</label>
          <button className={styles.command} disabled={busy || !confirmed} onClick={() => void fork()}><GitFork size={16} />{busy ? '正在创建...' : '创建快照分支'}</button>
        </>}
      </>}
      <small>最多保留200个快照、共8MB；超出保留范围的快照不可恢复。</small>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
