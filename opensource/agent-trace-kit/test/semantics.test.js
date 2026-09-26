import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectEvents, summarizeTrace } from '../src/index.js';
import { event } from './helpers.js';

test('unknown run buckets cannot establish shared agents, relationships, tool pairs or run totals', () => {
  const inputs = [event('parent', 'agent_spawn'),
    event('child', 'agent_spawn', { agentId: 'child', parentAgentId: 'agent-1' }),
    event('parent-again', 'agent_spawn'),
    event('call', 'tool_call', { toolName: 'search', callId: 'c' }),
    event('result', 'tool_result', { toolName: 'search', callId: 'c', data: { success: true } }),
    event('end', 'complete', { cost: 1, data: { success: true } })];
  for (const input of inputs) delete input.runId;
  const report = summarizeTrace(inputs), run = report.runs[0];
  assert.equal(run.scope.runId, null); assert.equal(run.scopeStatus, 'unassigned');
  assert.equal(run.outcome.status, 'unknown'); assert.equal(run.recordedRunCost, null);
  assert.deepEqual(run.edges, []); assert.equal(run.agents.length, 5);
  assert.ok(run.agents.every(agent => agent.eventIds.length === 1 && agent.outcome.status === 'unknown'));
  assert.ok(run.tools.every(tool => tool.correlation === 'none'));
  assert.deepEqual(run.outcome.terminalEventIds, ['end']);
  assert.equal(report.issues.filter(item => item.code === 'missing_run_id').length, inputs.length);
  assert.ok(report.issues.some(item => item.code === 'unassigned_scope'));

  // Explicit, caller-known scope supplementation restores only justified correlations.
  const scoped = summarizeTrace(inputs.map(input => ({ ...input, runId: 'known-run' }))).runs[0];
  assert.equal(scoped.scopeStatus, 'identified'); assert.equal(scoped.outcome.status, 'succeeded');
  assert.equal(scoped.edges.filter(edge => edge.kind === 'parent').length, 1);
  assert.equal(scoped.tools[0].correlation, 'call_id');
});

test('supported root/data aliases are semantic duplicates while original layouts remain available', () => {
  const root = event('same', 'tool_call', { workspaceId: 'w', toolName: 'search', callId: 'c', resultLength: 2,
    data: { args: { q: 'synthetic' }, extension: { value: 1 } } });
  const alias = { eventId: root.eventId, type: root.type, timestamp: root.timestamp, summary: root.summary,
    data: { ...root.data, workspaceId: 'w', runId: root.runId, sessionId: root.sessionId, taskId: root.taskId,
      agentId: root.agentId, tool: 'search', toolCallId: 'c', resultLength: 2 } };
  for (const inputs of [[root, alias], [alias, root]]) {
    const trace = collectEvents(inputs);
    assert.deepEqual(trace.counts, { input: 2, accepted: 1, invalid: 0, duplicates: 1, conflictingIdentities: 0 });
    assert.deepEqual(trace.events[0].data, root.data);
    assert.equal(trace.evidence.length, 2);
    assert.equal(trace.evidence.find(item => item.event.data.tool)?.event.data.tool, 'search');
  }
  const differentArgs = { ...alias, data: { ...alias.data, args: { q: 'different' } } };
  const differentExtension = { ...alias, data: { ...alias.data, extension: { value: 2 } } };
  for (const changed of [differentArgs, differentExtension]) {
    assert.equal(collectEvents([root, changed]).counts.conflictingIdentities, 1);
  }
  assert.equal(collectEvents([{ ...alias, toolName: 'other' }]).counts.invalid, 1);
});

test('replay statistics count every variant and quarantine stays permanent across permutations', () => {
  const a = event('same', 'complete', { data: { success: true } });
  const b = { ...a, data: { success: false } }, c = { ...a, summary: 'Third variant.' };
  const variants = [a, b, b, c, a, c];
  for (let offset = 0; offset < variants.length; offset++) {
    const rotated = [...variants.slice(offset), ...variants.slice(0, offset)];
    for (const inputs of [rotated, [...rotated].reverse()]) {
      const trace = collectEvents(inputs);
      assert.deepEqual(trace.counts, { input: 6, accepted: 0, invalid: 0, duplicates: 3, conflictingIdentities: 1 });
      assert.equal(trace.evidence.length, 6); assert.deepEqual(trace.events, []);
    }
  }
});

test('contradictory outcome fields are diagnosed with negative precedence, including tools', () => {
  for (const [status, expected] of [['blocked', 'unknown'], ['failed', 'failed'], ['interrupted', 'interrupted'],
    ['cancelled', 'interrupted'], ['running', 'unknown'], ['pending', 'unknown']]) {
    for (const type of ['complete', 'agent_complete', 'tool_result']) {
      const report = summarizeTrace([event('end', type, { status, toolName: 'search', callId: 'c', data: { success: true } })]);
      const run = report.runs[0];
      const actual = type === 'complete' ? run.outcome.status : type === 'agent_complete' ? run.agents[0].outcome.status : run.tools[0].resultOutcome;
      assert.equal(actual, type === 'tool_result' && expected === 'interrupted' ? 'unknown' : expected);
      const problem = report.issues.find(item => item.code === 'conflicting_outcome');
      assert.equal(problem.eventId, 'end'); assert.equal(problem.inputIndex, 0);
      assert.ok(problem.claims.some(claim => claim.field === 'status' && claim.value === status));
    }
  }
  const errorFlag = summarizeTrace([event('bad', 'complete', { data: { success: true, isError: true } })]);
  assert.equal(errorFlag.runs[0].outcome.status, 'failed');
  assert.ok(errorFlag.issues.some(item => item.code === 'conflicting_outcome'));
});

test('cost conflicts disclose candidate amounts and never choose one silently', () => {
  const report = summarizeTrace([event('end', 'complete', { status: 'blocked', cost: 1, data: { success: true, totalCost: 2 } })]);
  assert.equal(report.runs[0].outcome.status, 'unknown'); assert.equal(report.runs[0].recordedRunCost, null);
  assert.deepEqual(report.runs[0].costEvidence.map(item => item.value), [1, 2]);
  assert.ok(report.issues.some(item => item.code === 'conflicting_run_cost'));
  assert.ok(report.issues.some(item => item.code === 'conflicting_outcome'));
  assert.equal(summarizeTrace([event('zero', 'complete', { cost: 0, data: { totalCost: 0 } })]).runs[0].recordedRunCost, 0);
  assert.equal(summarizeTrace([event('unknown', 'complete')]).runs[0].recordedRunCost, null);
  const disagree = summarizeTrace([event('a', 'complete', { cost: 1 }), event('b', 'complete', { cost: 2 })]);
  assert.equal(disagree.runs[0].recordedRunCost, null);
  assert.ok(disagree.issues.some(item => item.code === 'conflicting_run_cost'));
  const malformed = summarizeTrace([event('end', 'complete', { cost: 1, data: { totalCost: { secret: 'not-for-stdout' } } })]);
  assert.equal(malformed.runs[0].recordedRunCost, null);
  assert.ok(malformed.issues.some(item => item.code === 'invalid_run_cost'));
  assert.equal(JSON.stringify(malformed).includes('not-for-stdout'), false);
});
