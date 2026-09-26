import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewReport, ReviewInputError, errorEnvelope, LIMITS } from '../src/index.js';
import { createTextIndex } from '../src/text.js';

const review = (report, text = '严格串行，不指定日历日期。', materials = []) => reviewReport({ requirements: { id: 'brief', text }, report, materials });

for (const [requirements, report, expected] of [
  ['严格串行，负责人未知。', '建议并行执行。', '建议并行执行。'],
  ['严格串行。', '建议本轮并行执行，未来再优化质量。', '建议本轮并行执行，'],
  ['严格串行。', '不建议设计和开发并行；建议开发和测试并行。', '建议开发和测试并行。'],
  ['严格串行。', '不建议并行但建议本轮并行。', '不建议并行但建议本轮并行。'],
  ['不指定日历日期，负责人未知。', '无需提供开始日期；请确认日历起算日。', '请确认日历起算日。'],
]) test(`EBR-01: local scope and later actions: ${report}`, () => {
  const result = review(report, requirements);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].report.quote, expected);
  assert.equal(report.slice(result.findings[0].report.start, result.findings[0].report.end), expected);
});

for (const report of [
  '如果未来获批改变条件，可以并行执行。',
  '如果未来获批改变条件；可以并行执行。',
  '假如预算获批，可以并行；建议同步开展。',
  '示例：“建议并行执行。”，不用于本轮。',
  '引用“不要延误，建议并行。”；保持串行。',
]) test(`EBR-01: preserve conditional/quoted alternatives: ${report}`, () => assert.equal(review(report).findings.length, 0));

test('EBR-01: ambiguous conditional scopes are visible without asserting a conflict', () => {
  const result = review('若未来获批，可以并行执行。');
  assert.equal(result.findings.length, 0);
  assert.equal(result.coverage.skipped[0].rule, 'requirements.serial');
  assert.equal(review('若未来获批，可以并行；但本轮建议并行执行。').findings.length, 1);
});

test('EBR-01: clauses keep exact UTF-16 offsets, CRLF lines, and inline quote punctuation', () => {
  const text = '\u{1f4c5}规划\r\n“严格串行？”仅为引用；严格串行，负责人未知。';
  const report = '\u{1f4dd}草稿\r\n“建议并行。不要参考”；不建议设计和开发并行；建议开发和测试并行。';
  const result = review(report, text);
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.report.line, 2);
  assert.equal(finding.evidence[0].line, 2);
  assert.equal(finding.report.quote, '建议开发和测试并行。');
  assert.equal(text.slice(finding.evidence[0].start, finding.evidence[0].end), finding.evidence[0].quote);
  assert.equal(report.slice(finding.report.start, finding.report.end), finding.report.quote);
});

test('EBR-02: text segmentation is cached only inside one text index', () => {
  const index = createTextIndex('第一行。\r\n\u{1f4c5}第二行。\r第三行。', 'm', '/materials/0/text');
  assert.strictEqual(index.sentences(), index.sentences());
  assert.deepEqual(index.sentences().map(ref => ref.line), [1, 2, 3]);
  assert.notStrictEqual(index.sentences(), createTextIndex('别的材料。', 'm', '/materials/0/text').sentences());
});

test('EBR-02: 1/16/128 identical citations assess one material and return the same result locations', () => {
  let first;
  for (const count of [1, 16, 128]) {
    const result = reviewReport({ requirements: { id: 'r', text: '核对材料。' }, report: '近期信息。',
      materials: [{ id: 'm', text: Array.from({ length: 1800 }, (_, i) => `合成材料${i}${'字'.repeat(42)}。`).join('\n') }],
      temporal: { asOf: '2026-09-25' },
      citations: Array.from({ length: count }, () => ({ materialId: 'm', reportQuote: '近期信息。', usage: 'recent' })) });
    assert.equal(result.coverage.explicitDateCitations, count);
    assert.equal(result.coverage.uniqueDateCitations, 1);
    assert.equal(result.coverage.assessedDateSources, 1);
    assert.equal(result.sources.length, 1);
    assert.equal(result.findings.length, 1);
    first ||= result.findings;
    assert.deepEqual(result.findings, first);
  }
});

test('EBR-02: distinct bindings/usages remain distinct, with one date assessment per source', () => {
  const input = { requirements: { id: 'r', text: '核对。' }, report: '片段甲。片段乙。', materials: [{ id: 'm', text: '材料。' }],
    temporal: { asOf: '2026-09-25' }, citations: [
      { materialId: 'm', reportQuote: '片段甲。', usage: 'recent' },
      { materialId: 'm', reportQuote: '片段甲。', usage: 'background' },
      { materialId: 'm', reportQuote: '片段乙。', usage: 'recent' },
    ] };
  const result = reviewReport(input);
  assert.equal(result.sources.length, 3);
  assert.equal(result.findings.length, 2);
  assert.equal(result.coverage.assessedDateSources, 1);
  input.materials[0].source = { basis: 'publication', publicationDate: '2026-09-25', dateQuote: '2026-09-25' };
  input.materials[0].text = '发布于2026-09-25。';
  assert.equal(reviewReport(input).findings.length, 0);
});

const contract = { id: 'a', text: '来源A：登记210份合同，其中30份到期。' };
const store = { id: 'b', text: '来源B：登记210家门店，其中30家暂停。' };
for (const report of ['来源A的210份是否包含30份？', '210份是否包含30份？'])
  test(`EBR-03: unrelated units do not suppress an explicit relationship: ${report}`, () => {
    const before = review(report, '核对。', [contract]);
    const after = review(report, '核对。', [contract, store]);
    assert.equal(after.findings.length, 1);
    assert.deepEqual(after.findings, before.findings);
  });

