import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatText } from '../src/cli.js';
import { reviewReport, VERSION } from '../src/index.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
const input = { requirements: { id: 'brief', text: '严格串行。' }, report: '按串行交付。' };

test('CLI reads the synthetic fixture and returns findings with exit 1', () => {
  const result = run([fileURLToPath(new URL('../examples/project.json', import.meta.url)), '--json']);
  assert.equal(result.error, undefined); assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.findings.length, 3); assert.equal(output.factVerification, 'not_performed');
});

test('stdin no-findings exit 0 still states that facts are not verified', () => {
  const result = run(['-', '--json'], JSON.stringify(input));
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'no_findings');
  const text = run(['-'], JSON.stringify(input));
  assert.match(text.stdout, /NOT a general fact-check pass/);
});

test('source fixture is offline and reports an old-as-recent citation', () => {
  const result = run([fileURLToPath(new URL('../examples/sources.json', import.meta.url)), '--json']);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).findings.map(item => item.ruleId), ['sources.date.outside_window']);
});

test('malformed JSON, bad UTF-8, unsafe schema and oversized input fail with exit 2 without echoing the document', () => {
  for (const [value, code] of [
    ['{"secret-test-value":', 'invalid_json'],
    [Buffer.from([0xc3, 0x28]), 'invalid_utf8'],
    [JSON.stringify({ ...input, unexpected: 'secret-test-value' }), 'unknown_field'],
    ['x'.repeat(1024 * 1024 + 1), 'limit_exceeded'],
  ]) {
    const result = run(['-', '--json'], value);
    assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /secret-test-value/);
    const envelope = JSON.parse(result.stderr);
    assert.equal(envelope.schema, 'evidence-bound-review/error-v1');
    assert.equal(envelope.error.code, code);
    assert.equal(envelope.error.path, '');
  }
});

test('unreadable file and invalid options return structured errors without echoing paths or arguments', () => {
  for (const [args, code] of [
    [[fileURLToPath(new URL('../absent-private-file/input.json', import.meta.url)), '--json'], 'input_not_readable'],
    [['--private-secret', '--json'], 'invalid_arguments'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, code);
    assert.doesNotMatch(result.stderr, /absent-private-file|private-secret|[A-Z]:\\/);
  }
});

test('library input error paths survive the CLI JSON envelope', () => {
  const bad = { ...input, materials: [
    { id: 'a', text: '材料。' },
    { id: 'b', text: '材料。', source: { basis: 'publication', dateQuote: 'private-date' } },
  ] };
  const result = run(['-', '--json'], JSON.stringify(bad));
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  const envelope = JSON.parse(result.stderr);
  assert.equal(envelope.error.code, 'quote_not_found');
  assert.equal(envelope.error.path, '/materials/1/source/dateQuote');
  assert.doesNotMatch(result.stderr, /private-date/);
});

test('unknown options fail; help and version need no input', () => {
  assert.equal(run(['--execute']).status, 2);
  assert.equal(run(['--json', '--json']).status, 2);
  assert.match(run(['--help']).stdout, /Exit 0/);
  assert.equal(run(['--version']).stdout.trim(), VERSION);
});

test('text diagnostics do not echo terminal escape or bidi controls from evidence', () => {
  const review = reviewReport({ ...input, report: '\u001b[31m建议并行执行。\u202e' });
  const output = formatText(review);
  assert.doesNotMatch(output, /[\u001b\u202e]/);
  assert.equal(review.findings[0].report.quote.includes('\u001b'), true);
});
