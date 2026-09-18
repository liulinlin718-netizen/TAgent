import type { WorkflowEvent as CoreWorkflowEvent, WorkflowEventStatus } from '@tagent/core';

export interface TraceEvent extends Partial<CoreWorkflowEvent> {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export type WorkflowStatus = WorkflowEventStatus;

export type WorkflowEvent = CoreWorkflowEvent & {
  status: WorkflowStatus;
  data: Record<string, unknown>;
};

export interface WorkflowGroup {
  id: string;
  kind: string;
  label: string;
  events: WorkflowEvent[];
}

export interface AgentCard {
  id: string;
  agentId?: string;
  taskId?: string;
  parentTaskId?: string;
  runId?: string;
  configurationRecorded?: boolean;
  acceptsUnscopedEvents?: boolean;
  role?: string;
  name: string;
  description: string;
  icon?: string;
  type?: string;
  parentAgentId?: string | null;
  state?: {
    business?: string;
    runtime?: string;
  } | string;
  capabilities?: {
    skills?: string[];
    tools?: string[];
    mcpServers?: string[];
  };
  constraints?: {
    maxCostPerTask?: number;
    allowedTools?: string[];
  };
  card?: {
    responsibilities?: string[];
    qualityChecks?: string[];
    outputStandards?: string[];
    scoreProfile?: Record<string, number>;
  };
  spawnMeta?: {
    objective?: string;
    createdReason?: string;
  };
}

export function toWorkflowEvent(trace: TraceEvent, index: number): WorkflowEvent {
  const data = trace.data || {};
  const type = trace.type;
  const agentId = trace.agentId || String(data.agentId || data.agentName || '');
  const toolName = trace.toolName || String(data.tool || data.toolName || '');
  const resultLength = trace.resultLength ?? readNumber(data.resultLength);
  const cost = trace.cost ?? readNumber(data.cost);
  const unsuccessful = data.success === false && (type === 'complete' || type === 'agent_complete');
  const status = unsuccessful ? statusForType(type, data) : trace.status || statusForType(type, data);

  return {
    eventId: trace.eventId || `${trace.timestamp ?? 0}-${index}-${type}`,
    sessionId: trace.sessionId,
    runId: trace.runId,
    taskId: trace.taskId || (typeof data.taskId === 'string' ? data.taskId : undefined),
    parentTaskId: trace.parentTaskId || (typeof data.parentTaskId === 'string' ? data.parentTaskId : undefined),
    agentSnapshot: trace.agentSnapshot,
    type,
    agentId: agentId || undefined,
    parentAgentId: trace.parentAgentId || String(data.parentAgentId || '') || undefined,
    status,
    summary: unsuccessful ? summaryForTrace(type, data) : trace.summary || summaryForTrace(type, data),
    timestamp: trace.timestamp ?? 0,
    cost,
    toolName: toolName || undefined,
    resultLength,
    data,
  };
}

export function groupFlowEvents(events: WorkflowEvent[]): WorkflowGroup[] {
  const groups = new Map<string, WorkflowGroup>();

  for (const event of events) {
    const kind = kindForWorkflowEvent(event);
    const existing = groups.get(kind);
    if (existing) {
      existing.events.push(event);
    } else {
      groups.set(kind, {
        id: `${kind}-${event.eventId}`,
        kind,
        label: labelForKind(kind),
        events: [event],
      });
    }
  }

  const order = ['task', 'dispatch', 'research', 'agent', 'tool', 'governance', 'synthesis', 'default'];
  return Array.from(groups.values()).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export function agentsForCurrentTask(_agents: AgentCard[], events: WorkflowEvent[]): AgentCard[] {
  const seen = new Set<string>();
  const instanceCounts = new Map<string, number>();
  const result: AgentCard[] = [];
  const executionEvents = events.filter(event => event.type === 'agent_spawn');
  executionEvents.push(...events.filter(event => event.type !== 'agent_spawn'));
  for (const event of executionEvents) {
    const rawId = event.agentId || String(event.data.agentId || '');
    const rawName = String(event.data.agentName || '');
    // A policy check can mention an agent that never actually executes.
    if ((!rawId && !rawName) || event.type === 'governance' || isOrchestrator(rawId || rawName)) continue;
    if (!event.type.startsWith('agent_') && !isToolEvent(event)) continue;

    const agentId = rawId || rawName;
    const identity = JSON.stringify([event.runId, agentId]);
    if (!event.taskId && instanceCounts.has(identity)) continue;
    const key = event.taskId ? JSON.stringify([event.runId || '', agentId, event.taskId]) : agentId;
    if (seen.has(key)) continue;
    seen.add(key);
    instanceCounts.set(identity, (instanceCounts.get(identity) || 0) + 1);

    const snapshot = event.agentSnapshot?.version === 1 && event.agentSnapshot.id === agentId ? event.agentSnapshot : undefined;
    result.push({
      id: key, agentId, taskId: event.taskId, parentTaskId: event.parentTaskId, runId: event.runId,
      configurationRecorded: !!snapshot, role: snapshot?.role,
      name: snapshot?.name || rawName || readableAgent(rawId),
      description: snapshot?.description || String(event.data.objective || event.summary || '未记录任务目标'),
      icon: snapshot?.icon || String(event.data.icon || '◆'),
      type: snapshot?.type || String(event.data.agentType || 'unknown'),
      parentAgentId: event.parentAgentId || snapshot?.parentAgentId,
      state: event.status === 'complete' ? 'complete' : event.status === 'failed' ? 'failed' : 'running',
      capabilities: snapshot ? structuredClone(snapshot.capabilities) : undefined,
      constraints: snapshot ? structuredClone(snapshot.constraints) : undefined,
      card: snapshot ? structuredClone(snapshot.card) : undefined,
    });
  }
  for (const agent of result) {
    agent.acceptsUnscopedEvents = instanceCounts.get(JSON.stringify([agent.runId, agent.agentId])) === 1;
  }
  return result;
}

export function isOrchestrator(id: string) {
  return id.toLowerCase() === 'orchestrator';
}

export function isToolCall(event: WorkflowEvent) {
  return event.type === 'agent_tool_call' || event.type === 'tool_call';
}

export function isToolEvent(event: WorkflowEvent) {
  return isToolCall(event) || event.type === 'agent_tool_result' || event.type === 'tool_result';
}

export function resolveEventAgentId(event: WorkflowEvent, agents: AgentCard[]): string | undefined {
  if (event.agentId && isOrchestrator(event.agentId)) return 'orchestrator';
  const candidates = agents.filter(agent => eventBelongsToAgent(event, agent));
  return candidates.length === 1 ? candidates[0].id : undefined;
}

function eventBelongsToAgent(event: WorkflowEvent, agent: AgentCard): boolean {
  if (event.runId && agent.runId && event.runId !== agent.runId) return false;
  const matches = event.agentId ? event.agentId.toLowerCase() === (agent.agentId || agent.id).toLowerCase()
    : String(event.data.agentName || '').toLowerCase() === agent.name.toLowerCase();
  if (!matches) return false;
  if (!agent.taskId) return true;
  return event.taskId ? event.taskId === agent.taskId : agent.acceptsUnscopedEvents === true;
}

export function eventsForAgent(agent: AgentCard, events: WorkflowEvent[]) {
  return events.filter(event => eventBelongsToAgent(event, agent));
}

// Index once per immutable trace snapshot. Ambiguous legacy events remain unassigned.
export function indexAgentEvents(agents: AgentCard[], events: WorkflowEvent[]) {
  type Bucket = { tasks: Map<string, AgentCard[]>; unscoped: AgentCard[]; wildcard: AgentCard[] };
  const identities = new Map<string, Bucket>();
  const byAgent = new Map(agents.map(agent => [agent.id, [] as WorkflowEvent[]]));
  const owners = new Map<WorkflowEvent, string | undefined>();
  for (const agent of agents) {
    for (const key of [`id:${(agent.agentId || agent.id).toLowerCase()}`, `name:${agent.name.toLowerCase()}`]) {
      const bucket: Bucket = identities.get(key) || { tasks: new Map(), unscoped: [], wildcard: [] };
      if (!agent.taskId) bucket.wildcard.push(agent);
      else {
        const task = bucket.tasks.get(agent.taskId) || [];
        task.push(agent);
        bucket.tasks.set(agent.taskId, task);
        if (agent.acceptsUnscopedEvents) bucket.unscoped.push(agent);
      }
      identities.set(key, bucket);
    }
  }
  for (const event of events) {
    const key = event.agentId ? `id:${event.agentId.toLowerCase()}` : `name:${String(event.data.agentName || '').toLowerCase()}`;
    const bucket = identities.get(key);
    const candidates = bucket ? [...bucket.wildcard, ...(event.taskId ? bucket.tasks.get(event.taskId) || [] : bucket.unscoped)]
      .filter(agent => eventBelongsToAgent(event, agent)) : [];
    for (const agent of candidates) byAgent.get(agent.id)!.push(event);
    owners.set(event, event.agentId && isOrchestrator(event.agentId) ? 'orchestrator' : candidates.length === 1 ? candidates[0].id : undefined);
  }
  return { byAgent, resolveOwner: (event: WorkflowEvent) => owners.get(event) };
}

export function parentForAgent(agent: AgentCard, agents: AgentCard[], events: WorkflowEvent[]) {
  const spawn = eventsForAgent(agent, events).find(event => event.type === 'agent_spawn');
  const parentId = spawn?.parentAgentId || agent.parentAgentId;
  if (!parentId || isOrchestrator(parentId)) return 'orchestrator';
  // Missing parents remain unknown, never reassigned to a different agent.
  const parentTaskId = spawn?.parentTaskId || agent.parentTaskId;
  // A first-generation child inherits a resident template, but is dispatched by the orchestrator.
  if (spawn?.data.dispatchedBy === 'orchestrator' && !parentTaskId) return 'orchestrator';
  const candidates = agents.filter(candidate => (candidate.agentId || candidate.id) === parentId && candidate.id !== agent.id
    && (!agent.runId || !candidate.runId || agent.runId === candidate.runId)
    && (!parentTaskId || candidate.taskId === parentTaskId));
  return candidates.length === 1 ? candidates[0].id : undefined;
}

export function groupToolEvents(agents: AgentCard[], events: WorkflowEvent[], resolveOwner = indexAgentEvents(agents, events).resolveOwner) {
  const groups = new Map<string, { id: string; agentId?: string; toolName: string; events: WorkflowEvent[]; calls: number; resultLength: number }>();
  for (const event of events) {
    if (!isToolEvent(event) || !event.toolName) continue;
    const agentId = resolveOwner(event);
    const id = JSON.stringify([event.runId || null, agentId || event.agentId || null, event.taskId || null, event.toolName]);
    const group = groups.get(id) || { id, agentId, toolName: event.toolName, events: [], calls: 0, resultLength: 0 };
    group.events.push(event);
    if (isToolCall(event)) group.calls += 1;
    else group.resultLength += event.resultLength || 0;
    groups.set(id, group);
  }
  return [...groups.values()];
}

export function taskDependencyEdges(agents: AgentCard[], events: WorkflowEvent[], resolveOwner = indexAgentEvents(agents, events).resolveOwner) {
  const assignments = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'agent_spawn' || !event.taskId) continue;
    const agentId = resolveOwner(event);
    if (agentId) assignments.set(JSON.stringify([event.runId || '', event.taskId]), agentId);
  }
  const relations = new Map<string, { source: string; target: string }>();
  for (const event of events) {
    if (event.type !== 'task_decomposition' || !Array.isArray(event.data.tasks)) continue;
    for (const task of event.data.tasks) {
      if (!task || typeof task.id !== 'string' || !Array.isArray(task.dependsOn)) continue;
      const target = assignments.get(JSON.stringify([event.runId || '', task.id]));
      for (const dependency of task.dependsOn) {
        const source = assignments.get(JSON.stringify([event.runId || '', dependency]));
        if (source && target && source !== target) relations.set(JSON.stringify([source, target]), { source, target });
      }
    }
  }
  return [...relations.values()];
}

