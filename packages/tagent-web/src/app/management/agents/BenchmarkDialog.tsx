'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle2, CircleHelp, FlaskConical, History, ListChecks, RefreshCw, X, XCircle } from 'lucide-react';
import type { AgentBenchmarkProfile, AgentRunEvidenceSource, BenchmarkRun } from '@tagent/core';
import { API_BASE, apiFetch } from '../../../lib/api-client';
import { useConversations } from '../../../components/ConversationProvider';
import styles from './BenchmarkDialog.module.css';
import OfficeBenchmarkPanel from './OfficeBenchmarkPanel';

interface State { profile?: AgentBenchmarkProfile; latestRun?: BenchmarkRun; stale?: boolean }
export default function BenchmarkDialog({ agent, onClose, onSaved, restoreFocus }: {
  agent: { id: string; name: string }; onClose: () => void; onSaved: (state: State) => void; restoreFocus: () => void;
}) {
  const [sources, setSources] = useState<AgentRunEvidenceSource[]>([]);
  const [history, setHistory] = useState<BenchmarkRun[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [shown, setShown] = useState<BenchmarkRun>();
  const [state, setState] = useState<State>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const alive = useRef(true);
  const router = useRouter(), conversations = useConversations();
  const path = `/api/agents/${encodeURIComponent(agent.id)}/benchmark`;
  async function request<T>(suffix: string, init?: RequestInit): Promise<T> {
    const response = await apiFetch(API_BASE + path + suffix, { ...init, signal: init?.signal || AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', ...init?.headers } });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `请求失败（${response.status}）`);
    return value as T;
  }
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const read = async () => {
      try {
        const options = { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) };
        const [nextState, list, sourceList] = await Promise.all([
          request<State>('', options), request<{ runs: BenchmarkRun[] }>('/history', options), request<{ sources: AgentRunEvidenceSource[] }>('/sources', options),
        ]);
        if (!controller.signal.aborted) {
          setState(nextState); setHistory(list.runs); setSources(sourceList.sources); setShown(nextState.latestRun); setError('');
        }
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '评测记录读取失败'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    };
    void read();
    return () => { alive.current = false; controller.abort(); };
    // request uses only the fixed agent path; reloading must not depend on state updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reload]);
  const save = async (sourceRunId?: string) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await request<State & { run: BenchmarkRun }>('/run', { method: 'POST', body: JSON.stringify(sourceRunId ? { sourceRunId } : {}) });
      if (!alive.current) return;
      setState(result); setShown(result.run); setHistory(previous => [result.run, ...previous].slice(0, 20)); onSaved(result);
    } catch (failure) {
      if (alive.current) setError(`${failure instanceof Error ? failure.message : '评测请求失败'}；网络响应不明时请先刷新记录核对，不会自动重试。`);
    } finally { if (alive.current) setBusy(false); }
  };
  const evidence = shown?.evidenceReview;
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className={styles.overlay} />
      <Dialog.Content className={styles.dialog} aria-busy={busy || loading} onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}>
        <header className={styles.header}>
          <div><Dialog.Title className={styles.title}>{agent.name} · 评分与证据</Dialog.Title>
            <Dialog.Description className={styles.description}>配置评分与受控题库成绩分开展示。真实联网与办公交付质量仍需单独验收。</Dialog.Description></div>
          <Dialog.Close disabled={busy} className={styles.icon} aria-label="关闭评分与证据" title="关闭"><X size={18} /></Dialog.Close>
        </header>
        <div className={styles.body}>
          {error && <div className={styles.error} role="alert">{error}<button className={styles.icon} title="刷新评测记录" aria-label="刷新评测记录" disabled={busy || loading}
            onClick={() => { setLoading(true); setReload(value => value + 1); }}><RefreshCw size={16} /></button></div>}
          {loading ? <p role="status">正在读取评测记录...</p> : <>
            <section className={styles.section}>
              <h3><FlaskConical size={17} /> 配置检查</h3>
                <div className={styles.row}><span>本地配置规则 · 模型调用 0 · 联网 0 · 费用 $0</span>
                <button className={styles.command} disabled={busy || !state} onClick={() => void save()}><ListChecks size={16} />{busy ? '保存中...' : '检查并保存记录'}</button></div>
              {state?.stale && <p role="status">配置或规则已变更，旧记录不用于当前雷达评分。</p>}
            </section>
            <OfficeBenchmarkPanel agentId={agent.id} onState={next => { setState(next); onSaved(next); }} />
            <section className={styles.section}>
              <h3><History size={17} /> 已保存任务复核</h3>
              <div className={styles.row}>
                <select aria-label="来源任务" value={sourceId} disabled={busy || !sources.length} onChange={event => setSourceId(event.target.value)}>
                  <option value="">{sources.length ? '选择该 Agent 参与过的任务' : '暂无可复核的完整任务记录'}</option>
                  {sources.map(source => <option key={source.runId} value={source.runId}>{source.title} · {new Date(source.completedAt).toLocaleString()}</option>)}
                </select>
                <button className={styles.command} disabled={!sourceId || busy} onClick={() => void save(sourceId)}><ListChecks size={16} />复核并保存记录</button>
              </div>
            </section>
            <section className={styles.section}>
              <h3>最近检查记录</h3>
              <select aria-label="检查记录" value={shown?.runId || ''} onChange={event => setShown(history.find(run => run.runId === event.target.value))}>
                {!history.length && <option value="">暂无已保存记录</option>}
                {history.map(run => <option key={run.runId} value={run.runId}>{new Date(run.completedAt).toLocaleString()} · {run.evidenceReview ? '配置 + 任务证据' : '配置检查'} · {run.totalScore} 分</option>)}
              </select>
              {shown && <><p className={styles.meta}>规则 {shown.suiteVersion} · 配置版本 {shown.configurationRevision} · {shown.runId}</p>
                <p className={styles.meta}>配置指纹 {shown.configurationFingerprint}</p>
                <div className={styles.results}>{shown.results.map(result => <details key={result.taskId}>
                  <summary>{result.passed ? <CheckCircle2 size={16} /> : <XCircle size={16} />}<span>{result.title}</span><b>{result.score} 分</b></summary>
                  <ul>{[...result.findings, ...result.traceSummary].map((finding, index) => <li key={index}>{finding}</li>)}</ul>
                </details>)}</div>
              </>}
            </section>
            {evidence && <section className={styles.section}>
              <h3>任务证据 · 不计入配置分</h3>
              <div className={styles.row}><span>{evidence.source.title}</span><button className={styles.command} onClick={() => {
                void conversations.selectSession(evidence.source.workspaceId, evidence.source.sessionId); onClose(); router.push('/');
              }}><History size={16} />查看来源任务</button></div>
              <p className={styles.meta}>{evidence.source.runId} · {evidence.agentId}</p>
              <div className={styles.results}>{evidence.checks.map(check => <details key={check.id}>
                <summary>{check.status === 'passed' ? <CheckCircle2 size={16} /> : check.status === 'failed' ? <XCircle size={16} /> : <CircleHelp size={16} />}
                  <span>{check.label}</span><b>{check.status === 'passed' ? '有记录' : check.status === 'failed' ? '存在问题' : '未验证'}</b></summary>
                <p>{check.detail}</p>{check.eventIds.length > 0 && <p className={styles.meta}>事件：{check.eventIds.join('、')}</p>}
              </details>)}</div>
            </section>}
          </>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
