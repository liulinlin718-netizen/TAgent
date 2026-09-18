'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, ArrowRight, CalendarClock, Check, Pencil, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import type { RuntimeOverview, ScheduledTask, ScheduledOccurrence } from '@tagent/core';
import { API_BASE, apiFetch } from '../../../lib/api-client';
import { useConversations } from '../../../components/ConversationProvider';
import type { Session, Workspace } from '../../../lib/conversations';
import { conversationKey } from '../../../lib/conversations';
import { AccessControl } from '../../../components/AccessGate';
import styles from './runtime.module.css';

interface ScheduleResponse { jobs: ScheduledTask[]; occurrences: ScheduledOccurrence[]; error?: string; note: string }
interface Form { id?: string; requestId?: string; revision?: number; name: string; taskMessage: string; workspaceId: string; intervalMinutes: string; firstRun: string; enabled: boolean }
const blank = (): Form => ({ name: '', taskMessage: '', workspaceId: '', intervalMinutes: '1440', firstRun: '', enabled: true });
const localTime = (time: number) => {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const formatTime = (time?: number) => time ? new Date(time).toLocaleString('zh-CN') : '暂无记录';
const states = { not_used: '尚未运行', idle: '空闲', running: '运行中', waiting: '等待确认', stalled: '暂未收到新事件' };
async function request<T>(path: string, signal: AbortSignal, method = 'GET', body?: unknown): Promise<T> {
  const response = await apiFetch(API_BASE + path, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.message || `请求失败（${response.status}）`);
  return data;
}

export default function RuntimePage() {
  const conversations = useConversations(), router = useRouter();
  const [overview, setOverview] = useState<RuntimeOverview>(), [schedules, setSchedules] = useState<ScheduleResponse>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [form, setForm] = useState<Form>(), [consent, setConsent] = useState(false);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const runtime = await request<RuntimeOverview>('/api/runtime', controller.signal);
        const jobs = await request<ScheduleResponse>('/api/cron', controller.signal);
        const spaces = await request<{ workspaces: Workspace[] }>('/api/workspaces', controller.signal);
        if (!controller.signal.aborted) { setOverview(runtime); setSchedules(jobs); setWorkspaces(spaces.workspaces); setLoading(false); }
      } catch (reason) {
        if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : '读取失败。'); setLoading(false); }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void load(), 15000);
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [revision]);
  const refresh = () => { setError(''); setRevision(value => value + 1); };
  async function perform(operation: (signal: AbortSignal) => Promise<void>) {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError('');
    try { await operation(controller.signal); if (!controller.signal.aborted) refresh(); }
    catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '操作失败，请刷新核对状态后重试。'); }
    finally { active.current = null; if (!controller.signal.aborted) setBusy(false); }
  }
  const change = <K extends keyof Form>(key: K, value: Form[K]) => { setConsent(false); setForm(previous => previous ? { ...previous, [key]: value } : previous); };
  const edit = (job?: ScheduledTask) => {
    setConsent(false);
    setForm(job ? { id: job.id, revision: job.revision, name: job.name, taskMessage: job.taskMessage, workspaceId: job.workspaceId,
      intervalMinutes: String(job.intervalMs / 60000), firstRun: localTime(Math.max(job.nextRun, Date.now() + 60000)), enabled: job.enabled }
      : { ...blank(), requestId: crypto.randomUUID(), workspaceId: workspaces[0]?.id || '', firstRun: localTime(Date.now() + 3600000) });
  };
  function save() {
    if (!form || !consent) return;
    const current = form;
    void perform(async signal => {
      await request('/api/cron' + (current.id ? `/${encodeURIComponent(current.id)}` : ''), signal, current.id ? 'PUT' : 'POST', {
        name: current.name, taskMessage: current.taskMessage, workspaceId: current.workspaceId, enabled: current.enabled,
        intervalMs: Number(current.intervalMinutes) * 60000, nextRun: new Date(current.firstRun).getTime(),
        revision: current.revision, requestId: current.requestId, execution: 'confirm_each_run', confirmed: true,
      });
      if (!signal.aborted) { setForm(undefined); setConsent(false); }
    });
  }
  function prepare(item: ScheduledOccurrence) {
    void perform(async signal => {
      const data = await request<{ session: Session & { workspaceId: string }; taskMessage: string; willExecute: boolean }>(
        `/api/cron/occurrences/${encodeURIComponent(item.id)}/prepare`, signal, 'POST', { confirmed: true });
      if (data.willExecute !== false || data.session.workspaceId !== item.workspaceId || data.session.scheduleOrigin?.occurrenceId !== item.id) throw new Error('待办会话回执不一致。');
      if (!signal.aborted) {
        await conversations.refreshWorkspaces(); await conversations.selectSession(item.workspaceId, data.session.id);
        const state = conversations.getState(), cached = state.entries[conversationKey(item.workspaceId, data.session.id)];
        if (!cached?.draft && !data.session.messages.length) conversations.setDraft(item.workspaceId, data.session.id, data.taskMessage);
        router.push('/');
      }
    });
  }
  const pending = schedules?.occurrences.filter(item => item.status === 'pending') || [];
  const history = schedules?.occurrences.filter(item => item.status !== 'pending').slice(-20).reverse() || [];
  const maxCost = Math.max(0.000001, ...(overview?.costTrend.map(day => day.cost) || []));
  return <div className={styles.container}>
    <header className={styles.header}><h1><Activity size={24} />运行与周期任务</h1><div className={styles.actions}><AccessControl />
      <button title="刷新运行状态" aria-label="刷新运行状态" disabled={busy} onClick={refresh}><RefreshCw size={18} /></button></div></header>
    {loading && <p role="status">正在读取运行记录...</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {overview && <>
      <dl className={styles.totals}>{[
        ['进行中', overview.activeRuns], ['已结束', overview.finishedRuns], ['失败 / 未完成', overview.failedRuns],
        ['结果状态未知', overview.unknownOutcomes], ['已知模型费用', `$${overview.knownCost.toFixed(5)}`],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className={styles.note}>{overview.note}{overview.runsWithoutCost > 0 && ` ${overview.runsWithoutCost}次任务没有费用记录。`}</p>
      <section><h2>Agent 状态</h2><div className={styles.tableScroll}><table><thead><tr><th>Agent</th><th>当前状态</th><th>最近事件</th><th>已完成 / 失败 / 未知</th></tr></thead>
        <tbody>{overview.agents.map(agent => <tr key={agent.id}><th>{agent.name}</th><td><span data-status={agent.status}>{states[agent.status]}</span></td>
          <td>{formatTime(agent.lastEventAt)}</td><td>{agent.completed} / {agent.failed} / {agent.unknown}</td></tr>)}</tbody></table></div></section>
      <div className={styles.columns}><section><h2>已记录模型费用</h2>{!overview.costTrend.length ? <p className={styles.note}>暂无历史费用。</p> :
        <ul className={styles.bars}>{overview.costTrend.map(day => <li key={day.date}><time>{day.date}</time><span className={styles.track}>
          <span style={{ width: `${Math.max(0, day.cost / maxCost * 100)}%` }} /></span><strong>${day.cost.toFixed(5)}</strong></li>)}</ul>}</section>
        <section><h2>工具调用</h2>{!overview.tools.length ? <p className={styles.note}>暂无工具记录。</p> : <div className={styles.tableScroll}><table><thead><tr><th>工具</th><th>调用 / 返回</th><th>平均耗时</th></tr></thead><tbody>
          {overview.tools.map(tool => <tr key={tool.name}><th>{tool.name}</th><td>{tool.calls} / {tool.results}</td><td>{tool.averageMs === undefined ? '未记录' : `${(tool.averageMs / 1000).toFixed(1)}秒`}</td></tr>)}
        </tbody></table></div>}</section></div>
    </>}
    <section><div className={styles.sectionHeader}><h2><CalendarClock size={19} />周期任务</h2>
      <button disabled={busy || !!form || !workspaces.length} onClick={() => edit()}><Plus size={16} />新建周期任务</button></div>
      <p className={styles.note}>{schedules?.note || '到期生成待办，每次发送任务由用户确认。'}</p>
      {schedules?.error && <p role="alert" className={styles.error}>{schedules.error}</p>}
      {form && <form className={styles.form} onSubmit={event => { event.preventDefault(); save(); }}>
        <fieldset disabled={busy}><legend>{form.id ? '编辑周期任务' : '新建周期任务'}</legend>
          <div className={styles.fields}><label>名称<input required maxLength={100} value={form.name} onChange={event => change('name', event.target.value)} /></label>
            <label>工作空间<select required value={form.workspaceId} onChange={event => change('workspaceId', event.target.value)}><option value="">选择工作空间</option>{workspaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label>
            <label>下次到期（本地时间）<input required type="datetime-local" value={form.firstRun} onChange={event => change('firstRun', event.target.value)} /></label>
            <label>重复间隔（分钟）<input required type="number" min={1} max={527040} step={1} value={form.intervalMinutes} onChange={event => change('intervalMinutes', event.target.value)} /></label></div>
          <label>办公任务<textarea required rows={4} maxLength={6000} value={form.taskMessage} onChange={event => change('taskMessage', event.target.value)} /></label>
          <label className={styles.checkbox}><input type="checkbox" checked={form.enabled} onChange={event => change('enabled', event.target.checked)} />启用到期提醒</label>
          <label className={styles.checkbox}><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />确认保存；到期不自动调用模型，修改会取消尚未打开的旧待办</label>
          <div className={styles.actions}><button type="submit" disabled={!consent}><Save size={16} />保存</button><button type="button" onClick={() => setForm(undefined)}><X size={16} />取消</button></div>
        </fieldset></form>}
      {schedules?.jobs.map(job => <article className={styles.job} key={job.id}><div><h3>{job.name}</h3>
        <p>{job.enabled ? '已启用' : '已暂停'} · 每{job.intervalMs / 60000}分钟 · 下次 {formatTime(job.nextRun)}</p>
        <details><summary>任务内容</summary><p className={styles.taskText}>{job.taskMessage}</p></details></div>
        <div className={styles.actions}><button aria-label={`编辑${job.name}`} title="编辑周期任务" disabled={busy || !!form} onClick={() => edit(job)}><Pencil size={16} /></button>
          <button aria-label={`删除${job.name}`} title="删除周期任务" disabled={busy} onClick={() => {
            if (confirm(`删除“${job.name}”及其未打开的待办？已有会话不删除。`)) void perform(async signal => { await request(`/api/cron/${encodeURIComponent(job.id)}`, signal, 'DELETE'); });
          }}><Trash2 size={16} /></button></div></article>)}
      {schedules && !schedules.jobs.length && !form && <p className={styles.note}>暂无周期任务。</p>}
    </section>
    <section><h2>待确认任务 · {pending.length}</h2>{pending.map(item => <article className={styles.job} key={item.id}>
      <div><h3>{item.name}</h3><p>到期 {formatTime(item.dueAt)}</p><details><summary>查看待办内容</summary><p className={styles.taskText}>{item.taskMessage}</p></details></div>
      <div className={styles.actions}><button disabled={busy} onClick={() => prepare(item)}><ArrowRight size={16} />打开待发送任务</button>
        <button disabled={busy} title="跳过本次" aria-label={`跳过${item.name}`} onClick={() => void perform(async signal => { await request(`/api/cron/occurrences/${encodeURIComponent(item.id)}/dismiss`, signal, 'POST'); })}><X size={16} /></button></div>
    </article>)}{!pending.length && <p className={styles.note}>暂无到期待办。</p>}</section>
    {!!history.length && <section><details><summary>最近处理记录</summary>{history.map(item => <div className={styles.job} key={item.id}><div>
      <strong>{item.name}</strong><p>{formatTime(item.dueAt)} · {item.status === 'prepared' ? '已准备会话，不代表已执行' : '已跳过或取消'}</p></div>
      {item.status === 'prepared' && <button disabled={busy} onClick={() => prepare(item)}><Check size={16} />打开会话</button>}</div>)}</details></section>}
  </div>;
}
