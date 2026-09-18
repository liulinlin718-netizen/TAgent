import { collectEvents, compareText, issue, scopeKey } from './events.js';
import { groupStages, isToolEvent } from './stages.js';
import { pairTools } from './tools.js';

const runTerminal = new Set(['complete', 'run_failed', 'run_interrupted', 'run_cancelled']);
const agentTerminal = new Set(['agent_complete', 'agent_failed', 'agent_cancelled']);
const agentActivity = new Set(['agent_spawn', 'agent_progress', 'agent_stage', ...agentTerminal]);

function terminalOutcome(event) {
  if (['run_interrupted', 'run_cancelled', 'agent_cancelled'].includes(event.type)
    || ['interrupted', 'cancelled'].includes(event.status)) return 'interrupted';
  if (['run_failed', 'agent_failed'].includes(event.type) || event.data?.success === false || event.status === 'failed') return 'failed';
  return event.data?.success === true ? 'succeeded' : 'unknown';
}

function outcome(events, terminalTypes, issues) {
  const terminals = events.filter(event => terminalTypes.has(event.type));
  if (!terminals.length) return { status: 'incomplete', terminalEventIds: [] };
  const dated = terminals.filter(event => event.timestamp !== null);
  const lastTime = dated.length ? Math.max(...dated.map(event => event.timestamp)) : null;
  const latest = terminals.filter(event => event.timestamp === null || event.timestamp === lastTime);
  const statuses = new Set(latest.map(terminalOutcome));
  if (statuses.size > 1) {
    issues.push(issue('ambiguous_terminal', 'warning', 'Terminal events disagree and their order is unknown; success cannot be established.', { eventId: latest[0].eventId }));
    return { status: 'unknown', terminalEventIds: latest.map(event => event.eventId) };
  }
  return { status: terminalOutcome(latest[0]), terminalEventIds: latest.map(event => event.eventId) };
}

function timeRange(events) {
  const times = events.filter(event => event.timestamp !== null).map(event => event.timestamp);
  return { first: times.length ? Math.min(...times) : null, last: times.length ? Math.max(...times) : null,
    missing: events.length - times.length };
}

function scope(event) { return { workspaceId: event.workspaceId ?? null, sessionId: event.sessionId ?? null, runId: event.runId ?? null }; }
function nodeKey(event) { return JSON.stringify([scopeKey(event), event.agentId, event.taskId ?? null]); }
function safeLabel(value, fallback) { return typeof value === 'string' && value.length <= 256 ? value : fallback; }