export function runPresentation(events: WorkflowEvent[], isRunning: boolean) {
  const terminal = events.findLast(event => event.type === 'complete');
  if (terminal) {
    if (terminal.data.persistence === 'failed') return { active: false, label: '运行结束 · 保存失败' };
    if (terminal.data.termination) return { active: false, label: terminal.data.termination === 'interrupted' ? '服务中断 · 已恢复材料'
      : terminal.data.termination === 'storage_failure' ? '保存失败 · 已停止'
      : terminal.data.termination === 'deadline' ? '已超时停止'
      : terminal.data.termination === 'disconnected' ? '断连后已停止' : '已取消' };
    const unsuccessful = terminal.data.success === false || ['failed', 'warning', 'blocked'].includes(terminal.status);
    return { active: false, label: unsuccessful ? '已结束 · 未通过验收' : terminal.data.success === true ? '任务完成' : '运行已结束' };
  }
  return { active: isRunning, label: isRunning ? '运行中' : '未记录结束状态' };
}

export function agentRunStatus(events: WorkflowEvent[], isRunning: boolean): WorkflowStatus {
  const lifecycle = events.filter(event => ['agent_spawn', 'agent_complete', 'agent_failed'].includes(event.type));
  const latest = lifecycle.at(-1);
  if (latest?.type === 'agent_complete' || latest?.type === 'agent_failed') return latest.status;
  return isRunning ? 'running' : 'pending';
}

