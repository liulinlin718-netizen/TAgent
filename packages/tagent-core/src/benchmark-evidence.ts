import type { WorkflowEvent } from './protocol.js';
import type { BenchmarkDimension } from './benchmark.js';

export interface AgentRunEvidenceSource {
  workspaceId: string;
  sessionId: string;
  runId: string;
  completedAt: string;
  title: string;
}
export interface AgentRunEvidenceInput {
  source: AgentRunEvidenceSource;
  events: WorkflowEvent[];
}
export interface AgentRunEvidenceReview {
  source: AgentRunEvidenceSource;
  agentId: string;
  taskIds: string[];
  checks: {
    id: string;
    dimension: BenchmarkDimension;
    label: string;
    status: 'passed' | 'failed' | 'unobserved';
    detail: string;
    eventIds: string[];
  }[];
}

/** Recorded behavior, not a task-quality score or an independently verified benchmark. */
export function reviewAgentRunEvidence(agentId: string, input: AgentRunEvidenceInput): AgentRunEvidenceReview {
  const { source, events } = input;
  if (!source?.runId || !source.sessionId || !source.workspaceId || !Number.isFinite(Date.parse(source.completedAt))
    || events.some(event => !event.eventId || event.runId !== source.runId || event.sessionId !== source.sessionId)
    || new Set(events.map(event => event.eventId)).size !== events.length) throw new Error('运行证据归属不完整或存在重复事件。');
  const own = events.filter(event => event.agentId === agentId);
  const spawns = own.filter(event => event.type === 'agent_spawn' && event.agentSnapshot?.id === agentId);
  if (!spawns.length) throw new Error('此运行没有该 Agent 的任务快照，不能归属评分。');
  if (new Set(spawns.map(event => event.taskId)).size !== spawns.length) throw new Error('任务快照实例重复，不能复核。');
  const terminal = events.filter(event => event.type === 'complete');
  if (terminal.length !== 1) throw new Error('运行尚未形成唯一终态，不能复核。');
  const completed = own.filter(event => event.type === 'agent_complete');
  const receipts = spawns.map(spawn => completed.filter(event => event.taskId === spawn.taskId));
  const uniqueCompleted = receipts.filter(matches => matches.length === 1).flat();
  const invalidReceipts = completed.some(event => !spawns.some(spawn => spawn.taskId === event.taskId))
    || receipts.some(matches => matches.length > 1);
  const calls = own.filter(event => event.type === 'agent_tool_call');
  const missingSnapshot = calls.filter(call => !spawns.some(spawn => spawn.taskId === call.taskId));
  const denied = calls.filter(call => {
    const snapshot = spawns.find(spawn => spawn.taskId === call.taskId)?.agentSnapshot;
    return snapshot && !snapshot.constraints.allowedTools.includes(call.toolName || String(call.data?.tool || ''));
  });
  const planned = spawns.filter(event => typeof event.data?.objective === 'string' && event.data.objective.trim());
  const failed = own.filter(event => event.type === 'agent_failed' || (event.type === 'agent_complete' && event.data?.success !== true));
  const allCompleted = !invalidReceipts && uniqueCompleted.length === spawns.length;
  const handoffs = uniqueCompleted.filter(event => typeof event.data?.outputSummary === 'string' && event.data.outputSummary.trim());
  const ids = (values: WorkflowEvent[]) => [...new Set(values.map(event => event.eventId))];
  return {
    source: structuredClone(source), agentId, taskIds: [...new Set(spawns.flatMap(event => event.taskId ? [event.taskId] : []))],
    checks: [
      { id: 'task-outcome', dimension: 'instruction_following', label: '执行收尾记录',
        status: failed.length || !allCompleted ? 'failed' : 'passed',
        detail: `${uniqueCompleted.length}/${spawns.length} 个任务有唯一完成回执；${invalidReceipts ? '存在重复或无归属回执；' : ''}回执不证明指令或内容质量合格。`, eventIds: ids([...completed, ...failed, ...terminal]) },
      { id: 'dispatch-plan', dimension: 'planning_decomposition', label: '任务分工目标',
        status: planned.length === spawns.length ? 'passed' : 'unobserved',
        detail: `${planned.length}/${spawns.length} 个执行实例保留了目标；不评价拆解策略优劣。`, eventIds: ids(planned) },
      { id: 'tool-requests', dimension: 'tool_use', label: '工具调用记录', status: calls.length ? 'passed' : 'unobserved',
        detail: `记录了 ${calls.length} 次工具请求；返回长度不证明工具成功或来源真实。`, eventIds: ids(calls) },
      { id: 'tool-policy', dimension: 'governance_safety', label: '工具请求与当时白名单',
        status: denied.length ? 'failed' : missingSnapshot.length || !calls.length ? 'unobserved' : 'passed',
        detail: denied.length ? `${denied.length} 次请求超出当时白名单；是否执行或被拦截需查看原任务。` : missingSnapshot.length ? '部分工具请求缺少同任务快照，无法判断。' : '只检查已记录请求；未发生的危险场景不能视为安全测试通过。',
        eventIds: ids(denied.length ? denied : calls) },
      { id: 'handoff-record', dimension: 'collaboration_handoff', label: '交接摘要记录',
        status: !invalidReceipts && handoffs.length === spawns.length ? 'passed' : 'unobserved',
        detail: `${handoffs.length}/${spawns.length} 个任务保存了交接摘要；不评价摘要完整性。`, eventIds: ids(handoffs) },
      { id: 'source-quality', dimension: 'research_verification', label: '来源与事实质量', status: 'unobserved',
        detail: '工具名、日期字样和 URL 不能证明事实核验；请查看原任务的来源核对结果。', eventIds: [] },
      { id: 'deliverable-quality', dimension: 'office_deliverable', label: '办公交付质量', status: 'unobserved',
        detail: '配置与执行回执不能替代完整交付物的金标准评测。', eventIds: [] },
    ],
  };
}
