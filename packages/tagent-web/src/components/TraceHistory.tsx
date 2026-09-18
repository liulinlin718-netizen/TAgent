'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, LoaderCircle, RefreshCw } from 'lucide-react';
import type { WorkflowTracePage, WorkflowTraceScope } from '@tagent/core';
import { readWorkflowPage } from '../lib/workflow-history';
import styles from './TraceHistory.module.css';
import { TableEventCalculation } from './TableCalculations';

const names: Record<string, string> = {
  context_loaded: '会话材料',
  task_decomposition: '任务拆解', synthesis_start: '开始综合', synthesis_complete: '综合完成',
  task_analysis: '任务拆解', task_dispatch: '任务调度', agent_spawn: '创建协作者', agent_start: '开始执行',
  agent_iteration: '推理阶段', agent_tool_call: '工具调用', agent_tool_result: '工具结果', agent_complete: '执行结束',
  governance: '治理检查', synthesis: '综合输出', complete: '任务结束', error: '异常', agent_stage: '执行阶段',
};
const agents: Record<string, string> = { 'research-agent': '研究助手', 'document-agent': '文档助手', 'data-agent': '数据分析',
  'project-agent': '项目管理', 'communication-agent': '沟通邮件', 'presentation-agent': '演示汇报' };
const statuses: Record<string, string> = { passed: '已通过', complete: '已完成', running: '进行中', warning: '需留意', failed: '失败', blocked: '已拦截', pending: '待执行', stopped: '已停止' };
const label = (labels: Record<string, string>, value: string) => Object.hasOwn(labels, value) ? labels[value] : value;

export default function TraceHistory({ scope }: { scope: WorkflowTraceScope }) {
  const [agentId, setAgentId] = useState('');
  const [type, setType] = useState('');
  const [facets, setFacets] = useState<{ agents: string[]; types: string[] }>({ agents: [], types: [] });
  return <section className={styles.history} aria-label="分页执行记录">
    <div className={styles.filters}>
      <label>协作者<select aria-label="筛选执行记录协作者" value={agentId} onChange={event => setAgentId(event.target.value)}>
        <option value="">全部协作者</option>
        {facets.agents.map(agent => <option key={agent} value={agent}>{label(agents, agent)}</option>)}
      </select></label>
      <label>行为<select aria-label="筛选执行记录行为" value={type} onChange={event => setType(event.target.value)}>
        <option value="">全部行为</option>
        {facets.types.map(item => <option key={item} value={item}>{label(names, item)}</option>)}
      </select></label>
    </div>
    <TracePage key={JSON.stringify([scope.workspaceId, scope.sessionId, scope.runId, agentId, type])}
      scope={scope} agentId={agentId} type={type} onFacets={setFacets} />
  </section>;
}

function TracePage({ scope, agentId, type, onFacets }: { scope: WorkflowTraceScope; agentId: string; type: string;
  onFacets: (facets: { agents: string[]; types: string[] }) => void }) {
  const { workspaceId, sessionId, runId } = scope;
  const [page, setPage] = useState<WorkflowTracePage | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(true);
  const [request, setRequest] = useState<{ version: number; cursor?: string }>({ version: 0 });
  useEffect(() => {
    const controller = new AbortController();
    void readWorkflowPage({ workspaceId, sessionId, runId }, { agentId, type, cursor: request.cursor },
      AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]))
      .then(result => {
        if (controller.signal.aborted) return;
        setPage(previous => {
          const events = request.cursor && previous ? [...previous.events, ...result.events] : result.events;
          return { ...result, events: [...new Map(events.map(event => [event.eventId, event])).values()] };
        });
        onFacets({ agents: result.agents, types: result.types }); setError('');
      }).catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '执行记录暂不可用，请重试。');
      }).finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [workspaceId, sessionId, runId, agentId, type, request, onFacets]);
  const load = (cursor?: string) => { setPending(true); setError(''); setRequest(value => ({ version: value.version + 1, cursor })); };
  return <>
    <div className={styles.meta}>
      <span aria-live="polite">{page ? `已加载 ${page.events.length} / ${page.total} 条` : pending ? '正在读取执行记录' : '执行记录未能加载'}</span>
      <button type="button" aria-label="刷新执行记录" title="刷新执行记录" onClick={() => load()} disabled={pending}>
        <RefreshCw size={15} aria-hidden="true" />
      </button>
    </div>
    {error && <div className={styles.error} role="alert"><span>{error}</span>
      <button type="button" disabled={pending} onClick={() => load(request.cursor)}><RefreshCw size={14} aria-hidden="true" />重试读取</button>
    </div>}
    {page && <>
      {!page.persisted && <p className={styles.notice}>运行记录尚未完整保存，以最终报告的保存状态为准。</p>}
      {page.rebuilt && <p className={styles.notice}>索引已从原始执行记录重新建立。</p>}
      {page.events.length ? <ol className={styles.events} tabIndex={0} aria-label="任务执行记录明细" aria-busy={pending}>
        {page.events.map(event => <li key={event.eventId} className={styles.event} data-status={event.status}>
          <details><summary><span>{label(names, event.type)}</span><span className={styles.text}>{event.summary}</span><ChevronDown size={14} aria-hidden="true" /></summary>
            <dl><dt>协作者</dt><dd>{event.agentId ? label(agents, event.agentId) : '主调度'}</dd><dt>状态</dt><dd>{event.status ? label(statuses, event.status) : '已记录'}</dd>
              <dt>事件标识</dt><dd>{event.eventId}</dd><dt>任务标识</dt><dd>{event.runId}</dd></dl>
            {event.type === 'agent_tool_result' && event.toolName === 'analyze_table' && event.data?.tableAnalysis !== undefined ? <>
              <TableEventCalculation value={event.data.tableAnalysis} context={{ eventId: event.eventId, runId: event.runId, agentId: event.agentId, taskId: event.taskId, persisted: page.persisted }} />
              <details><summary>原始事件数据</summary><pre tabIndex={0} aria-label="事件数据">{JSON.stringify(event.data || {}, null, 2)}</pre></details>
            </> : <pre tabIndex={0} aria-label="事件数据">{JSON.stringify(event.data || {}, null, 2)}</pre>}
          </details>
        </li>)}
      </ol> : <p className={styles.notice}>没有符合筛选条件的执行记录。</p>}
    </>}
    <div className={styles.footer}>
      {pending && <span role="status"><LoaderCircle size={14} className={styles.spin} aria-hidden="true" />读取中</span>}
      {page?.nextCursor && <button type="button" onClick={() => load(page.nextCursor!)} disabled={pending}><ChevronDown size={15} aria-hidden="true" />加载更多记录</button>}
    </div>
  </>;
}
