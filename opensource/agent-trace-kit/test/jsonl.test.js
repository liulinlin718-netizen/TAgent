import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonl, readTraceFile, summarizeTrace } from '../src/index.js';
import { event, temporary } from './helpers.js';

test('reads offline fixture, deduplicates replay and preserves interrupted calls', async () => {
  const loaded = await readTraceFile(fileURLToPath(new URL('../examples/research.jsonl', import.meta.url)));
  assert.deepEqual(loaded.counts, { input: 15, accepted: 14, invalid: 0, duplicates: 1, conflictingIdentities: 0 });
  const report = summarizeTrace(loaded.events), complete = report.runs.find(run => run.scope.runId === 'research-run');
  assert.equal(complete.outcome.status, 'succeeded'); assert.equal(complete.recordedRunCost, 0.003);
  assert.equal(complete.edges.filter(edge => edge.kind === 'parent').length, 1);
  assert.equal(report.runs.find(run => run.scope.runId === 'interrupted-run').tools[0].state, 'pending');
});

test('UTF-8, CRLF, a first-line BOM and a valid unterminated final line preserve byte offsets', async t => {
  const dir = await temporary(t), file = join(dir, 'unicode.jsonl');
  const first = '\uFEFF' + JSON.stringify(event('first', 'custom', { summary: '\u4e2d\u6587 \uD83D\uDE80 English' })) + '\r\n';
  const last = JSON.stringify(event('last', 'custom'));
  await writeFile(file, first + last, 'utf8');
  const records = []; for await (const record of readJsonl(file)) records.push(record);
  assert.equal(records[0].event.summary, '\u4e2d\u6587 \uD83D\uDE80 English');
  assert.equal(records[1].byteOffset, Buffer.byteLength(first));
  assert.equal(records[1].byteLength, Buffer.byteLength(last)); assert.equal(records[1].line, 2);
});

test('malformed tail and malicious JSON are errors; earlier valid records remain available', async t => {
  const dir = await temporary(t), file = join(dir, 'broken.jsonl');
  const bad = JSON.stringify(event('bad')).replace('"summary":', '"__proto__":{"polluted":true},"summary":');
  await writeFile(file, JSON.stringify(event('valid')) + '\n' + bad + '\n{"eventId":"cut');
  const loaded = await readTraceFile(file);
  assert.equal(loaded.events.length, 1); assert.equal(loaded.counts.invalid, 2);
  assert.equal(loaded.issues.some(item => item.code === 'invalid_json' && item.line === 3), true);
  assert.equal({}.polluted, undefined);
});

test('invalid UTF-8 is not silently replaced and also counts toward the record limit', async t => {
  const dir = await temporary(t), file = join(dir, 'invalid-utf8.jsonl');
  await writeFile(file, Buffer.concat([Buffer.from([0xff, 10, 0xff, 10]), Buffer.from(JSON.stringify(event('valid')))]));
  const loaded = await readTraceFile(file);
  assert.equal(loaded.counts.invalid, 2); assert.equal(loaded.events.length, 1);
  await assert.rejects(readTraceFile(file, { maxEvents: 1 }), error => error.code === 'event_limit');
});

test('file, line and record bounds fail explicitly; invalid options cannot disable them', async t => {
  const dir = await temporary(t), file = join(dir, 'large.jsonl');
  await writeFile(file, JSON.stringify(event('a')) + '\n' + JSON.stringify(event('b')) + '\n');
  for (const [options, code] of [[{ maxFileBytes: 10 }, 'file_limit'], [{ maxLineBytes: 10 }, 'line_limit'],
    [{ maxEvents: 1 }, 'event_limit'], [{ maxEvents: 0 }, 'invalid_limit'], [{ maxFileBytes: Infinity }, 'invalid_limit']]) {
    await assert.rejects(readTraceFile(file, options), error => error.code === code);
  }
});

test('reader handles a multibyte string split across filesystem chunks', async t => {
  const dir = await temporary(t), file = join(dir, 'chunks.jsonl');
  const prefix = JSON.stringify(event('prefix', 'custom', { data: { a: 'x'.repeat(30000), b: 'x'.repeat(30000) } })) + '\n';
  await writeFile(file, prefix + JSON.stringify(event('unicode', 'custom', { data: { note: '\u6d4b\u8bd5'.repeat(5000) } })) + '\n');
  const loaded = await readTraceFile(file);
  assert.equal(loaded.events.length, 2); assert.equal(loaded.issues.length, 0);
  assert.equal(loaded.events.find(item => item.eventId === 'unicode').data.note.length, 10000);
});

test('file mutation during streaming is refused rather than reported as a stable snapshot', async t => {
  const dir = await temporary(t), file = join(dir, 'changes.jsonl');
  await writeFile(file, JSON.stringify(event('a')) + '\n');
  const iterator = readJsonl(file);
  assert.equal((await iterator.next()).value.event.eventId, 'a');
  await appendFile(file, JSON.stringify(event('b')) + '\n');
  await assert.rejects(async () => { while (!(await iterator.next()).done) {} }, error => error.code === 'file_changed');
});

test('unreadable paths and directories return bounded diagnostics without system error bodies', async t => {
  const dir = await temporary(t);
  await assert.rejects(readTraceFile(dir), error => error.code === 'not_regular_file');
  await assert.rejects(readTraceFile(join(dir, 'not-present')), error => error.code === 'file_read_failed' && !error.message.includes(dir));
});

test('blank lines preserve positions without generating fake events', async t => {
  const dir = await temporary(t), file = join(dir, 'blank.jsonl');
  await writeFile(file, '\n \r\n' + JSON.stringify(event('one', 'custom', { timestamp: null })) + '\n');
  const loaded = await readTraceFile(file);
  assert.equal(loaded.counts.input, 1); assert.equal(loaded.issues[0].line, 3);
});