export function activeWorkflowGroups(events: WorkflowEvent[], isRunning: boolean): Set<string> {
  if (!runPresentation(events, isRunning).active) return new Set();
  const latestByAgent = new Map<string, WorkflowEvent>();
  for (const event of events) {
    if (event.type === 'governance' || event.type === 'task_decomposition') continue;
    const owner = JSON.stringify([event.runId || '', event.agentId || 'orchestrator', event.taskId || '']);
    if (event.type === 'agent_complete' || event.type === 'agent_failed') latestByAgent.delete(owner);
    else latestByAgent.set(owner, event);
  }
  return new Set([...latestByAgent.values()].map(kindForWorkflowEvent));
}

export function kindForWorkflowEvent(event: WorkflowEvent) {
  const stage = String(event.data.stage || '');
  if (event.type === 'agent_spawn' || (event.type === 'agent_stage' && ['understand', 'plan'].includes(stage))) return 'dispatch';
  if (event.type === 'agent_stage' && stage === 'verify') return 'governance';
  if (event.type === 'agent_stage' && ['synthesize', 'handoff'].includes(stage)) return 'synthesis';
  if (isToolEvent(event) && /^(web_research|web_search|read_url|browser_)/.test(event.toolName || '')) return 'research';
  return kindForEvent(event.type);
}

