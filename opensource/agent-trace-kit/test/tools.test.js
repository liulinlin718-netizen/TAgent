import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTrace } from '../src/index.js';
import { event } from './helpers.js';

const tool = (id, kind, timestamp, fields = {}) => event(id, `agent_tool_${kind}`, { timestamp, toolName: 'search', ...fields });
const inspect = events => summarizeTrace(events).runs.flatMap(run => run.tools);

test('same-tool parallel responses pair by callId rather than arrival order', () => {
  const tools = inspect([tool('c1', 'call', 1, { callId: 'one' }), tool('c2', 'call', 2, { callId: 'two' }),
    tool('r2', 'result', 5, { callId: 'two' }), tool('r1', 'result', 9, { callId: 'one' })]);
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map(item => [item.callEventId, item.resultEventId, item.durationMs]), [['c1', 'r1', 8], ['c2', 'r2', 3]]);
  assert.equal(tools.every(item => item.correlation === 'call_id' && item.resultOutcome === 'unknown'), true);
});

test('identical call IDs in different tasks, agents and runs never cross-pair', () => {
  for (const scope of [{ taskId: 'other' }, { agentId: 'other' }, { runId: 'other' }, { sessionId: 'other' }]) {
    const tools = inspect([tool('c', 'call', 1, { callId: 'shared' }), tool('r', 'result', 2, { callId: 'shared', ...scope })]);
    assert.equal(tools.filter(item => item.state === 'returned').length, 0);
    assert.deepEqual(tools.map(item => item.state).sort(), ['orphan_result', 'pending']);
  }
});

test('legacy task-scoped single calls are marked inferred, not explicit or successful', () => {
  const report = summarizeTrace([tool('a', 'call', 1), tool('b', 'result', 4), tool('c', 'call', 5), tool('d', 'result', 7)]);
  assert.equal(report.runs[0].tools.length, 2);
  assert.equal(report.runs[0].tools.every(item => item.correlation === 'single_open_call' && item.resultOutcome === 'unknown'), true);
  assert.equal(report.issues.filter(item => item.code === 'inferred_tool_pair').length, 2);
});

test('anonymous overlapping calls are never FIFO-guessed', () => {
  const report = summarizeTrace([tool('a', 'call', 1), tool('b', 'call', 2), tool('c', 'result', 3), tool('d', 'result', 4)]);
  assert.equal(report.runs[0].tools.filter(item => item.state === 'returned').length, 0);
  assert.equal(report.runs[0].tools.every(item => item.durationMs === null), true);
  assert.equal(report.issues.some(item => item.code === 'ambiguous_legacy_pair'), true);
});

test('same-tool calls belonging to different tasks can each infer one local pair', () => {
  const tools = inspect([tool('c1', 'call', 1), tool('c2', 'call', 2, { taskId: 'other' }),
    tool('r2', 'result', 3, { taskId: 'other' }), tool('r1', 'result', 4)]);
  assert.deepEqual(tools.map(item => [item.callEventId, item.resultEventId]), [['c1', 'r1'], ['c2', 'r2']]);
});

test('reused call IDs, duplicate results and mismatched tool names remain ambiguous', () => {
  for (const entries of [
    [tool('a', 'call', 1), tool('b', 'call', 2), tool('c', 'result', 3)],
    [tool('a', 'call', 1), tool('b', 'result', 2), tool('c', 'result', 3)],
    [tool('a', 'call', 1), tool('b', 'result', 2, { toolName: 'different' })],
  ]) {
    const tools = inspect(entries.map(entry => ({ ...entry, callId: 'reused' })));
    assert.equal(tools.every(item => item.state === 'ambiguous'), true);
  }
});

test('missing/reversed timestamps keep explicit correlation but never manufacture duration', () => {
  for (const timestamp of [null, 0]) {
    const tools = inspect([tool('a', 'call', 1, { callId: 'c' }), tool('b', 'result', timestamp, { callId: 'c' })]);
    assert.equal(tools[0].state, 'returned'); assert.equal(tools[0].durationMs, null);
  }
  const legacy = inspect([tool('a', 'call', null), tool('b', 'result', 4)]);
  assert.equal(legacy.every(item => item.state === 'ambiguous'), true);
  assert.equal(inspect([tool('a', 'call', 1), tool('b', 'result', 1)]).some(item => item.state === 'returned'), false);
});

test('missing scope cannot match tool names across unrelated activities', () => {
  const noTask = [tool('a', 'call', 1), tool('b', 'result', 2)].map(({ taskId: _task, ...entry }) => entry);
  const noRun = [tool('a', 'call', 1, { callId: 'c' }), tool('b', 'result', 2, { callId: 'c' })].map(({ runId: _run, ...entry }) => entry);
  for (const input of [noTask, noRun]) assert.equal(inspect(input).some(item => item.state === 'returned'), false);
});

test('explicit failed result is recorded separately from transport return and interrupted run', () => {
  const report = summarizeTrace([tool('a', 'call', 1, { callId: 'c' }),
    tool('b', 'result', 2, { callId: 'c', data: { isError: true } }), event('end', 'run_interrupted', { timestamp: 3 })]);
  assert.equal(report.runs[0].tools[0].state, 'returned'); assert.equal(report.runs[0].tools[0].resultOutcome, 'failed');
  assert.equal(report.runs[0].outcome.status, 'interrupted');
});

test('an anonymous tied result cannot be ignored to pair the same call with a later result', () => {
  const tools = inspect([tool('a-result', 'result', 1), tool('z-call', 'call', 1), tool('later', 'result', 2)]);
  assert.equal(tools.length, 3); assert.equal(tools.every(item => item.state === 'ambiguous'), true);
});
