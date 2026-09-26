import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectEvents, readTraceFile, analyzeCollectedTrace, analyzeTraceFile, createTraceIndex } from '../src/index.js';
import { main } from '../bin/agent-trace.js';
import { event, temporary } from './helpers.js';

test('composition retains ingestion errors and cannot be bypassed through a forged batch', () => {
  const original = event('end', 'complete', { data: { success: true } });
  const trace = collectEvents([original, event('invalid', 'complete', { summary: null })]);
  original.data.success = false;
  trace.events[0].data.success = false;
  trace.evidence[0].event.data.success = false;
  trace.issues.length = 0; trace.counts.invalid = 0;
  const report = analyzeCollectedTrace(trace);
  assert.equal(report.counts.invalid, 1); assert.equal(report.issues.length, 1);
  assert.equal(report.runs[0].outcome.status, 'succeeded');
  report.counts.invalid = 0; report.issues.length = 0;
  assert.equal(analyzeCollectedTrace(trace).counts.invalid, 1);
  const index = createTraceIndex(trace);
  assert.equal(index.counts.invalid, 1); assert.equal(index.issues.length, 1);
  index.query().events[0].data.success = false;
  assert.equal(index.query().events[0].data.success, true);
  assert.throws(() => analyzeCollectedTrace({ ...trace }), error => error.code === 'untrusted_batch');
  assert.throws(() => createTraceIndex({ ...trace }), error => error.code === 'invalid_trace');
  let invoked = false;
  assert.throws(() => analyzeCollectedTrace({ get events() { invoked = true; return []; } }), /complete result/);
  assert.equal(invoked, false);
});

test('file analysis preserves blank-line, UTF-8, alias and conflict locations through CLI and library', async t => {
  const dir = await temporary(t), file = join(dir, 'source-locations.jsonl');
  const first = event('same', 'custom');
  const lines = [Buffer.from('\n'), Buffer.from(JSON.stringify(first) + '\n'), Buffer.from('{bad}\n'),
    Buffer.from([255, 10]), Buffer.from(' \r\n'),
    Buffer.from(JSON.stringify({ ...first, summary: 'conflicting' }) + '\n'),
    Buffer.from(JSON.stringify(event('alias-error', 'tool_call', { toolName: 'one', data: { tool: 'two' } })) + '\n'),
    Buffer.from(JSON.stringify(event('end', 'complete', { summary: '\u4e2d\u6587 \uD83D\uDE80', status: 'blocked', data: { success: true } })) + '\n')];
  await writeFile(file, Buffer.concat(lines));
  const report = await analyzeTraceFile(file);
  assert.deepEqual(report.counts, { input: 6, accepted: 1, invalid: 3, duplicates: 0, conflictingIdentities: 1 });
  for (const [code, line] of [['invalid_json', 3], ['invalid_utf8', 4], ['conflicting_duplicate', 6], ['invalid_event', 7], ['conflicting_outcome', 8]]) {
    const problem = report.issues.find(item => item.code === code);
    assert.equal(problem.line, line, code);
    assert.equal(problem.byteOffset, lines.slice(0, line - 1).reduce((total, buffer) => total + buffer.length, 0), code);
    assert.equal(problem.byteLength, lines[line - 1].length, code);
  }
  const conflict = report.issues.find(item => item.code === 'conflicting_duplicate');
  assert.equal(conflict.inputIndex, 3); assert.equal(conflict.relatedSources[0].line, 2);
  const loaded = await readTraceFile(file);
  assert.equal(loaded.evidence[3].source.line, 6);
  let stdout = '';
  const code = await main(['summary', file, '--json'], text => { stdout += text; });
  assert.equal(code, 2); assert.deepEqual(JSON.parse(stdout), report);
  const filtered = analyzeCollectedTrace(loaded, { type: 'tool_call' });
  assert.equal(filtered.filtered, true); assert.equal(filtered.selectedEventCount, 0);
  assert.deepEqual(filtered.counts, report.counts);
  assert.equal(filtered.issues.filter(item => item.severity === 'error').length, 4);
  assert.match(filtered.note, /Partial evidence/);
});

test('file to index to summary normalizes each raw event only once', async t => {
  const dir = await temporary(t), file = join(dir, 'single-pass.jsonl');
  await writeFile(file, [event('a'), event('b', 'complete', { data: { success: true } })].map(value => JSON.stringify(value)).join('\n'));
  const descriptors = Object.getOwnPropertyDescriptors;
  let normalizations = 0;
  Object.getOwnPropertyDescriptors = value => {
    if (value?.eventId && value?.type) normalizations++;
    return descriptors(value);
  };
  try {
    const trace = await readTraceFile(file);
    assert.equal(normalizations, 2);
    const index = createTraceIndex(trace);
    index.query({ runId: 'run-1' }); index.query({ runId: 'run-1' }, { offset: 1 });
    analyzeCollectedTrace(trace); analyzeCollectedTrace(trace, { agentId: 'agent-1' });
    assert.equal(normalizations, 2);
  } finally { Object.getOwnPropertyDescriptors = descriptors; }
});
