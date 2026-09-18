import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { main } from '../bin/agent-trace.js';
import { event, temporary } from './helpers.js';

const fixture = fileURLToPath(new URL('../examples/research.jsonl', import.meta.url));
async function run(args) {
  let stdout = '', stderr = '';
  const code = await main(args, text => { stdout += text; }, text => { stderr += text; });
  return { code, stdout, stderr };
}

test('summary demo works offline and does not count agent costs twice', async () => {
  const result = await run(['summary', fixture, '--json']);
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.counts.duplicates, 1);
  assert.equal(report.runs.find(item => item.scope.runId === 'research-run').recordedRunCost, 0.003);
  assert.equal(report.runs.find(item => item.scope.runId === 'interrupted-run').outcome.status, 'interrupted');
});

test('filtered summary labels its reduced scope', async () => {
  const result = await run(['summary', fixture, '--run', 'research-run', '--agent', 'researcher', '--json']);
  const report = JSON.parse(result.stdout);
  assert.equal(report.filtered, true); assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].outcome.status, 'incomplete');
  assert.equal(report.runs[0].agents.length, 1);
});

test('events use exact filters and pagination without raw tool arguments/configuration', async t => {
  const dir = await temporary(t), file = join(dir, 'private-data.jsonl');
  await writeFile(file, JSON.stringify(event('a', 'agent_tool_call', { callId: 'c', toolName: 'search', data: { args: { token: 'not-a-real-token' } } })) + '\n');
  const result = await run(['events', file, '--agent', 'agent-1', '--limit', '1', '--json']);
  assert.equal(result.code, 0); const page = JSON.parse(result.stdout);
  assert.equal(page.total, 1); assert.equal(page.events[0].callId, 'c'); assert.equal(page.events[0].data, undefined);
  assert.equal(result.stdout.includes('not-a-real-token'), false);
});

test('malformed records produce diagnostics and exit 2, not a silent success', async t => {
  const dir = await temporary(t), file = join(dir, 'bad.jsonl'); await writeFile(file, '{broken}\n');
  const result = await run(['validate', file, '--json']);
  assert.equal(result.code, 2); assert.equal(JSON.parse(result.stdout).issues[0].code, 'invalid_json');
});

test('text output escapes terminal and bidi controls from log fields', async t => {
  const dir = await temporary(t), file = join(dir, 'terminal.jsonl');
  await writeFile(file, JSON.stringify(event('x', 'governance', { summary: 'text\u001b[31m\u202Ehidden\nFAKE', data: { result: 'warning' } })) + '\n');
  const result = await run(['summary', file]);
  assert.equal(result.code, 0); assert.equal(result.stdout.includes('\u001b'), false); assert.equal(result.stdout.includes('\u202E'), false);
  assert.equal(result.stdout.includes('\\u001b'), true); assert.equal(result.stdout.includes('\\u202e'), true);
});

test('invalid flags, pagination and file paths fail without dumping raw errors', async () => {
  for (const args of [['execute', fixture], ['summary', fixture, '--wat'], ['summary', fixture, '--limit', '1'],
    ['events', fixture, '--limit', '0'], ['events', fixture, '--offset', '-1'], ['events', fixture, '--run'],
    ['events', fixture, '--json', '--json'], ['validate', fixture, '--run', 'x'], ['summary', 'https://example.invalid/trace.jsonl']]) {
    const result = await run(args); assert.equal(result.code, 1, JSON.stringify(args)); assert.equal(result.stderr.includes('Error:'), false);
  }
});

test('help requires no file and states the read-only boundary', async () => {
  const result = await run(['--help']); assert.equal(result.code, 0); assert.match(result.stdout, /No network, model calls/);
});
