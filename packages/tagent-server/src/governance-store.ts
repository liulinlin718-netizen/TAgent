import type { GovernanceRecord, GovernanceStats, WorkflowEvent } from '@tagent/core';
import type { Store } from './store.js';
import { WorkflowCatalog } from './workflow-catalog.js';

export interface LiveGovernanceRun { workspaceId: string; sessionId: string; runId: string; traces: WorkflowEvent[] }
export interface GovernanceFilter { agentId?: string; runId?: string; sessionId?: string; limit?: number; before?: string }
/** Read canonical message traces instead of maintaining a second, volatile audit log. */
export class GovernanceStore {
  private readonly catalog: WorkflowCatalog;
  constructor(store: Store, live: () => LiveGovernanceRun[], catalog?: WorkflowCatalog) {
    this.catalog = catalog || new WorkflowCatalog(store, live);
  }
  query(filter: GovernanceFilter = {}) {
    const runs = this.catalog.list();
    const events: GovernanceRecord[] = [], costTimeline: GovernanceStats['costTimeline'] = [];
    const seen = new Set<string>();
    for (const source of runs) {
      if ((filter.runId && source.runId !== filter.runId) || (filter.sessionId && source.sessionId !== filter.sessionId)) continue;
      if (!filter.agentId && source.persisted && typeof source.cost === 'number' && Number.isFinite(source.cost) && source.cost >= 0
        && Number.isFinite(Date.parse(source.message.timestamp))) costTimeline.push({ timestamp: Date.parse(source.message.timestamp), cost: source.cost, runId: source.runId });
      for (const trace of source.traces) {
        if (trace.type !== 'governance' || !trace.eventId || !Number.isFinite(trace.timestamp) || seen.has(trace.eventId) || trace.runId !== source.runId
          || trace.sessionId !== source.sessionId || !trace.agentId || (filter.agentId && trace.agentId !== filter.agentId)) continue;
        seen.add(trace.eventId);
        const data = trace.data || {}, snapshot = source.traces.find(event => event.type === 'agent_spawn' && event.agentId === trace.agentId && event.taskId === trace.taskId)?.agentSnapshot;
        const approval = data.approval as GovernanceRecord['approval'];
        events.push({ id: trace.eventId, timestamp: trace.timestamp, workspaceId: source.workspaceId, sessionId: source.sessionId,
          runId: source.runId, ...(trace.taskId ? { taskId: trace.taskId } : {}), agentId: trace.agentId, agentName: snapshot?.name || trace.agentId,
          policyType: String(data.policyType || 'unknown'), ruleName: String(data.ruleName || 'unknown'), severity: String(data.severity || 'info'),
          result: String(data.result || 'warning'), message: String(data.message || trace.summary),
          ...(typeof data.suggestion === 'string' ? { suggestion: data.suggestion } : {}),
          ...(validDecision(data.decision) ? { decision: structuredClone(data.decision) } : {}),
          ...(approval?.requestId && approval.runId === source.runId && approval.sessionId === source.sessionId ? { approval: structuredClone(approval) } : {}),
          persisted: source.persisted });
      }
    }
    events.sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
    const stats: GovernanceStats = { totalChecks: events.length, totalBlocked: 0, totalWarnings: 0, totalPassed: 0, byPolicyType: Object.create(null),
      costTimeline: costTimeline.sort((a, b) => a.timestamp - b.timestamp).slice(-100) };
    for (const event of events) {
      if (event.result === 'blocked') stats.totalBlocked++;
      if (event.result === 'warning') stats.totalWarnings++;
      if (event.result === 'passed') stats.totalPassed++;
      const type = stats.byPolicyType[event.policyType] ||= { checks: 0, blocked: 0 };
      type.checks++; if (event.result === 'blocked') type.blocked++;
    }
    let eligible = events;
    if (filter.before) {
      let cursor: unknown;
      try { cursor = JSON.parse(Buffer.from(filter.before, 'base64url').toString('utf8')); } catch { throw new Error('Invalid governance cursor'); }
      if (!Array.isArray(cursor) || cursor.length !== 2 || !Number.isFinite(cursor[0]) || typeof cursor[1] !== 'string') throw new Error('Invalid governance cursor');
      const [time, id] = cursor as [number, string]; eligible = events.filter(event => event.timestamp < time || (event.timestamp === time && event.id.localeCompare(id) < 0));
    }
    const limit = Math.max(1, Math.min(100, filter.limit || 50)), page = eligible.slice(0, limit), last = page.at(-1);
    return { events: page, stats, nextCursor: eligible.length > limit && last ? Buffer.from(JSON.stringify([last.timestamp, last.id])).toString('base64url') : null,
      note: '记录随来源任务保存，运行中的记录尚未完成最终保存。统计是已记录决策，不等于全部安全检查。成本为已保存任务的已知用量，不是账单。' };
  }
}

function validDecision(value: unknown): value is NonNullable<GovernanceRecord['decision']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const decision = value as NonNullable<GovernanceRecord['decision']>;
  return decision.policyVersion === 1 && typeof decision.template === 'string' && typeof decision.ruleId === 'string'
    && ['allow', 'stop', 'review', 'inform'].includes(decision.effect) && typeof decision.reason === 'string'
    && Array.isArray(decision.alternatives) && decision.alternatives.every(item => typeof item === 'string')
    && !!decision.inputs && typeof decision.inputs === 'object' && !Array.isArray(decision.inputs)
    && Object.values(decision.inputs).every(item => typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)));
}
