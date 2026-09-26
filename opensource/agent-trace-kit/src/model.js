import { collectEvents, compareText, eventKey, issue, ownedTrace, scopeKey, TraceInputError } from './events.js';
import { groupStages, isToolEvent } from './stages.js';
import { pairTools } from './tools.js';
import { recordedOutcome } from './outcomes.js';
import { compileFilter, createEventSelector } from './indexing.js';

const runTerminal = new Set(['complete', 'run_failed', 'run_interrupted', 'run_cancelled']);
const agentTerminal = new Set(['agent_complete', 'agent_failed', 'agent_cancelled']);
const agentActivity = new Set(['agent_spawn', 'agent_progress', 'agent_stage', ...agentTerminal]);

function outcome(events, terminalTypes, issues) {
  const terminals = events.filter(event => terminalTypes.has(event.type));
  const outcomes = new Map(terminals.map(event => [event, recordedOutcome(event, issues)]));
  if (!events[0]?.runId) return { status: 'unknown', terminalEventIds: terminals.map(event => event.eventId) };
  if (!terminals.length) return { status: 'incomplete', terminalEventIds: [] };
  const dated = terminals.filter(event => event.timestamp !== null);
  const lastTime = dated.length ? Math.max(...dated.map(event => event.timestamp)) : null;
  const latest = terminals.filter(event => event.timestamp === null || event.timestamp === lastTime);
  const statuses = new Set(latest.map(event => outcomes.get(event)));
  if (statuses.size > 1) {
    issues.push(issue('ambiguous_terminal', 'warning', 'Terminal events disagree and their order is unknown; success cannot be established.', { eventId: latest[0].eventId }));
    return { status: 'unknown', terminalEventIds: latest.map(event => event.eventId) };
  }
  return { status: outcomes.get(latest[0]), terminalEventIds: latest.map(event => event.eventId) };
}

function timeRange(events) {
  const times = events.filter(event => event.timestamp !== null).map(event => event.timestamp);
  return { first: times.length ? Math.min(...times) : null, last: times.length ? Math.max(...times) : null,
    missing: events.length - times.length };
}

function scope(event) { return { workspaceId: event.workspaceId ?? null, sessionId: event.sessionId ?? null, runId: event.runId ?? null }; }
function nodeKey(event) {
  const identity = [scopeKey(event), event.agentId, event.taskId ?? null];
  // Without a run ID, even repeated agent IDs cannot establish one shared instance.
  if (!event.runId) identity.push(event.eventId);
  return JSON.stringify(identity);
}
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
  if (!events[0]?.runId) return { agents, edges: [] };
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

function runCost(events, terminalIds, issues) {
  const selected = new Set(terminalIds), values = [], evidence = [];
  let invalid = false;
  for (const event of events) {
    if (!selected.has(event.eventId)) continue;
    const candidates = [];
    for (const [field, value] of [['cost', event.cost], ['data.totalCost', event.data?.totalCost]]) {
      if (value === undefined) continue;
      evidence.push({ eventId: event.eventId, field, value: typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null });
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        invalid = true;
        issues.push(issue('invalid_run_cost', 'warning', 'Recorded total cost is not a nonnegative finite number.',
          { eventId: event.eventId, runKey: scopeKey(event) }));
      } else candidates.push(value);
    }
    if (new Set(candidates).size > 1) {
      invalid = true;
      issues.push(issue('conflicting_run_cost', 'warning', 'Root cost and data.totalCost disagree; recorded run cost is unknown.',
        { eventId: event.eventId, runKey: scopeKey(event), claims: [{ field: 'cost', value: event.cost }, { field: 'data.totalCost', value: event.data.totalCost }] }));
    }
    values.push(candidates[0] ?? null);
  }
  if (new Set(values.filter(value => value !== null)).size > 1) {
    invalid = true;
    issues.push(issue('conflicting_run_cost', 'warning', 'Incomparable terminal records disagree on total cost; no total was chosen.',
      { runKey: scopeKey(events[0]) }));
  }
  return { recordedRunCost: events[0]?.runId && !invalid && values.length && values.every(value => value === values[0]) ? values[0] : null,
    costEvidence: evidence };
}

export function modelForEvents(events) {
  const groups = new Map(), issues = [];
  for (const event of events) { const key = scopeKey(event), group = groups.get(key) || []; group.push(event); groups.set(key, group); }
  const runs = [...groups].sort(([a], [b]) => compareText(a, b)).map(([key, group]) => {
    if (!group[0].runId) issues.push(issue('unassigned_scope', 'warning',
      'These events share only an unknown scope bucket, not a confirmed run. No aggregate outcome or relationships were inferred.', { runKey: key }));
    const issueStart = issues.length;
    const agents = buildAgents(group, issues, key), tools = pairTools(group); issues.push(...tools.issues);
    const runOutcome = outcome(group, runTerminal, issues);
    const costs = runCost(group, runOutcome.terminalEventIds, issues);
    for (let i = issueStart; i < issues.length; i++) issues[i].runKey ??= key;
    return { key, scope: scope(group[0]), scopeStatus: group[0].runId ? 'identified' : 'unassigned',
      eventIds: group.map(event => event.eventId), outcome: runOutcome,
      time: timeRange(group), stages: groupStages(group), ...agents, tools: tools.interactions, ...costs,
      governance: group.filter(event => event.type === 'governance').map(event => ({ eventId: event.eventId,
        agentId: event.agentId ?? null, taskId: event.taskId ?? null, summary: event.summary,
        result: ['passed', 'blocked', 'warning'].includes(event.data?.result) ? event.data.result : 'unknown' })) };
  });
  return { runs, issues };
}

export function summarizeTrace(inputs) {
  return analyzeCollectedTrace(collectEvents(inputs));
}

/** Analyze a library-owned batch without losing ingestion diagnostics or revalidating events. */
export function analyzeCollectedTrace(trace, filter = {}) {
  const collected = ownedTrace(trace);
  if (!collected) throw new TraceInputError('untrusted_batch', 'Use the complete result of collectEvents or readTraceFile; raw events belong in summarizeTrace.');
  const entries = compileFilter(filter), filtered = entries.length > 0;
  const events = filtered ? createEventSelector(collected.events).selectEntries(entries).map(position => collected.events[position]) : collected.events;
  const model = modelForEvents(events), sources = new Map();
  for (const item of collected.evidence) {
    if (item.event && !sources.has(eventKey(item.event))) sources.set(eventKey(item.event), item.source);
  }
  const diagnostics = model.issues.map(item => {
    const source = item.eventId && item.runKey ? sources.get(JSON.stringify([item.runKey, item.eventId])) : undefined;
    return source ? { ...item, ...source } : item;
  });
  return { version: 1, counts: structuredClone(collected.counts), runs: model.runs,
    issues: [...structuredClone(collected.issues), ...diagnostics], filtered, selectedEventCount: events.length,
    note: `${filtered ? 'Partial evidence: outcomes describe only selected events, not the complete run. ' : ''}Outcomes reflect explicit producer records, not independently verified task quality. Missing cost is unknown. JSONL is not tamper-proof audit evidence.` };
}