function buildAgents(events, issues, runKey) {
  const instances = new Map(), relatedByNode = new Map();
  for (const event of events) {
    if (!event.agentId) continue;
    const related = relatedByNode.get(nodeKey(event)) || []; related.push(event); relatedByNode.set(nodeKey(event), related);
    if (!agentActivity.has(event.type) && !isToolEvent(event)) continue;
    const key = nodeKey(event), bucket = instances.get(key) || []; bucket.push(event); instances.set(key, bucket);
  }
  const agents = [...instances].sort(([a], [b]) => compareText(a, b)).map(([key, activity]) => {
    const first = activity.find(event => event.type === 'agent_spawn') || activity[0];
    const related = relatedByNode.get(key);
    const snapshot = first.agentSnapshot?.id === first.agentId ? first.agentSnapshot : undefined;
    const references = new Map();
    for (const event of activity) {
      const parentAgentId = event.parentAgentId, parentTaskId = event.parentTaskId;
      if (parentAgentId || parentTaskId) references.set(JSON.stringify([parentAgentId ?? null, parentTaskId ?? null]), { parentAgentId, parentTaskId });
    }
    const parents = [...references.values()];
    if (parents.length > 1) issues.push(issue('conflicting_parent', 'warning', 'Agent instance has conflicting parent references; no parent was chosen.', { nodeId: key }));
    return { id: key, agentId: first.agentId, taskId: first.taskId ?? null,
      name: safeLabel(snapshot?.name ?? first.data?.agentName, first.agentId), role: safeLabel(snapshot?.role, null),
      outcome: outcome(activity, agentTerminal, issues), eventIds: related.map(event => event.eventId),
      stages: groupStages(related), time: timeRange(activity), parent: parents.length === 1 ? parents[0] : null,
      parentAmbiguous: parents.length > 1 };
  });
  const candidates = [], byAgent = new Map(), byTask = new Map(), byIdentity = new Map();
  for (const node of agents) {
    const agent = byAgent.get(node.agentId) || []; agent.push(node); byAgent.set(node.agentId, agent);
    const task = byTask.get(node.taskId) || []; task.push(node); byTask.set(node.taskId, task);
    byIdentity.set(JSON.stringify([node.agentId, node.taskId]), node);
  }
  for (const node of agents) {
    if (!node.parent || node.parentAmbiguous) continue;
    const exact = byIdentity.get(JSON.stringify([node.parent.parentAgentId, node.parent.parentTaskId]));
    const matching = node.parent.parentTaskId && node.parent.parentAgentId ? exact ? [exact] : []
      : node.parent.parentTaskId ? byTask.get(node.parent.parentTaskId) || [] : byAgent.get(node.parent.parentAgentId) || [];
    if (matching.length !== 1) {
      issues.push(issue(matching.length ? 'ambiguous_parent' : 'missing_parent', 'warning',
        'Parent reference does not resolve to one observed agent instance in this run.', { nodeId: node.id }));
    } else candidates.push({ from: matching[0].id, to: node.id, kind: 'parent' });
  }
  const parentOf = new Map(candidates.map(edge => [edge.to, edge.from])), finished = new Set(), cyclic = new Set();
  for (const start of parentOf.keys()) {
    const trail = [], positions = new Map(); let current = start;
    while (current !== undefined && !finished.has(current)) {
      if (positions.has(current)) { for (const node of trail.slice(positions.get(current))) cyclic.add(node); break; }
      positions.set(current, trail.length); trail.push(current); current = parentOf.get(current);
    }
    for (const node of trail) finished.add(node);
  }
  const edges = [];
  for (const edge of candidates) {
    if (cyclic.has(edge.to)) issues.push(issue('parent_cycle', 'warning', 'Cyclic parent relationship was excluded from the graph.', { nodeId: edge.to }));
    else edges.push(edge);
  }
  // Membership edges are explicitly not claims about delegation or execution order.
  for (const node of agents) edges.push({ from: `run:${runKey}`, to: node.id, kind: 'participates' });
  return { agents, edges };
}

export function modelForEvents(events) {
  const groups = new Map(), issues = [];
  for (const event of events) { const key = scopeKey(event), group = groups.get(key) || []; group.push(event); groups.set(key, group); }
  const runs = [...groups].sort(([a], [b]) => compareText(a, b)).map(([key, group]) => {
    const agents = buildAgents(group, issues, key), tools = pairTools(group); issues.push(...tools.issues);
    const runOutcome = outcome(group, runTerminal, issues);
    const terminalCosts = group.filter(event => runOutcome.terminalEventIds.includes(event.eventId))
      .map(event => event.cost ?? (typeof event.data?.totalCost === 'number' && Number.isFinite(event.data.totalCost) && event.data.totalCost >= 0 ? event.data.totalCost : null));
    const cost = terminalCosts.length && terminalCosts.every(value => value === terminalCosts[0]) ? terminalCosts[0] : null;
    return { key, scope: scope(group[0]), eventIds: group.map(event => event.eventId), outcome: runOutcome,
      time: timeRange(group), stages: groupStages(group), ...agents, tools: tools.interactions, recordedRunCost: cost,
      governance: group.filter(event => event.type === 'governance').map(event => ({ eventId: event.eventId,
        agentId: event.agentId ?? null, taskId: event.taskId ?? null, summary: event.summary,
        result: ['passed', 'blocked', 'warning'].includes(event.data?.result) ? event.data.result : 'unknown' })) };
  });
  return { runs, issues };
}

export function summarizeTrace(inputs) {
  const collected = collectEvents(inputs), model = modelForEvents(collected.events);
  return { version: 1, counts: collected.counts, runs: model.runs, issues: [...collected.issues, ...model.issues],
    note: 'Outcomes reflect explicit producer records, not independently verified task quality. Missing cost is unknown. JSONL is not tamper-proof audit evidence.' };
}
