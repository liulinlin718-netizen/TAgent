'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, FlaskConical, Play, RefreshCw, Square, XCircle } from 'lucide-react';
import type { AgentBenchmarkProfile, BenchmarkRun, OfficeBenchmarkConsent, OfficeBenchmarkHistoryEntry, OfficeBenchmarkView } from '@tagent/core';
import { API_BASE, apiFetch } from '../../../lib/api-client';
import styles from './BenchmarkDialog.module.css';

type ScoreState = { profile?: AgentBenchmarkProfile; latestRun?: BenchmarkRun; stale?: boolean };
type History = { runs: OfficeBenchmarkHistoryEntry[]; activeId?: string; storageFailed: boolean };
const labels = { running: '运行中', completed: '已完成', failed: '执行失败', interrupted: '已中断', pending: '待执行' };
export default function OfficeBenchmarkPanel({ agentId, onState }: { agentId: string; onState: (state: ScoreState) => void }) {
  const [history, setHistory] = useState<History>({ runs: [], storageFailed: false });
  const [view, setView] = useState<OfficeBenchmarkView>();
  const [consent, setConsent] = useState<OfficeBenchmarkConsent>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const alive = useRef(true), locked = useRef(false), callback = useRef(onState), observed = useRef('');
  const base = `/api/agents/${encodeURIComponent(agentId)}/benchmark`;
  useEffect(() => { callback.current = onState; }, [onState]);
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await apiFetch(API_BASE + base + path, { ...init, signal: init?.signal || AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json' } });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `请求失败（${response.status}）`);
    return value as T;
  }
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
        const next = await request<History>('/live/history', { signal });
        const id = next.activeId || next.runs[0]?.id;
        const current = id ? await request<OfficeBenchmarkView>(`/live/runs/${encodeURIComponent(id)}`, { signal }) : undefined;
        if (controller.signal.aborted) return;
        setHistory(next); setView(current); setError(''); setLoading(false);
        if (current && current.run.status !== 'running' && observed.current !== current.run.id) {
          const score = await request<ScoreState>('', { signal });
          if (controller.signal.aborted) return;
          observed.current = current.run.id; callback.current(score);
        }
        if (current?.run.status === 'running') timer = setTimeout(() => void read(), 1500);
      } catch (failure) {
        if (!controller.signal.aborted) { setError(`${failure instanceof Error ? failure.message : '记录读取失败'}；轮询已暂停，请刷新核对。`); setLoading(false); }
      }
    };
    void read();
    return () => { alive.current = false; controller.abort(); clearTimeout(timer); };
    // Read-only polling is scoped to this Agent and explicit refresh, never to result state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, reload]);
  async function action(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await work(); }
    catch (failure) { if (alive.current) setError(`${failure instanceof Error ? failure.message : '请求未完成'}；不会自动重试，响应不明时请先刷新记录。`); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  const running = view?.run.status === 'running';
  return <section className={styles.section} aria-label="受控办公实跑">
    <h3><FlaskConical size={17} /> 受控办公实跑</h3>
    <div className={styles.row}><span>8 题固定材料 · 会调用已配置的模型 · 非联网评测</span>
      <button className={styles.command} disabled={busy || loading || running || history.storageFailed} onClick={() => void action(async () => {
        const next = await request<OfficeBenchmarkConsent>('/live/preview', { method: 'POST', body: '{}' });
        if (alive.current) { setConsent(next); setConfirmed(false); }
      })}><Play size={16} />查看范围与费用</button>
      <button className={styles.icon} aria-label="刷新实跑记录" title="刷新实跑记录" disabled={busy} onClick={() => setReload(value => value + 1)}><RefreshCw size={16} /></button>
    </div>
    {loading && <p role="status">正在读取实跑记录...</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {history.storageFailed && <p className={styles.error} role="alert">评测存储故障，新增评测已暂停。请先保留未保存结果，再检查存储并重启。</p>}
    {consent && <div className={styles.consent}>
      <h4>确认本次评测</h4>
      <p className={styles.meta}>模型 {consent.preview.provider} / {consent.preview.model}<br />接收方 {consent.endpoint}</p>
      <p>最多 {consent.preview.maxModelCalls} 次模型请求，每次最多 {consent.preview.maxOutputTokensPerCall} 输出 token，总时限 {consent.preview.timeoutMs / 60000} 分钟。</p>
      <p>本地保守估算：{consent.preview.estimatedCost === null ? '价格未知' : `$${consent.preview.estimatedCost.toFixed(3)}`}。已知费用达到 ${consent.preview.costStopThreshold.toFixed(2)} 后停止追加请求，不是服务商扣费硬上限；中断请求也可能计费。</p>
      <p>将外发：{consent.preview.sends.join('；')}。不发送你的历史会话，不启用真实联网工具、MCP 或外部命令。</p>
      <details><summary>题目与未覆盖能力</summary><ol>{consent.tasks.map(task => <li key={task.id}>{task.title}</li>)}</ol><p>不覆盖：{consent.preview.excludes.join('；')}。</p></details>
      {consent.preview.missingSkillIds.length > 0 && <p className={styles.error}>未找到的绑定 Skill：{consent.preview.missingSkillIds.join('、')}。本次不会加载这些能力。</p>}
      <label className={styles.confirm}><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />我同意上述外发范围与模型费用</label>
      <p className={styles.meta}>确认有效期至 {new Date(consent.expiresAt).toLocaleTimeString()}。关闭窗口不会停止已确认的评测；需要时请点击停止。</p>
      <div className={styles.row}><button className={styles.command} disabled={!confirmed || busy || running || history.storageFailed} onClick={() => void action(async () => {
        const token = consent.token; setConsent(undefined); setConfirmed(false);
        const next = await request<OfficeBenchmarkView>('/live/start', { method: 'POST', body: JSON.stringify({ token, confirmed: true }) });
        if (alive.current) { setView(next); setReload(value => value + 1); }
      })}><Play size={16} />确认并运行八题评测</button>
      <button className={styles.command} disabled={busy} onClick={() => { setConsent(undefined); setConfirmed(false); }}>取消确认</button></div>
    </div>}
    {history.runs.length > 0 && <div className={styles.history}>
      <label htmlFor="office-benchmark-history">实跑记录</label>
      <select id="office-benchmark-history" value={view?.run.id || ''} disabled={busy || running} onChange={event => {
        const id = event.target.value;
        void action(async () => { const next = await request<OfficeBenchmarkView>(`/live/runs/${encodeURIComponent(id)}`); if (alive.current) setView(next); });
      }}>{history.runs.map(run => <option key={run.id} value={run.id}>{new Date(run.startedAt).toLocaleString()} · {labels[run.status]} · {run.model}{run.totalScore !== undefined ? ` · ${run.totalScore} 分` : ''}{run.persistence === 'failed' ? ' · 未保存' : ''}</option>)}</select>
    </div>}
    {view && <div className={styles.results}>
      <div className={styles.row} role="status"><span>{labels[view.run.status]} · {view.run.results.filter(task => task.status === 'completed' || task.status === 'failed').length}/8 题 · 模型请求 {view.run.modelCalls}</span>
        {running && <button className={styles.command} disabled={busy || view.cancelRequested} onClick={() => void action(async () => {
          const next = await request<OfficeBenchmarkView>(`/live/runs/${encodeURIComponent(view.run.id)}/cancel`, { method: 'POST', body: '{}' });
          if (alive.current) { setView(next); setReload(value => value + 1); }
        })}><Square size={15} />{view.cancelRequested ? '正在停止...' : '停止评测'}</button>}
      </div>
      <progress className={styles.progress} max={8} value={view.run.results.filter(task => task.status === 'completed' || task.status === 'failed').length} aria-label="八题评测进度" />
      <p className={styles.meta}>已知费用 ${view.run.usage.knownCost.toFixed(4)}{!view.run.usage.pricingKnown ? ' · 当前模型价格未知，以上不能视为总费用' : ''}{view.run.usage.unsettledRequests ? ` · ${view.run.usage.unsettledRequests} 次请求用量未确认` : ''} · {view.persistence === 'saved' ? '当前检查点已保存' : '结果未保存'}</p>
      {view.run.error && <p className={styles.error}>{view.run.error}</p>}
      {view.run.score && view.persistence === 'saved' && <p><strong>{view.run.score.totalScore} 分</strong> · 固定材料题通过率 {Math.round(view.run.score.passRate * 100)}%，不代表真实办公综合质量。</p>}
      {view.run.results.map(task => <details key={task.taskId}><summary>{task.grade?.passed ? <CheckCircle2 size={16} /> : task.status === 'pending' || task.status === 'running' ? <Circle size={16} /> : <XCircle size={16} />}<span>{task.title}</span><b>{task.grade ? `${task.grade.score} 分` : labels[task.status]}</b></summary>
        {task.error && <p>{task.error}</p>}
        <ul>{task.grade?.checks.map(check => <li key={check.id}>{check.passed ? '通过' : '未通过'} · {check.label}：{check.reason}</li>)}</ul>
        {task.output && <pre className={styles.output}>{task.output}</pre>}
      </details>)}
      <details><summary>执行记录 · {view.run.events.length} 条</summary><ol className={styles.trace}>{view.run.events.map(event => <li key={event.eventId}>{event.type} · {event.summary}</li>)}</ol></details>
    </div>}
  </section>;
}
