'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, Check, GitBranch, LoaderCircle, Quote, RefreshCw, X } from 'lucide-react';
import type { SessionQuotePreview } from '@tagent/core';
import { API_BASE, apiFetch } from '../lib/api-client';
import type { Session } from '../lib/conversations';
import { commonMessageCount, validQuotePreview } from '../lib/session-diff';
import { useConversations } from '../components/ConversationProvider';
import styles from './SessionDiffView.module.css';

type DiffSession = Session & { workspaceId: string };

async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await apiFetch(API_BASE + path, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `请求失败（${response.status}）`);
  return value;
}

export default function SessionDiffView({ parentSessionId, branchSessionId, workspaceId, onClose, restoreFocus }: {
  parentSessionId: string; branchSessionId: string; workspaceId: string; onClose: () => void; restoreFocus: () => void;
}) {
  const [sessions, setSessions] = useState<{ parent: DiffSession; branch: DiffSession }>();
  const [loading, setLoading] = useState(true), [reload, setReload] = useState(0);
  const [error, setError] = useState(''), [saved, setSaved] = useState('');
  const [view, setView] = useState<'parent' | 'branch'>('branch');
  const [selection, setSelection] = useState<{ messageId: string; original: string; text: string }>();
  const [preview, setPreview] = useState<SessionQuotePreview>();
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const conversations = useConversations();
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`;
  useEffect(() => {
    return () => { controller.current?.abort(); };
  }, []);
  useEffect(() => {
    const read = new AbortController();
    async function load() {
      try {
        const [parent, branch] = await Promise.all([
          request<DiffSession>(`${base}/${encodeURIComponent(parentSessionId)}`, read.signal),
          request<DiffSession>(`${base}/${encodeURIComponent(branchSessionId)}`, read.signal),
        ]);
        if (parent.id !== parentSessionId || branch.id !== branchSessionId || branch.parentSessionId !== parent.id
          || parent.workspaceId !== workspaceId || branch.workspaceId !== workspaceId
          || !Array.isArray(parent.messages) || !Array.isArray(branch.messages)) throw new Error('会话归属或对比数据不一致。');
        if (!read.signal.aborted) { setSessions({ parent, branch }); setError(''); }
      } catch (failure) { if (!read.signal.aborted) setError(failure instanceof Error ? failure.message : '对比读取失败'); }
      finally { if (!read.signal.aborted) setLoading(false); }
    }
    void load();
    return () => read.abort();
  }, [base, parentSessionId, branchSessionId, workspaceId, reload]);

  const common = sessions ? commonMessageCount(sessions.parent.messages, sessions.branch.messages) : 0;
  const running = sessions && [sessions.parent, sessions.branch].some(session => session.messages.some(message => message.run?.status === 'running')
    || session.summaryForks?.some(record => ['running', 'ready'].includes(record.status)));
  const chars = Array.from(selection?.text || '').length;
  const selectionValid = !!selection?.text.trim() && chars <= 8000 && !!selection?.original.includes(selection.text);
  const reloadSessions = () => { setLoading(true); setPreview(undefined); setReload(value => value + 1); };
  const transact = async (confirm: boolean) => {
    if (!selection || busy || !selectionValid || (confirm && !preview)) return;
    const active = new AbortController(); controller.current = active;
    setBusy(true); setError('');
    try {
      const path = `${base}/${encodeURIComponent(branchSessionId)}`;
      const body = { messageId: selection.messageId, text: selection.text };
      if (!confirm) {
        const value = await request<SessionQuotePreview>(path + '/quote-preview', active.signal, body);
        if (!validQuotePreview(value, parentSessionId, branchSessionId, selection.messageId, selection.text)) throw new Error('引用预览回执不完整，未保存。');
        if (!active.signal.aborted) setPreview(value);
      } else {
        const value = await request<{ ok: boolean; parentSessionId: string; message: Session['messages'][number]; created: boolean }>(
          path + '/merge-to-parent', active.signal, { ...body, fingerprint: preview!.fingerprint, confirmed: true });
        if (!value.ok || value.parentSessionId !== parentSessionId || value.message.content !== selection.text
          || value.message.quote?.sourceSessionId !== branchSessionId) throw new Error('保存回执不完整，请刷新主线核对。');
        if (active.signal.aborted) return;
        setSessions(current => current && ({ ...current, parent: { ...current.parent,
          messages: [...current.parent.messages.filter(message => message.id !== value.message.id), value.message] } }));
        setSaved(value.created ? '引用已保存到主线，来源分支保持不变。' : '此段原文已引用，未重复添加。');
        setSelection(undefined); setPreview(undefined);
        void conversations.refreshWorkspaces();
        void conversations.refreshSession(workspaceId, parentSessionId);
      }
    } catch (failure) {
      if (!active.signal.aborted) setError(`${failure instanceof Error ? failure.message : '请求失败'}${confirm ? '；响应不明时可刷新主线核对。同一原文重复确认不会重复添加。' : ''}`);
    } finally { if (!active.signal.aborted) setBusy(false); }
  };

  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className={styles.overlay} />
      <Dialog.Content className={styles.panel} aria-busy={loading || busy} onCloseAutoFocus={event => {
        event.preventDefault(); restoreFocus();
      }}>
        <header className={styles.header}>
          <div><Dialog.Title className={styles.title}><GitBranch size={18} />分支对比与引用</Dialog.Title>
            <Dialog.Description className={styles.meta}>{sessions ? `共同消息 ${common} 条 · 主线新增 ${sessions.parent.messages.length - common} 条 · 分支新增 ${sessions.branch.messages.length - common} 条` : '正在读取主线与分支'}</Dialog.Description></div>
          <Dialog.Close className={styles.icon} disabled={busy} title="关闭对比" aria-label="关闭对比"><X size={18} /></Dialog.Close>
        </header>
        <div className={styles.notices}>
          {loading && <p role="status"><LoaderCircle size={16} />正在读取对比...</p>}
          {error && <p role="alert">{error}<button className={styles.icon} aria-label="重新读取对比" title="重新读取对比" disabled={busy || loading} onClick={reloadSessions}><RefreshCw size={16} /></button></p>}
          {saved && <p role="status"><Check size={16} />{saved}</p>}
          {running && <p role="status">主线或分支仍在运行，结束后重新读取即可引用。</p>}
        </div>
        {selection ? <div className={styles.editor}>
          <button className={styles.command} disabled={busy} onClick={() => { setSelection(undefined); setPreview(undefined); setError(''); }}><ArrowLeft size={16} />返回对比</button>
          <h3>{preview ? '确认引用' : '选择引用原文'}</h3>
          <p className={styles.meta}>来源：{sessions?.branch.title} · 目标：{sessions?.parent.title}</p>
          {preview ? <><blockquote className={styles.excerpt}>{preview.text}</blockquote><p className={styles.meta}>仅保存上述原文及来源，不调用模型，不执行工具。引用内容未经独立核验。</p></> : <>
            <label htmlFor="quote-excerpt">引用原文</label>
            <textarea id="quote-excerpt" value={selection.text} disabled={busy} onChange={event => { setPreview(undefined); setSelection({ ...selection, text: event.target.value }); }} />
            <p className={styles.meta}>{chars} / 8000 字{!selectionValid && ' · 请选择来源回复中连续、非空的一段原文'}</p>
          </>}
          <div className={styles.actions}>{preview && <button className={styles.command} disabled={busy} onClick={() => setPreview(undefined)}>调整原文</button>}
            <button className={styles.command} disabled={busy || !selectionValid || !!running || loading} onClick={() => void transact(!!preview)}>
              {busy ? <LoaderCircle size={16} /> : <Quote size={16} />}{busy ? '处理中...' : preview ? '确认引用到主线' : '预览引用'}
            </button></div>
        </div> : sessions && <>
          <div className={styles.tabs} role="group" aria-label="对比会话">
            <button aria-pressed={view === 'parent'} onClick={() => setView('parent')}>主线</button>
            <button aria-pressed={view === 'branch'} onClick={() => setView('branch')}>分支</button>
          </div>
          <div className={styles.body}>{(['parent', 'branch'] as const).map(side => <section key={side} className={styles.column} data-active={view === side} aria-label={side === 'parent' ? '主线消息' : '分支消息'}>
            <h3>{side === 'parent' ? '主线' : '分支'} · {sessions[side].title}</h3>
            <div className={styles.messages}>
              {!sessions[side].messages.length && <p className={styles.meta}>暂无消息</p>}
              {sessions[side].messages.map((message, index) => <article key={message.id} className={styles.message} data-common={index < common}>
                <div className={styles.messageMeta}><b>{message.role === 'user' ? '用户' : 'Agent'}</b><span>{index < common ? '共同历史' : '分叉后消息'}{message.quote ? ' · 引用原文' : message.contextKind === 'fork_summary' ? ' · 压缩摘要' : ''}</span></div>
                <div className={styles.text}>{message.content}</div>
                {side === 'branch' && message.role === 'assistant' && message.content.trim() && <button className={styles.command} disabled={busy || !!running || loading}
                  onClick={event => {
                    const selected = window.getSelection(), article = event.currentTarget.closest('article');
                    const picked = selected?.anchorNode && article?.contains(selected.anchorNode) && selected.focusNode && article.contains(selected.focusNode) ? selected.toString() : '';
                    const text = picked && message.content.includes(picked) ? picked : Array.from(message.content).slice(0, 8000).join('');
                    setSelection({ messageId: message.id, original: message.content, text }); setSaved(''); setError('');
                  }}><Quote size={15} />引用此回复</button>}
              </article>)}
            </div>
          </section>)}</div>
        </>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
