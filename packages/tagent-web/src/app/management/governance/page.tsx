'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { ArrowDown, ArrowUpRight, CheckCircle, CircleAlert, Filter, RefreshCw, Shield, ShieldX } from 'lucide-react';
import type { GovernanceRecord, GovernanceStats } from '@tagent/core';
import { API_BASE, apiFetch } from '../../../lib/api-client';
import { AccessControl } from '../../../components/AccessGate';
import { useConversations } from '../../../components/ConversationProvider';
import styles from './governance.module.css';

type ResponseData = { events: GovernanceRecord[]; stats: GovernanceStats; nextCursor: string | null; note: string };
const policyNames: Record<string, string> = { approval: '执行确认', resource: '资源与预算', security: '安全边界',
  quality: '交付质量', alignment: '任务方向', organization: '协作规则' };
const decisions: Record<string, string> = { pending: '等待确认', approved: '本次已许可', denied: '本次已拒绝',
  expired: '超时拒绝', cancelled: '许可已失效', failed: '未取得许可' };
const date = (time: number) => new Date(time).toLocaleString('zh-CN', { hour12: false });
const policyName = (type: string) => Object.hasOwn(policyNames, type) ? policyNames[type] : type;

export default function GovernancePage() {
  const router = useRouter(), conversations = useConversations();
  const [data, setData] = useState<ResponseData | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [fields, setFields] = useState({ sessionId: '', runId: '', agentId: '' });
  const [query, setQuery] = useState(''), [cursor, setCursor] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(query);
    params.set('limit', '30');
    if (cursor) params.set('before', cursor);
    void apiFetch(API_BASE + '/api/governance/events?' + params, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    }).then(async response => {
      if (!response.ok) throw new Error('治理记录读取失败（HTTP ' + response.status + '），请稍后重试。');
      const value: ResponseData = await response.json();
      if (!controller.signal.aborted) {
        setData(previous => ({ ...value, events: cursor && previous
          ? [...previous.events, ...value.events.filter(event => !previous.events.some(old => old.id === event.id))]
          : value.events }));
        setError('');
      }
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '治理记录读取失败');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, cursor, revision]);
  const refresh = () => { setLoading(true); setCursor(''); setRevision(value => value + 1); };
  const stats = data?.stats;
  const totals = [
    { label: '已记录决策', value: stats?.totalChecks, icon: Shield },
    { label: '拦截 / 拒绝记录', value: stats?.totalBlocked, icon: ShieldX },
    { label: '预警 / 待确认记录', value: stats?.totalWarnings, icon: CircleAlert },
    { label: '通过 / 许可记录', value: stats?.totalPassed, icon: CheckCircle },
  ];
  return <div className={styles.container}>
    <header className={styles.header}>
      <h1><Shield size={24} />治理记录</h1>
      <div className={styles.actions}><AccessControl />
        <button onClick={refresh} disabled={loading} title="刷新治理记录" aria-label="刷新治理记录"><RefreshCw size={17} /></button>
      </div>
    </header>
    <details className={styles.filters}>
      <summary><Filter size={16} />按任务或 Agent 筛选</summary>
      <form onSubmit={event => {
        event.preventDefault();
        setQuery(new URLSearchParams(Object.entries(fields).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim()])).toString());
        refresh();
      }}>
        {(['sessionId', 'runId', 'agentId'] as const).map((key, i) => <label key={key}>
          {['会话 ID', '任务 ID', 'Agent ID'][i]}
          <input value={fields[key]} onChange={event => setFields(value => ({ ...value, [key]: event.target.value }))} maxLength={200} />
        </label>)}
        <button type="submit" disabled={loading}><Filter size={16} />筛选</button>
        <button type="button" disabled={loading} onClick={() => { setFields({ sessionId: '', runId: '', agentId: '' }); setQuery(''); refresh(); }}>清除筛选</button>
      </form>
    </details>
    {error && <p className={styles.error} role="alert">{error}{data ? ' 当前保留上次成功读取的数据。' : ''}</p>}
    {loading && <p role="status" className={styles.note}>正在读取治理记录...</p>}
    <main aria-busy={loading}>
      <dl className={styles.stats}>
        {totals.map(({ label, value, icon: Icon }) => <div key={label}><dt><Icon size={16} />{label}</dt><dd>{value ?? '-'}</dd></div>)}
      </dl>
      {data && <p className={styles.note}>{data.note}</p>}
      <div className={styles.charts}>
        <section aria-label="任务成本">
          <h2>已保存任务的已知成本</h2>
          <div className={styles.chart}>
            {stats?.costTimeline.length ? <ResponsiveContainer width="100%" height={200} initialDimension={{ width: 300, height: 200 }}>
              <LineChart data={stats.costTimeline} margin={{ top: 8, right: 14, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                <XAxis dataKey="timestamp" tickFormatter={time => new Date(time).toLocaleDateString('zh-CN')} tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }} minTickGap={35} />
                <YAxis width={75} tickFormatter={value => '$' + (Number(value) === 0 ? '0' : Number(value).toPrecision(2))} tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }} />
                <Tooltip labelFormatter={time => date(Number(time))} formatter={value => ['$' + Number(value).toFixed(5), '本次任务']}
                  contentStyle={{ background: 'var(--color-bg-surface)', color: 'var(--color-text-primary)', borderRadius: 6 }} />
                <Line type="linear" dataKey="cost" stroke="#0d9488" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer> : <p className={styles.empty}>{query.includes('agentId=') ? '任务总成本不能归为单个 Agent，当前不展示成本趋势。' : '暂无符合条件的已保存成本记录。'}</p>}
          </div>
          {!!stats?.costTimeline.length && <details><summary>成本明细（最近100个已保存任务）</summary>
            <div className={styles.costRows}>{stats.costTimeline.map(item => <p key={item.runId}>
              <time>{date(item.timestamp)}</time><code>{item.runId}</code><strong>${item.cost.toFixed(5)}</strong>
            </p>)}</div>
          </details>}
        </section>
        <section aria-label="规则分布">
          <h2>规则记录分布</h2>
          <dl className={styles.policies}>{Object.entries(stats?.byPolicyType || {}).map(([type, value]) => <div key={type}>
            <dt>{policyName(type)}</dt><dd>{value.checks} 条 <span> / {value.blocked} 条拦截</span></dd>
          </div>)}</dl>
          {stats && !Object.keys(stats.byPolicyType).length && <p className={styles.empty}>暂无规则记录。</p>}
        </section>
      </div>
      <section className={styles.history} aria-label="治理决策记录">
        <h2>决策记录 <span>{data?.events.length || 0} 条已加载</span></h2>
        {data?.events.map(event => {
          const blocked = event.result === 'blocked', passed = event.result === 'passed';
          const Icon = blocked ? ShieldX : passed ? CheckCircle : CircleAlert;
          return <article key={event.id} className={styles.record} data-result={event.result} data-event-id={event.id}>
            <header><strong><Icon size={17} />{event.approval ? event.approval.status === 'pending' && event.persisted ? '当时等待确认' : decisions[event.approval.status] : blocked ? '已拦截' : passed ? '规则通过' : '预警'}</strong>
              <time dateTime={new Date(event.timestamp).toISOString()}>{date(event.timestamp)}</time>
            </header>
            <p>{event.message}</p>
            <dl className={styles.metadata}>
              <div><dt>执行者</dt><dd>{event.agentName}</dd></div>
              <div><dt>触发规则</dt><dd>{policyName(event.policyType)} · {event.ruleName}</dd></div>
              <div><dt>保存状态</dt><dd>{event.persisted ? '已随任务保存' : '运行中，待最终保存'}</dd></div>
            </dl>
            {event.suggestion && <p className={styles.suggestion}>替代建议：{event.suggestion}</p>}
            <details><summary>查看任务与决定详情</summary>
              {event.decision && <dl className={styles.metadata}>
                <div><dt>规则版本</dt><dd>{event.decision.ruleId} · v{event.decision.policyVersion} · {event.decision.template}</dd></div>
                <div><dt>处置</dt><dd>{{ allow: '允许继续', stop: '停止后续操作', review: '保留问题待复核', inform: '提示，不追加操作' }[event.decision.effect]}</dd></div>
                <div><dt>判断依据</dt><dd>{event.decision.reason}</dd></div>
                {Object.entries(event.decision.inputs).map(([key, value]) => <div key={key}><dt>{({ currentCost: '已知费用', maxCost: '任务预算', currentIterations: '已用轮数', maxIterations: '轮数上限', toolName: '工具', approvalMode: '审批模式', allowed: '在白名单内', fissionDepth: '当前层数', maxFissionDepth: '层数上限', deliveryStatus: '交付核对状态', independentSources: '独立发布方数', activeAgentCount: '活跃Agent数', maxAgents: 'Agent上限' } as Record<string, string>)[key] || key}</dt><dd>{String(value)}</dd></div>)}
              </dl>}
              <dl className={styles.metadata}><div><dt>会话</dt><dd><code>{event.sessionId}</code></dd></div>
                <div><dt>任务</dt><dd><code>{event.runId}</code>{event.taskId ? ' / ' + event.taskId : ''}</dd></div>
                <div><dt>事件</dt><dd><code>{event.id}</code></dd></div></dl>
              {event.approval && <><p>{event.approval.toolName} · {event.approval.redacted ? '已脱敏的参数预览' : '参数预览'}{event.approval.truncated ? '（不完整，不能批准）' : ''}</p>
                <pre>{event.approval.argsPreview}</pre></>}
            </details>
            <footer><button onClick={() => { conversations.selectSession(event.workspaceId, event.sessionId); router.push('/'); }}>
              <ArrowUpRight size={16} />查看来源任务</button></footer>
          </article>;
        })}
        {data && !data.events.length && <p className={styles.empty}>没有符合条件的治理记录。</p>}
        {data?.nextCursor && <button className={styles.more} disabled={loading} onClick={() => { setLoading(true); setCursor(data.nextCursor!); }}>
          <ArrowDown size={16} />加载更早记录</button>}
      </section>
    </main>
  </div>;
}