test('EBR-03: same units can bind an exact source, but unbound identities are skipped', () => {
  const materials = [contract, { id: 'b', text: '来源B：登记210份清单，其中30份暂停。' }];
  assert.equal(review('来源A的210份是否包含30份？', '核对。', materials).findings[0].evidence[0].materialId, 'a');
  const ambiguous = review('210份是否包含30份？', '核对。', materials);
  assert.equal(ambiguous.findings.length, 0);
  assert.equal(ambiguous.coverage.skipped[0].rule, 'material.subset');
  assert.equal(review('来源B的210份是否包含30份？', '核对。', [contract]).findings.length, 0);
});

test('EBR-03: source labels use the whole token, not the first letter', () => {
  for (const label of ['API', 'AB', 'A2', 'A_2', 'A-other']) {
    assert.equal(review(`来源${label}的210份是否包含30份？`, '核对。', [contract]).findings.length, 0);
    const other = { id: 'b', text: `来源${label}：登记210份清单，其中30份暂停。` };
    assert.equal(review(`来源${label}的210份是否包含30份？`, '核对。', [contract, other]).findings[0].evidence[0].materialId, 'b');
  }
});

for (const quantity of ['9,007,199,254,740,991', '9,007,199,254,740,992', '9,007,199,254,740,993', '9007199254740993', '9'.repeat(64)])
  test(`EBR-04: exact integer matching: ${quantity}`, () => {
    const text = `登记${quantity}份文件，其中30份暂停。`;
    assert.equal(review(`${quantity}份是否包含30份？`, text).findings.length, 1);
    assert.equal(review('9007199254740994份是否包含30份？', text).findings.length, 0);
  });

test('EBR-04: adjacent out-of-safe-range integers never round to the same value', () => {
  assert.equal(review('9,007,199,254,740,992份是否包含30份？', '登记9,007,199,254,740,993份文件，其中30份暂停。').findings.length, 0);
});

test('EBR-04: malformed source quantities are not matched by a numeric suffix', () => {
  for (const number of ['1e210', '1.210', '-210', '2,10'])
    assert.equal(review('210份是否包含30份？', `登记${number}份文件，其中30份暂停。`).findings.length, 0);
});

for (const number of ['-210', '\u2212210', '210.0', '2,10', '2.10e2', '2100'])
  test(`EBR-04: do not match the suffix of invalid/different report numbers: ${number}`, () => {
    assert.equal(review(`${number}份是否包含30份？`, contract.text).findings.length, 0);
  });

test('EBR-04: oversized integers explicitly skip; no BigInt or rounded values enter JSON', () => {
  const number = '9'.repeat(LIMITS.integerDigits + 1);
  const source = review(`${number}份是否包含30份？`, `登记${number}份文件，其中30份暂停。`);
  assert.equal(source.findings.length, 0);
  assert.match(source.coverage.skipped[0].reason, /64/);
  const report = review(`${number}份是否包含30份？`, contract.text);
  assert.equal(report.findings.length, 0);
  assert.match(report.coverage.skipped[0].reason, /64/);
  assert.doesNotThrow(() => JSON.stringify(source));
});

test('EBR-05: validation errors preserve TypeError compatibility and the exact field path', () => {
  const input = { requirements: { id: 'r', text: '核对。' }, report: '报告。', materials: [
    { id: 'm0', text: '材料。' }, { id: 'm1', text: '材料。', source: { basis: 'publication', dateQuote: 'private-secret' } },
  ] };
  assert.throws(() => reviewReport(input), error => {
    assert.ok(error instanceof TypeError && error instanceof ReviewInputError);
    assert.equal(error.code, 'quote_not_found');
    assert.equal(error.path, '/materials/1/source/dateQuote');
    assert.doesNotMatch(JSON.stringify(errorEnvelope(error)), /private-secret/);
    return true;
  });
  const ambiguous = { requirements: { id: 'r', text: '核对。' }, report: '重复。重复。', materials: [{ id: 'm', text: '材料。' }],
    temporal: { asOf: '2026-09-25' }, citations: [{ materialId: 'm', reportQuote: '重复。', usage: 'recent' }] };
  assert.throws(() => reviewReport(ambiguous), { code: 'quote_ambiguous', path: '/citations/0/reportQuote' });
  assert.throws(() => reviewReport({ ...ambiguous, temporal: { asOf: 'invalid' } }), { code: 'invalid_value', path: '/temporal/asOf' });
  assert.deepEqual(errorEnvelope(new Error('secret path')), { schema: 'evidence-bound-review/error-v1', error: {
    code: 'internal_error', path: '', message: 'Review could not finish; no review result was produced.',
  } });
});

test('EBR-05: sparse arrays and malformed duplicate citations cannot bypass validation', () => {
  const input = { requirements: { id: 'r', text: '核对。' }, report: '报告。', materials: Array(1) };
  assert.throws(() => reviewReport(input), { code: 'invalid_type', path: '/materials/0' });
  input.materials = [{ id: 'm', text: '材料。' }]; input.temporal = { asOf: '2026-09-25' };
  input.citations = [{ materialId: 'm', reportQuote: '报告。', usage: 'recent' }, { materialId: 'm', reportQuote: '报告。', usage: 'recent', private: true }];
  assert.throws(() => reviewReport(input), { code: 'unknown_field', path: '/citations/1' });
});
