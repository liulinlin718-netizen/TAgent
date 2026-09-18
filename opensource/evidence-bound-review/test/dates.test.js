import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateWindow, reviewReport } from '../src/index.js';

function fixture(date = '2026-09-16', basis = 'publication') {
  return { requirements: { id: 'brief', text: '整理合成资料，不核实外部事实。' },
    report: '这份材料作为近期进展的参考。', temporal: { asOf: '2026-09-18', days: 30 },
    materials: [{ id: 'source', text: `合成资料。发布日期：${date}。内容仅为示例。`,
      source: { url: 'https://example.org/synthetic', basis, publicationDate: date, dateQuote: `发布日期：${date}` } }],
    citations: [{ materialId: 'source', reportQuote: '这份材料作为近期进展的参考。', usage: 'recent' }] };
}

test('calendar windows are deterministic, inclusive and handle leap years', () => {
  assert.deepEqual(dateWindow('2026-09-18', 30), { start: '2026-08-20', end: '2026-09-18', days: 30 });
  assert.deepEqual(dateWindow('2024-03-01', 2), { start: '2024-02-29', end: '2024-03-01', days: 2 });
  assert.deepEqual(dateWindow('2026-09-18', 1), { start: '2026-09-18', end: '2026-09-18', days: 1 });
});

for (const date of ['2026-02-29', '2026-09-31', '2026-9-18', '2026-09-18T00:00:00Z', '0000-01-01', 'today'])
  test(`rejects invalid research date: ${date}`, () => assert.throws(() => dateWindow(date), TypeError));

for (const days of [0, -1, 1.5, 367, NaN, Infinity, '30'])
  test(`rejects invalid day count: ${days}`, () => assert.throws(() => dateWindow('2026-09-18', days), TypeError));

test('date-qualified source is eligible, never described as factually verified', () => {
  const result = reviewReport(fixture());
  assert.equal(result.status, 'no_findings'); assert.equal(result.sources[0].status, 'eligible');
  assert.equal(result.factVerification, 'not_performed'); assert.match(result.sources[0].reason, /未核实来源真伪/);
});

test('old source produces a finding only when explicitly presented as recent', () => {
  const input = fixture('2025-09-01'), result = reviewReport(input);
  assert.equal(result.findings[0].ruleId, 'sources.date.outside_window');
  assert.equal(result.sources[0].status, 'background');
  assert.equal(result.findings[0].metadata.windowStart, '2026-08-20');
  input.citations[0].usage = 'background';
  assert.equal(reviewReport(input).findings.length, 0);
});

test('both window boundary days are included', () => {
  assert.equal(reviewReport(fixture('2026-08-20')).sources[0].status, 'eligible');
  assert.equal(reviewReport(fixture('2026-09-18')).sources[0].status, 'eligible');
  assert.equal(reviewReport(fixture('2026-08-19')).sources[0].status, 'background');
});

test('future or malformed source dates cannot be used as recent evidence', () => {
  assert.equal(reviewReport(fixture('2026-09-19')).findings[0].ruleId, 'sources.date.future');
  assert.equal(reviewReport(fixture('2026-02-31')).findings[0].ruleId, 'sources.date.unverified');
});

for (const basis of ['modified', 'url_hint', 'unknown'])
  test(`does not upgrade ${basis} to publication evidence`, () => assert.equal(reviewReport(fixture('2026-09-16', basis)).findings[0].ruleId, 'sources.date.unverified'));

test('missing or mismatching date provenance is unverified, not silently trusted metadata', () => {
  const input = fixture();
  delete input.materials[0].source.dateQuote;
  assert.equal(reviewReport(input).findings[0].ruleId, 'sources.date.unverified');
  input.materials[0].source.dateQuote = '内容仅为示例';
  assert.equal(reviewReport(input).findings[0].ruleId, 'sources.date.unverified');
  delete input.materials[0].source;
  assert.equal(reviewReport(input).findings[0].ruleId, 'sources.date.unverified');
});

test('fabricated evidence or missing report quotes reject the input instead of inventing locations', () => {
  const input = fixture(); input.materials[0].source.dateQuote = '不存在的日期片段';
  assert.throws(() => reviewReport(input), /exact substring/);
  const missing = fixture(); missing.citations[0].reportQuote = '报告没有的结论';
  assert.throws(() => reviewReport(missing), /exact substring/);
});

test('repeated quotes require explicit offsets and retain those exact positions', () => {
  const input = fixture(); input.report += `\n${input.report}`;
  assert.throws(() => reviewReport(input), /explicit start offset/);
  input.citations[0].reportStart = input.report.indexOf('\n') + 1;
  assert.equal(reviewReport(input).sources[0].report.line, 2);
  input.citations[0].reportStart++;
  assert.throws(() => reviewReport(input), /exact substring/);
});

test('date evidence ambiguity also requires an explicit position', () => {
  const input = fixture(); input.materials[0].text += input.materials[0].text;
  assert.throws(() => reviewReport(input), /explicit start offset/);
  input.materials[0].source.dateStart = input.materials[0].text.indexOf('发布日期');
  assert.equal(reviewReport(input).sources[0].status, 'eligible');
});

test('no wall clock, inferred latest claims or unbound links are smuggled into coverage', () => {
  const input = fixture('2020-01-01'); input.citations = [];
  const result = reviewReport(input);
  assert.equal(result.findings.length, 0); assert.equal(result.coverage.explicitDateCitations, 0);
  assert.deepEqual(result.sources, []);
  delete input.temporal; input.citations = [{ materialId: 'source', reportQuote: input.report, usage: 'recent' }];
  assert.throws(() => reviewReport(input), /explicit temporal window/);
});

test('duplicate citations do not duplicate the same finding', () => {
  const input = fixture('2020-01-01'); input.citations.push({ ...input.citations[0] });
  assert.equal(reviewReport(input).findings.length, 1);
});