export function labelForKind(kind: string) {
  const labels: Record<string, string> = {
    task: '任务拆解',
    dispatch: '调度与规划',
    research: '联网调研',
    agent: 'Agent 流转',
    tool: '工具调用',
    governance: '治理检查',
    synthesis: '综合输出',
    default: '其他事件',
  };

  return labels[kind] || labels.default;
}

export function summaryForTrace(type: string, data: Record<string, unknown>) {
  switch (type) {
    case 'task_decomposition':
      return `任务拆解为 ${(data.tasks as unknown[])?.length || 0} 个子任务`;
    case 'agent_spawn':
      return `${data.agentName || data.agentId || 'Agent'} 接手：${truncate(String(data.objective || '等待目标'), 52)}`;
    case 'agent_progress':
    case 'iteration':
      return `${data.agentId || 'Agent'} 正在第 ${data.iteration || '?'} 轮推理`;
    case 'agent_stage':
      return String(data.summary || `${data.agentId || 'Agent'}：${data.stage || '执行中'}`);
    case 'agent_tool_call':
    case 'tool_call':
      return `${data.agentId || 'Agent'} 调用工具 ${data.tool || data.toolName || 'unknown'}`;
    case 'agent_tool_result':
    case 'tool_result':
      return `${data.tool || data.toolName || '工具'} 返回 ${data.resultLength || 0} 字符`;
    case 'governance':
      return String(data.message || data.summary || '治理检查已记录');
    case 'agent_complete':
      return data.success === false ? `${data.agentId || 'Agent'} 返回降级结果` : `${data.agentId || 'Agent'} 已完成`;
    case 'agent_failed':
    case 'error':
      return String(data.error || data.message || '执行失败');
    case 'synthesis_start':
      return '进入综合整理阶段';
    case 'complete':
      if (data.persistence === 'failed') return '运行结束，但结果保存失败';
      if (data.termination) return data.termination === 'interrupted' ? '服务中断，已恢复保存的材料'
        : data.termination === 'storage_failure' ? '保存失败，任务已停止'
        : data.termination === 'deadline' ? '任务超时，已停止'
        : data.termination === 'disconnected' ? '连接断开，任务已停止' : '任务已取消';
      return data.success === false ? '已返回结果，部分内容未通过验收' : data.success === true ? '任务完成' : '运行已结束';
    default:
      return String(data.summary || type);
  }
}

export function statusForType(type: string, data: Record<string, unknown>): WorkflowStatus {
  if (data.success === false && (type === 'complete' || type === 'agent_complete')) return data.researchAssessment ? 'warning' : 'failed';
  if (type.includes('failed') || type === 'error') return 'failed';
  if (type === 'governance') {
    const result = String(data.result || '').toLowerCase();
    const message = String(data.message || '').toLowerCase();
    if (result === 'blocked' || message.includes('fail') || message.includes('拒绝')) return 'blocked';
    if (result === 'warning' || message.includes('warning') || message.includes('风险')) return 'warning';
    return 'passed';
  }
  if (type === 'complete' || type === 'agent_complete' || type.endsWith('_result')) return 'complete';
  return 'running';
}

export function kindForEvent(type: string) {
  if (type === 'task_decomposition') return 'task';
  if (type.includes('tool')) return 'tool';
  if (type === 'governance') return 'governance';
  if (type === 'synthesis_start' || type === 'complete') return 'synthesis';
  if (type.includes('agent')) return 'agent';
  return 'default';
}

export function readableAgent(agentId: string) {
  return agentId
    .replace(/[-_]/g, ' ')
    .replace(/\bagent\b/gi, '')
    .trim()
    .replace(/\b\w/g, letter => letter.toUpperCase()) || 'Agent';
}

export function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
