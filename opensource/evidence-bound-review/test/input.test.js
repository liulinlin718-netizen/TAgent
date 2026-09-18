import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewReport, LIMITS } from '../src/index.js';

const fixture = () => ({ requirements: { id: 'brief', text: '严格串行。' }, report: '保持串行。' });

test('input remains unchanged and no network capability is needed', () => {
  const input = fixture(), original = structuredClone(input), fetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network must not be used.'); };
  try { reviewReport(input); } finally { globalThis.fetch = fetch; }
  assert.deepEqual(input, original);
});

test('rejects duplicate ids, unknown fields, wrong types and prototype-shaped inputs', () => {
  assert.throws(() => reviewReport({ ...fixture(), materials: [{ id: 'brief', text: '另一个材料' }] }), /unique/);
  assert.throws(() => reviewReport({ ...fixture(), typo: 'ignored?' }), /unknown field/);
  assert.throws(() => reviewReport({ ...fixture(), requirements: { id: 'a', text: '材料', source: {} } }), /unknown field/);
  for (const value of [null, [], new Date(), '', { requirements: null, report: 'test' }]) assert.throws(() => reviewReport(value), TypeError);
  assert.throws(() => reviewReport(JSON.parse('{"requirements":{"id":"a","text":"x"},"report":"x","__proto__":{}}')), /unknown field/);
});

test('validates material ids without exposing the invalid id in diagnostic text', () => {
  const input = fixture(); input.requirements.id = '../../private-token';
  assert.throws(() => reviewReport(input), error => error instanceof TypeError && !error.message.includes('private-token'));
});

test('rejects oversized text, aggregate text, material arrays and citations rather than truncating', () => {
  assert.throws(() => reviewReport({ ...fixture(), report: 'a'.repeat(LIMITS.textLength + 1) }), /at most/);
  assert.throws(() => reviewReport({ ...fixture(), materials: Array.from({ length: 33 }, (_, index) => ({ id: `m${index}`, text: '材料' })) }), /at most 32/);
  assert.throws(() => reviewReport({ ...fixture(), citations: Array.from({ length: 129 }, () => ({})) }), /at most 128/);
  assert.throws(() => reviewReport({ ...fixture(), materials: Array.from({ length: 3 }, (_, index) => ({ id: `m${index}`, text: 'a'.repeat(90000) })) }), /Combined text/);
});

test('bounded statement and relation work prevents quadratic input amplification', () => {
  assert.throws(() => reviewReport({ ...fixture(), report: '句。'.repeat(2001) }), /Too many prose/);
  assert.throws(() => reviewReport({ ...fixture(), materials: [{ id: 'many', text: '登记1200份文件，其中200份附件。'.repeat(201) }] }), /Too many subset/);
});

test('source URL is metadata only and rejects embedded credentials or executable schemes', () => {
  for (const url of ['javascript:alert(1)', 'file:///private', 'https://user:secret@example.org/', 'not a url']) {
    const input = { ...fixture(), materials: [{ id: 'm', text: '材料', source: { basis: 'unknown', url } }] };
    assert.throws(() => reviewReport(input), /HTTP/);
  }
});

test('citations require a known reference, a recognized usage, and valid exact offsets', () => {
  const base = { ...fixture(), temporal: { asOf: '2026-09-18' }, materials: [{ id: 'm', text: '材料' }] };
  const citation = { materialId: 'm', reportQuote: base.report, usage: 'recent' };
  for (const override of [{ materialId: 'missing' }, { materialId: 'brief' }, { usage: 'verified' }, { reportStart: -1 }, { reportStart: 0.5 }, { reportStart: '0' }])
    assert.throws(() => reviewReport({ ...base, citations: [{ ...citation, ...override }] }), TypeError);
});

test('missing source metadata is explicitly unverified when used as recent evidence', () => {
  const input = { ...fixture(), temporal: { asOf: '2026-09-18' }, materials: [{ id: 'm', text: '只有正文，没有日期元数据。' }],
    citations: [{ materialId: 'm', reportQuote: '保持串行。', usage: 'recent' }] };
  const result = reviewReport(input);
  assert.equal(result.findings[0].ruleId, 'sources.date.unverified');
  assert.equal(result.findings[0].metadata.basis, 'unknown');
  assert.equal(result.findings[0].evidence[0].quote, input.materials[0].text);
});
