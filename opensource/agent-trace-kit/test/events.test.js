import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, collectEvents, createTraceIndex, summarizeTrace } from '../src/index.js';
import { event } from './helpers.js';

test('normalizes TAgent data aliases and retains unknown event types without inventing success', () => {
  const result = normalizeEvent({ eventId: 'new', type: 'future_step', timestamp: 100, summary: 'A future event.',
    data: { agentId: 'research', taskId: 'a', runId: 'run', tool: 'search', toolCallId: 'c', success: true } });
  assert.equal(result.event.agentId, 'research'); assert.equal(result.event.callId, 'c');
  assert.equal(result.event.toolName, 'search'); assert.equal(result.issues.length, 0);
  assert.equal(summarizeTrace([result.event]).runs[0].outcome.status, 'incomplete');
});

test('missing timestamp is unknown, stable and never Date.now or zero', () => {
  const input = event('unknown'); delete input.timestamp;
  const result = normalizeEvent(input);
  assert.equal(result.event.timestamp, null); assert.equal(result.issues[0].code, 'missing_timestamp');
  const first = collectEvents([event('b', 'custom', { timestamp: null }), event('a', 'custom', { timestamp: null })]);
  const second = collectEvents([event('a', 'custom', { timestamp: null }), event('b', 'custom', { timestamp: null })]);
  assert.deepEqual(first.events, second.events); assert.equal(first.events[0].eventId, 'a');
});

test('rejects invalid identity, timestamps, status and numeric fields', () => {
  for (const fields of [{ eventId: '' }, { eventId: 'x\nforged' }, { timestamp: NaN }, { timestamp: -1 }, { timestamp: 1.2 },
    { status: 'maybe' }, { cost: Infinity }, { cost: -0.1 }, { resultLength: -1 }, { data: { success: 'true' } }, { summary: null }]) {
    assert.equal(normalizeEvent(event('x', 'complete', fields)).event, null);
  }
});

test('rejects contradictory root/data and alternative identity aliases', () => {
  for (const fields of [{ data: { agentId: 'another' } }, { callId: 'a', data: { toolCallId: 'b' } },
    { data: { tool: 'a', toolName: 'b' } }, { data: { callId: 'a', toolCallId: 'b' } }]) {
    assert.equal(normalizeEvent(event('x', 'agent_tool_call', fields)).event, null);
  }
});

test('deep unsafe keys, executable objects, accessors and cyclic objects are rejected', () => {
  let invoked = false;
  const getter = event('x'); Object.defineProperty(getter, 'data', { enumerable: true, get() { invoked = true; throw new Error('should not execute'); } });
  const cycle = {}; cycle.self = cycle;
  const hostile = JSON.parse('{"nested":{"__proto__":{"polluted":true}}}');
  for (const input of [getter, event('x', 'custom', { data: hostile }), event('x', 'custom', { data: cycle }),
    event('x', 'custom', { data: { constructor: 'danger' } }), event('x', 'custom', { data: { exec() {} } }), new Date()]) {
    assert.equal(normalizeEvent(input).event, null);
  }
  assert.equal(invoked, false); assert.equal({}.polluted, undefined);
});

test('bounds nesting, sparse arrays and long fields without executing input', () => {
  let deep = {}; for (let i = 0; i < 20; i++) deep = { next: deep };
  const sparse = new Array(50000);
  for (const data of [deep, { huge: sparse }, { text: 'x'.repeat(40000) }]) assert.equal(normalizeEvent(event('x', 'custom', { data })).event, null);
  assert.equal(normalizeEvent(event('x', 'custom', { data: { command: 'rm -rf /; fetch("https://example.invalid")' } })).event.type, 'custom');
});

test('deduplicates equivalent property order and never overwrites conflicting identities', () => {
  const a = event('a', 'complete', { data: { success: true, nested: { a: 1, b: 2 } } });
  const copy = { ...a, data: { nested: { b: 2, a: 1 }, success: true } };
  assert.equal(collectEvents([a, copy]).counts.duplicates, 1);
  const b = { ...a, data: { success: false } };
  for (const input of [[a, b, copy], [b, a, b]]) {
    const result = collectEvents(input); assert.deepEqual(result.events, []);
    assert.equal(result.counts.conflictingIdentities, 1); assert.equal(result.issues.some(item => item.code === 'conflicting_duplicate'), true);
  }
});

test('event identity includes workspace/session/run and reserved-looking IDs are safe Map keys', () => {
  const data = [event('__proto__'), event('__proto__', 'agent_progress', { runId: 'other' }),
    event('__proto__', 'agent_progress', { workspaceId: 'other' }), event('__proto__', 'agent_progress', { sessionId: 'other' })];
  assert.equal(collectEvents(data).counts.accepted, 4); assert.equal(summarizeTrace(data).runs.length, 4);
});

test('index combines exact filters, paginates once and returns defensive copies', () => {
  const data = [event('a', 'agent_progress', { timestamp: 1 }), event('b', 'agent_progress', { timestamp: 2 }),
    event('c', 'agent_progress', { timestamp: 3, taskId: 'other' }), event('d', 'agent_progress', { timestamp: 4, agentId: 'other' })];
  const index = createTraceIndex(data), filter = { runId: 'run-1', taskId: 'task-1', agentId: 'agent-1' };
  const first = index.query(filter, { limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.nextOffset, 1); assert.equal(first.events[0].eventId, 'a');
  first.events[0].summary = 'mutated'; data[1].summary = 'mutated input';
  const second = index.query(filter, { offset: 1, limit: 1 });
  assert.equal(second.events[0].eventId, 'b'); assert.equal(second.nextOffset, null);
  assert.equal(index.query(filter).events[0].summary, 'Synthetic test event.');
  assert.equal(index.query(filter).events[1].summary, 'Synthetic test event.');
  assert.equal(index.query({ runId: 'missing' }).total, 0);
  assert.throws(() => index.query({}, { limit: 0 }), /limit/);
  assert.throws(() => index.query({}, { offset: -1 }), /Offset/);
  assert.throws(() => index.query({ unsupported: 'x' }), /filters/);
});
