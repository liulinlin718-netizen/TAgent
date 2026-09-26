import { compareEvents, compareText, issue, scopeKey } from './events.js';
import { isToolCall, isToolEvent, isToolResult } from './stages.js';
import { recordedOutcome } from './outcomes.js';

function outcome(event) {
  const status = recordedOutcome(event);
  return status === 'interrupted' ? 'unknown' : status;
}

function unmatched(event, state) {
  return { id: JSON.stringify([scopeKey(event), event.eventId]), agentId: event.agentId, taskId: event.taskId,
    callId: event.callId, toolName: event.toolName, state, correlation: 'none',
    eventIds: [event.eventId], ...(isToolCall(event) ? { callEventId: event.eventId } : { resultEventId: event.eventId }),
    durationMs: null, resultOutcome: isToolResult(event) ? outcome(event) : 'unknown' };
}

function matched(call, result, correlation, issues) {
  let durationMs = null;
  if (call.timestamp !== null && result.timestamp !== null && result.timestamp >= call.timestamp) durationMs = result.timestamp - call.timestamp;
  else issues.push(issue('unknown_tool_duration', 'warning', 'Paired tool events have missing or reversed timestamps; duration is unknown.', { eventId: result.eventId }));
  if (correlation === 'single_open_call') issues.push(issue('inferred_tool_pair', 'warning',
    'Legacy pair inferred from a single open call in the same run/task/agent/tool scope; add callId for explicit correlation.', { eventId: result.eventId }));
  return { id: JSON.stringify([scopeKey(call), call.eventId]), agentId: call.agentId, taskId: call.taskId,
    callId: call.callId, toolName: call.toolName, state: 'returned', correlation,
    eventIds: [call.eventId, result.eventId], callEventId: call.eventId, resultEventId: result.eventId,
    durationMs, resultOutcome: outcome(result) };
}

/** callId wins; anonymous legacy calls are never paired across task or agent scopes. */
export function pairTools(events) {
  const explicit = new Map(), legacy = new Map(), interactions = [], issues = [];
  for (const event of events.filter(isToolEvent)) {
    if (isToolResult(event)) recordedOutcome(event, issues);
    if (!event.runId || !event.agentId || !event.toolName || (!event.callId && !event.taskId)) {
      interactions.push(unmatched(event, isToolCall(event) ? 'pending' : 'orphan_result'));
      issues.push(issue('unscoped_tool_event', 'warning', 'Tool correlation requires runId, agentId, toolName and either callId or taskId.', { eventId: event.eventId }));
      continue;
    }
    const target = event.callId ? explicit : legacy;
    const key = JSON.stringify([scopeKey(event), event.agentId, event.taskId ?? null, event.callId ?? event.toolName]);
    const group = target.get(key) || []; group.push(event); target.set(key, group);
  }
  for (const group of explicit.values()) {
    const calls = group.filter(isToolCall), results = group.filter(isToolResult);
    if (calls.length === 1 && results.length === 1 && calls[0].toolName === results[0].toolName) {
      interactions.push(matched(calls[0], results[0], 'call_id', issues));
    } else if (calls.length > 1 || results.length > 1 || (calls.length && results.length)) {
      issues.push(issue('ambiguous_call_id', 'warning', 'Call identity is reused or tool names disagree; no call/result association was guessed.', { eventId: group[0].eventId }));
      interactions.push(...group.map(event => unmatched(event, 'ambiguous')));
    } else {
      interactions.push(...group.map(event => unmatched(event, isToolCall(event) ? 'pending' : 'orphan_result')));
      issues.push(issue(calls.length ? 'missing_tool_result' : 'orphan_tool_result', 'warning',
        calls.length ? 'No result was recorded for this tool call.' : 'No matching call was recorded for this result.', { eventId: group[0].eventId }));
    }
  }
  for (const group of legacy.values()) {
    const kindsByTime = new Map();
    for (const event of group) kindsByTime.set(event.timestamp, (kindsByTime.get(event.timestamp) || 0) | (isToolCall(event) ? 1 : 2));
    if (group.some(event => event.timestamp === null) || [...kindsByTime.values()].some(kinds => kinds === 3)) {
      issues.push(issue('ambiguous_legacy_timing', 'warning', 'Legacy calls/results with missing or tied timestamps cannot be ordered safely.', { eventId: group[0].eventId }));
      interactions.push(...group.map(event => unmatched(event, 'ambiguous')));
      continue;
    }
    const pending = [];
    let ambiguous = false;
    for (const event of [...group].sort(compareEvents)) {
      if (isToolCall(event)) { pending.push(event); continue; }
      if (!ambiguous && pending.length === 1 && pending[0].timestamp < event.timestamp) {
        interactions.push(matched(pending.shift(), event, 'single_open_call', issues));
      } else {
        if (pending.length) ambiguous = true;
        interactions.push(unmatched(event, ambiguous ? 'ambiguous' : 'orphan_result'));
        issues.push(issue(ambiguous ? 'ambiguous_legacy_pair' : 'orphan_tool_result', 'warning',
          'No unique earlier anonymous call can be established; no FIFO guess was made.', { eventId: event.eventId }));
      }
    }
    for (const event of pending) {
      interactions.push(unmatched(event, ambiguous ? 'ambiguous' : 'pending'));
      issues.push(issue('missing_tool_result', 'warning', 'No unambiguous result was recorded for this call.', { eventId: event.eventId }));
    }
  }
  interactions.sort((a, b) => compareText(a.id, b.id));
  return { interactions, issues };
}
