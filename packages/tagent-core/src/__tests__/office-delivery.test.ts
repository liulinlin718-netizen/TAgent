import { describe, expect, it, vi } from 'vitest';
import { CostTracker, type LLMProvider, type LLMResponse } from '@tagent/ai';
import { officeOutputBlocks, officeReviewTemplate, OfficeReviewValidationError, parseOfficeReview, verifyOfficeDelivery, type OfficeDeliveryResult, type OfficeMaterial } from '../office-delivery.js';

const task = '月销售额100、120、90万元。请合计并说明变化率。';
const materials: OfficeMaterial[] = [{ id: 'input', label: '用户材料', text: task }];
const areas = ['instructions', 'material_consistency', 'arithmetic', 'deliverable', 'actions'];
function review(output: string, passed = true) {
  return { areas: areas.map(area => ({ area, status: passed ? 'passed' : 'failed', reason: passed ? '满足本项要求' : '缺少材料依据' })),
    blocks: officeOutputBlocks(output).map(block => ({ index: block.index, verdict: 'grounded', reason: '材料支持此段',
      evidence: [{ materialId: 'input', quote: task }] })), lengthLimits: [] as unknown[], calculations: [] as unknown[] };
}
const response = (content: string): LLMResponse => ({ content, model: 'deepseek-chat', stopReason: 'end', toolCalls: [],
  usage: { inputTokens: 100, outputTokens: 100, cost: 0.01 } });
const provider = (call: LLMProvider['call']): LLMProvider => ({ name: 'fixture', call, stream: async function* () {} });
const parse = (value: ReturnType<typeof review>, output = '合计310万元。', input = task) => parseOfficeReview(JSON.stringify(value), input, output,
  [{ id: 'input', label: '用户材料', text: input }], 'deepseek-chat');
const options = (call: LLMProvider['call'], output = '合计310万元。') => ({ provider: provider(call), model: 'deepseek-chat', task, materials,
  output, qualityChecks: ['不可虚构已发送邮件'], costTracker: new CostTracker(), maxCost: 1 });
function calculation(operation = 'sum', result = 310, values = [100, 120, 90], outputQuote = '合计310万元。') {
  return { operation, result, decimals: 0, outputQuote,
    operands: values.map(value => ({ value, materialId: 'input', quote: task })) };
}

describe('office review validation', () => {
  it.each([
    ['约37%', true], ['约37.0%', true], ['约38%', false], ['约37.5%', false], ['37%到38%', false],
  ])('checks the actual quoted percentage without silently accepting a reviewer correction: %s', (output, failed) => {
    const input = '平均等待时间从8分钟降到5分钟。', value = review(output);
    value.blocks[0].evidence = [{ materialId: 'input', quote: input }];
    value.calculations = [{ operation: 'percent_change', result: -37.5, decimals: 1, outputQuote: output,
      operands: [8, 5].map(number => ({ value: number, materialId: 'input', quote: input })) }];
    try { parse(value, output, input); throw new Error('Invalid reviewer claim passed'); }
    catch (error) {
      expect(error).toBeInstanceOf(OfficeReviewValidationError);
      const result = (error as OfficeReviewValidationError).review;
      expect(result.status).toBe('unverified');
      expect(result.checks.some(check => check.id === 'calculation-0-observed' && check.status === 'failed')).toBe(failed);
      expect(result.checks.find(check => check.id === 'calculation-0')?.status).toBe('unverified');
    }
  });
  it('supplies a valid JSON template matching all 19 output blocks without pre-filled approval', () => {
    const output = Array.from({ length: 19 }, (_, i) => `第${i + 1}段：原始材料与限制。`).join('\n\n');
    const template = JSON.parse(JSON.stringify(officeReviewTemplate(output)));
    expect(template.blocks.map((item: { index: number }) => item.index)).toEqual(Array.from({ length: 19 }, (_, i) => i));
    expect(template.blocks.every((item: { verdict: unknown; evidence: unknown[] }) => item.verdict === null && item.evidence.length === 0)).toBe(true);
    expect(template.areas.map((item: { area: string }) => item.area)).toEqual(areas);
    expect(() => parse(template, output)).toThrow(OfficeReviewValidationError);
  });
  it('retains independently valid checks while diagnosing the exact malformed block', () => {
    const output = Array.from({ length: 19 }, (_, i) => `第${i + 1}段`).join('\n\n'), value = review(output);
    value.blocks[6].verdict = 'invented-verdict';
    try { parse(value, output); throw new Error('Invalid payload passed'); }
    catch (error) {
      expect(error).toBeInstanceOf(OfficeReviewValidationError);
      const result = (error as OfficeReviewValidationError).review;
      expect(result.status).toBe('unverified'); expect(result.coverage).toEqual({ expectedBlocks: 19, checkedBlocks: 18 });
      expect(result.checks).toHaveLength(24); expect(result.checks.filter(check => check.status === 'passed')).toHaveLength(23);
      expect(result.issues.join()).toContain('blocks[index=6].verdict'); expect(result.checks.find(check => check.id === 'block-6')?.outputQuote).toBe('第7段');
    }
  });
  it.each(['missing', 'duplicate', 'extra', 'string-index', 'missing-array', 'empty-reason'])('never passes a partial response with %s fields', mode => {
    const value = review('第一段\n\n第二段');
    if (mode === 'missing') value.blocks.pop();
    if (mode === 'duplicate') value.blocks[1] = value.blocks[0];
    if (mode === 'extra') value.blocks.push({ ...value.blocks[0], index: 99 });
    if (mode === 'string-index') (value.blocks[1] as unknown as { index: unknown }).index = '1';
    if (mode === 'missing-array') delete (value as { lengthLimits?: unknown }).lengthLimits;
    if (mode === 'empty-reason') value.blocks[1].reason = '';
    expect(() => parse(value, '第一段\n\n第二段')).toThrow(OfficeReviewValidationError);
  });
  it('checks retained user length constraints with accurate history provenance, not assistant/quote rules', () => {
    const output = '好的', value = review(output);
    value.blocks[0].verdict = 'non_factual'; value.blocks[0].evidence = [];
    value.lengthLimits = [{ instructionQuote: '全文不超过5字', materialId: 'history:u', scope: 'output', max: 5 }];
    const history: OfficeMaterial = { id: 'history:u', label: '历史用户要求', text: '全文不超过5字', contextKind: 'user_input' };
    const result = parseOfficeReview(JSON.stringify(value), '继续', output, [history], 'fixture');
    expect(result.checks.at(-1)).toMatchObject({ status: 'passed', evidence: [{ materialId: 'history:u', label: '历史用户要求', quote: '全文不超过5字' }] });
    for (const contextKind of ['assistant_unverified', 'quoted_excerpt', 'fork_summary'] as const) {
      expect(() => parseOfficeReview(JSON.stringify(value), '继续', output, [{ ...history, contextKind }], 'fixture')).toThrow('原始要求');
    }
  });
  it('covers titles, tables, prose and closing blocks without dropping sections', () => {
    const output = '# 标题\n\n|月|额|\n|--|--|\n|1|100|\n\n合计310万元。\n\n建议核对原始账单。';
    const value = review(output);
    expect(officeOutputBlocks(output)).toHaveLength(4);
    expect(parse(value, output).checks.filter(check => check.id.startsWith('block-'))).toHaveLength(4);
    value.blocks.pop();
    expect(() => parse(value, output)).toThrow('全部输出');
  });
  it('rejects duplicate dimensions, duplicate blocks and empty output', () => {
    const value = review('一\n\n二');
    value.areas[0] = value.areas[1];
    expect(() => parse(value, '一\n\n二')).toThrow('维度');
    const duplicate = review('一\n\n二'); duplicate.blocks[0] = duplicate.blocks[1];
    expect(() => parse(duplicate, '一\n\n二')).toThrow('段落');
    expect(() => parse(review(''), '')).toThrow('正文为空');
  });
  it.each(['missing-id', 'invented-quote', 'non-contiguous', 'empty'])('rejects invalid source evidence: %s', kind => {
    const value = review('合计310万元。');
    if (kind === 'missing-id') value.blocks[0].evidence[0].materialId = 'invented';
    if (kind === 'invented-quote') value.blocks[0].evidence[0].quote = '已发送邮件';
    if (kind === 'non-contiguous') value.blocks[0].evidence[0].quote = '月销售额万元。';
    if (kind === 'empty') value.blocks[0].evidence = [];
    expect(() => parse(value)).toThrow();
  });
  it('rejects ambiguous material IDs and records uncertain judgments without passing', () => {
    const value = review('合计310万元。');
    expect(() => parseOfficeReview(JSON.stringify(value), task, '合计310万元。', [...materials, ...materials], 'deepseek-chat')).toThrow('标识重复');
    value.blocks[0].verdict = 'uncertain';
    expect(parse(value).status).toBe('needs_revision');
    expect(parse(value).checks.find(check => check.id === 'block-0')?.status).toBe('unverified');
  });
  it('does not let a model pass override a wrong sum', () => {
    const output = '合计320万元。', value = review(output);
    value.calculations = [calculation('sum', 320, [100, 120, 90], output)];
    const checked = parse(value, output);
    expect(checked.status).toBe('needs_revision');
    expect(checked.checks.at(-1)).toMatchObject({ method: 'programmatic', status: 'failed', reason: expect.stringContaining('310') });
    expect(checked.checks.at(-1)?.evidence).toHaveLength(1);
  });
  it.each([
    ['sum', 310, [100, 120, 90], '合计310万元。'],
    ['absolute_difference', 30, [120, 90], '两数相差30万元。'],
    ['absolute_difference', 30, [90, 120], '两数的差额30万元。'],
    ['absolute_difference', 0, [90, 90], '差距0万元。'],
    ['difference', -30, [120, 90], '减少30万元。'],
    ['percent_change', -25, [120, 90], '下降25%。'],
    ['percent_change', 20, [100, 120], '增长20%。'],
  ] as const)('recomputes %s with the original values and sign', (operation, result, values, output) => {
    const value = review(output); value.calculations = [calculation(operation, result, [...values], output)];
    expect(parse(value, output).checks.at(-1)?.status).toBe('passed');
  });
  it.each([
    ['两数相差40万元。', 40], ['差额30万元（90 - 120）', 30], ['差额30万元，90 - 120 = 30', 30],
  ])('does not use an absolute difference to approve a wrong number or explicit subtraction: %s', (output, result) => {
    const value = review(String(output)); value.calculations = [calculation('absolute_difference', Number(result), [120, 90], String(output))];
    expect(parse(value, String(output)).checks.at(-1)?.status).toBe('failed');
  });
  it.each([
    ['下降30万元。', 30], ['差额-30万元。', -30],
  ])('rejects an absolute difference with directed or negative-only wording: %s', (output, result) => {
    const value = review(String(output)); value.calculations = [calculation('absolute_difference', Number(result), [120, 90], String(output))];
    expect(() => parse(value, String(output))).toThrow('绝对差额');
  });
  it.each(['\u221230', '\u2212 30', '-30', '- 30'])('preserves the negative sign in output %s', signed => {
    const output = `3月对2月为${signed}万元。`, value = review(output);
    value.calculations = [calculation('difference', -30, [120, 90], output)];
    expect(parse(value, output).checks.at(-1)?.status).toBe('passed');
    value.calculations = [calculation('difference', 30, [120, 90], output)];
    expect(() => parse(value, output)).toThrow('核对数值');
  });
  it.each([
    ['difference', 30, [120, 90], '减少30万元。', 'passed'],
    ['percent_change', 25, [120, 90], '降幅25%。', 'passed'],
    ['difference', 20, [100, 120], '下降20万元。', 'failed'],
    ['percent_change', 20, [100, 120], '下降20%。', 'failed'],
    ['difference', 30, [120, 90], '120 - 90 = 30，即减少30万元。', 'passed'],
  ] as const)('interprets the magnitude in %s / %s / %j / %s using its stated direction', (operation, result, values, output, status) => {
    const value = review(output); value.calculations = [calculation(operation, result, [...values], output)];
    expect(parse(value, output).checks.at(-1)?.status).toBe(status);
  });
  it.each(['120 - 90 = 30', '120 − 90 = 30', '90 − 120 = −30'])('uses the explicit subtraction in %s rather than reversing it', output => {
    const result = output.startsWith('120') ? 30 : -30;
    for (const values of [[120, 90], [90, 120]]) {
      const value = review(output); value.calculations = [calculation('difference', result, values, output)];
      expect(parse(value, output).checks.at(-1)?.status).toBe('passed');
    }
  });
  it('does not flip a wrong equation or accept a registered operand as its claimed result', () => {
    const output = '90 − 120 = 30', value = review(output);
    value.calculations = [calculation('difference', 30, [90, 120], output)];
    expect(parse(value, output).checks.at(-1)?.status).toBe('failed');
    value.calculations = [calculation('difference', 90, [120, 90], output)];
    expect(() => parse(value, output)).toThrow('算式');
  });
  it.each([
    ['剩余30万元（120 - 90）', 30, 'passed'], ['剩余30万元（90 − 120）', 30, 'failed'],
    ['差值−30万元（90 − 120）', -30, 'passed'], ['30万元(120 - 90，按原文计算)', 30, 'passed'],
  ] as const)('uses the written parenthetical subtraction in %s', (output, result, status) => {
    const value = review(output); value.calculations = [calculation('difference', result, [120, 90], output)];
    expect(parse(value, output).checks.at(-1)?.status).toBe(status);
  });
  it('rejects parenthetical subtraction with unrelated operands', () => {
    const output = '30万元（100 - 70）', value = review(output);
    value.calculations = [calculation('difference', 30, [120, 90], output)];
    expect(() => parse(value, output)).toThrow('输入数值');
  });
  it('does not accept one result for two parenthetical subtractions', () => {
    const output = '30万元（120 - 90）（90 - 120）', value = review(output);
    value.calculations = [calculation('difference', 30, [120, 90], output)];
    expect(() => parse(value, output)).toThrow('一个减法');
  });
  it.each(['+ 50', '* 2', '/ 2', '- 10'])('does not approve a partial subtraction from a compound expression: %s', suffix => {
    const output = `差值-30万元（120 - 90 ${suffix}）`, value = review(output);
    value.calculations = [calculation('difference', -30, [120, 90], output)];
    expect(() => parse(value, output)).toThrow('复合');
  });
  it('rejects equations whose inputs differ from the registered source operands', () => {
    const output = '100 − 90 = 10', value = review(output);
    value.calculations = [calculation('difference', 10, [120, 90], output)];
    expect(() => parse(value, output)).toThrow('算式');
  });
  it.each(['降幅25%', '降幅约为25%', '下降了25%', '减少约25%', 'a decline of 25%', 'a reduction of 25%'])('recognizes a signed reduction in %s', output => {
    const value = review(output); value.calculations = [calculation('percent_change', -25, [120, 90], output)];
    expect(parse(value, output).checks.at(-1)?.status).toBe('passed');
  });
  it.each(['降幅扩大25%', '不是下降25%', '没有出现下降25%', 'not a decline of 25%', '下降20%，增长25%'])('does not borrow the decline direction from an unrelated or negated number: %s', output => {
    const value = review(output); value.calculations = [calculation('percent_change', -25, [120, 90], output)];
    expect(() => parse(value, output)).toThrow('核对数值');
  });
  it('still rejects incorrect rounding even when the decline wording is recognized', () => {
    const input = '等待时间从8分钟降到5分钟。', output = '降幅约37%', value = review(output);
    value.blocks[0].evidence = [{ materialId: 'input', quote: input }];
    value.calculations = [{ ...calculation('percent_change', -37, [], output),
      operands: [8, 5].map(amount => ({ value: amount, materialId: 'input', quote: input })) }];
    expect(parse(value, output, input).checks.at(-1)).toMatchObject({ status: 'failed', reason: expect.stringContaining('-38') });
  });
  it('recomputes a typographic negative percentage without treating range dashes as signs', () => {
    const output = '3月环比为（\u221225%）。', value = review(output);
    value.calculations = [calculation('percent_change', -25, [120, 90], output)];
    expect(parse(value, output).status).toBe('passed');
    for (const dash of ['\u2013', '\u2014']) {
      const range = `范围1${dash}30万元。`, rangeReview = review(range);
      rangeReview.calculations = [calculation('difference', -30, [120, 90], range)];
      expect(() => parse(rangeReview, range)).toThrow('核对数值');
    }
  });
  it('recognizes negative operands in unchanged source quotations', () => {
    const input = '两笔调整为\u221230和20万元。', output = '合计\u221210万元。', value = review(output);
    value.blocks[0].evidence = [{ materialId: 'input', quote: input }];
    value.calculations = [{ ...calculation('sum', -10, [], output),
      operands: [-30, 20].map(amount => ({ value: amount, materialId: 'input', quote: input })) }];
    expect(parse(value, output, input).status).toBe('passed');
    value.blocks[0].evidence[0].quote = input.replace('\u2212', '-');
    expect(() => parse(value, output, input)).toThrow('原文');
  });
  it('rejects invented inputs, results absent from output and a zero denominator', () => {
    const output = '合计310万元。', value = review(output);
    value.calculations = [calculation('sum', 310, [100, 110, 90])];
    expect(() => parse(value)).toThrow('数值不在');
    value.calculations = [calculation('sum', 300)];
    expect(() => parse(value)).toThrow('核对数值');
    const zero = '从0增长到90，变化率0%。';
    const check = review(zero); check.blocks[0].evidence[0].quote = zero;
    check.calculations = [{ ...calculation('percent_change', 0, [0, 90], zero), operands: [0, 90].map(value => ({ value, materialId: 'input', quote: zero })) }];
    expect(parse(check, zero, zero).checks.at(-1)).toMatchObject({ status: 'failed', reason: expect.stringContaining('分母为零') });
  });
  it('counts all non-whitespace Unicode characters, not the model claimed length', () => {
    const input = '全文不超过5字', output = '**中文**😊 A', value = review(output);
    value.blocks[0].evidence[0].quote = input;
    value.lengthLimits = [{ instructionQuote: input, scope: 'output', max: 5 }];
    expect(parse(value, output, input).checks.at(-1)).toMatchObject({ status: 'failed', reason: expect.stringContaining('8 个') });
  });
  it('distinguishes strict limits and email body boundaries without ignoring trailing text', () => {
    const input = '邮件正文少于4字', output = '主题：确认\n\n正文：好的\n谢谢', value = review(output);
    value.blocks.forEach(block => { block.evidence[0].quote = input; });
    value.lengthLimits = [{ instructionQuote: input, scope: 'email_body', max: 4 }];
    expect(parse(value, output, input).checks.at(-1)?.status).toBe('failed');
    const noBoundary = review('好的谢谢'); noBoundary.blocks[0].evidence[0].quote = input; noBoundary.lengthLimits = value.lengthLimits;
    expect(parse(noBoundary, '好的谢谢', input).checks.at(-1)?.status).toBe('unverified');
  });
  it('rejects a fabricated length instruction or arbitrary scope', () => {
    const value = review('合计310万元。');
    value.lengthLimits = [{ instructionQuote: '全文不超过5字', scope: 'output', max: 5 }];
    expect(() => parse(value)).toThrow('长度约束');
    const input = '全文不超过5字'; value.blocks[0].evidence[0].quote = input;
    value.lengthLimits = [{ instructionQuote: input, scope: 'email_body', max: 5 }];
    expect(() => parse(value, '合计310万元。', input)).toThrow('正文长度');
  });
});

describe('bounded office delivery verification and revision', () => {
  it.each([
    ['deepseek', 'deepseek-flash', 12288], ['deepseek', 'deepseek-v4-pro', 12288],
    ['deepseek', 'deepseek-chat', 4096], ['fixture', 'deepseek-flash', 4096],
  ])('accounts for the full review output cap for %s/%s', async (name, model, maxTokens) => {
    const call = vi.fn<LLMProvider['call']>().mockResolvedValue(response(JSON.stringify(review('合计310万元。'))));
    const result = await verifyOfficeDelivery({ ...options(call), model, provider: { ...provider(call), name } });
    expect(call.mock.calls[0][0]).toMatchObject({ maxTokens, purpose: 'verification', reasoning: 'disabled' });
    expect(result.review.receipt?.maxOutputTokens).toBe(maxTokens);
  });
  it('declines a structured review when the full output allowance cannot fit in the remaining budget', async () => {
    const call = vi.fn<LLMProvider['call']>();
    const result = await verifyOfficeDelivery({ ...options(call), model: 'deepseek-flash', provider: { ...provider(call), name: 'deepseek' }, maxCost: .014 });
    expect(call).not.toHaveBeenCalled();
    expect(result.review.status).toBe('unverified');
    expect(result.review.issues.join()).toContain('预算');
  });
  it('sends actual material and skill quality checks without tools, and accounts for review usage', async () => {
    const call = vi.fn<LLMProvider['call']>().mockResolvedValue(response(JSON.stringify(review('合计310万元。'))));
    const opts = options(call), result = await verifyOfficeDelivery(opts);
    expect(result.review.status).toBe('passed');
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toMatchObject({ purpose: 'verification', temperature: 0 });
    expect(call.mock.calls[0][0].tools).toBeUndefined();
    expect(call.mock.calls[0][0].messages[0].content).toContain('有一句无依据，整段即为 unsupported');
    expect(call.mock.calls[0][0].messages[0].content).toContain('引用原文存在不等于支持结论');
    const sent = JSON.parse(call.mock.calls[0][0].messages[1].content);
    expect(sent.runContext).toEqual({ reviewDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), timeZone: 'Asia/Shanghai' });
    expect(sent.materials).toEqual(materials); expect(sent.qualityChecks).toEqual(opts.qualityChecks);
    expect(sent.responseTemplate).toEqual(officeReviewTemplate(opts.output));
    expect(result.review.receipt).toMatchObject({ status: 'received', stopReason: 'end', usage: { cost: .01 }, unsettledRequests: 0, rawOutputTruncated: false });
    expect(opts.costTracker.totalCost).toBeCloseTo(0.01);
  });
  it.each(['unknown-price', 'no-budget', 'large-material', 'too-many-blocks'])('retains an unverified draft without a model call: %s', reason => {
    const call = vi.fn<LLMProvider['call']>(), opts = options(call);
    if (reason === 'unknown-price') opts.model = 'unpriced';
    if (reason === 'no-budget') opts.maxCost = 0;
    if (reason === 'large-material') opts.materials = [{ ...materials[0], text: '长'.repeat(60000) }];
    if (reason === 'too-many-blocks') opts.output = Array.from({ length: 81 }, (_, i) => `段${i}`).join('\n\n');
    return verifyOfficeDelivery(opts).then(result => {
      expect(result.output).toBe(opts.output); expect(result.review.status).toBe('unverified'); expect(call).not.toHaveBeenCalled();
    });
  });
  it.each(['network', 'json', 'missing-block', 'truncated', 'tool-use', 'empty', 'unknown-stop'])('does not retry or pass an incomplete review: %s', reason => {
    const value = review('合计310万元。');
    if (reason === 'missing-block') value.blocks = [];
    const result = response(reason === 'json' ? '{' : JSON.stringify(value));
    if (reason === 'truncated') result.stopReason = 'max_tokens';
    if (reason === 'tool-use') { result.stopReason = 'tool_use'; result.toolCalls = [{ id: 'bad', name: 'install', arguments: '{}' }]; }
    if (reason === 'empty') result.content = ' ';
    if (reason === 'unknown-stop') result.stopReason = 'unknown';
    const call = reason === 'network' ? vi.fn<LLMProvider['call']>().mockRejectedValue(new Error('private upstream secret')) : vi.fn<LLMProvider['call']>().mockResolvedValue(result);
    return verifyOfficeDelivery(options(call)).then(checked => {
      expect(checked.review.status).toBe('unverified'); expect(checked.output).toBe('合计310万元。');
      expect(JSON.stringify(checked.review)).not.toContain('private upstream secret'); expect(call).toHaveBeenCalledTimes(1);
      expect(checked.review.receipt?.unsettledRequests).toBe(reason === 'network' ? 1 : 0);
      if (reason !== 'network') expect(checked.review.receipt?.rawOutput).toBe(result.content);
      const messages = { truncated: '输出达到长度限制', 'tool-use': '不允许的工具请求', empty: '未返回可用内容', 'unknown-stop': '未正常结束' };
      if (reason in messages) {
        expect(checked.review.issues.join()).toContain(messages[reason as keyof typeof messages]);
        expect(checked.review.coverage).toEqual({ expectedBlocks: 1, checkedBlocks: 0 });
        expect(checked.review.revisionAttempt).toBeUndefined();
      }
    });
  });
  it('retains a failed arithmetic check and partial review when the repair budget is insufficient', async () => {
    const output = '合计320万元。\n\n另一个无效段落', value = review(output);
    value.blocks[1].evidence = [{ materialId: 'invented', quote: 'missing' }]; value.calculations = [calculation('sum', 320, [100, 120, 90], '合计320万元。')];
    const call = vi.fn<LLMProvider['call']>().mockResolvedValue(response(JSON.stringify(value)));
    const checked = await verifyOfficeDelivery({ ...options(call, output), maxCost: .011 });
    expect(checked.review.status).toBe('unverified'); expect(checked.review.checks.find(check => check.id === 'calculation-0')?.status).toBe('failed');
    expect(checked.review.issues.join()).toContain('材料'); expect(checked.review.issues.join()).toContain('预算不足'); expect(call).toHaveBeenCalledTimes(1);
  });
  it.each(['passed', 'failed', 'partial'])('repairs a known error despite a partial first review, with final outcome %s', async outcome => {
    const original = '合计320万元。\n\n未提供成本。', first = review(original);
    first.blocks[1].evidence = [{ materialId: 'invented', quote: 'missing' }];
    first.calculations = [calculation('sum', 320, [100, 120, 90], '合计320万元。')];
    const total = outcome === 'failed' ? 320 : 310, revised = `合计${total}万元。\n\n未提供成本。`, second = review(revised);
    second.calculations = [calculation('sum', total, [100, 120, 90], `合计${total}万元。`)];
    if (outcome === 'partial') second.blocks[1].evidence = first.blocks[1].evidence;
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(response(JSON.stringify(first)))
      .mockResolvedValueOnce(response(revised)).mockResolvedValueOnce(response(JSON.stringify(second)));
    const opts = options(call, original), checked = await verifyOfficeDelivery(opts);
    expect(checked.output).toBe(revised);
    expect(checked.review.status).toBe(outcome === 'passed' ? 'passed' : outcome === 'failed' ? 'needs_revision' : 'unverified');
    expect(checked.review.previous).toMatchObject({ output: original, review: { status: 'unverified', coverage: { expectedBlocks: 2, checkedBlocks: 1 } } });
    expect(checked.review.previous?.review.receipt?.rawOutput).toBe(JSON.stringify(first));
    const feedback = JSON.parse(call.mock.calls[1][0].messages[1].content).feedback;
    expect(feedback).toContainEqual(expect.objectContaining({ label: '算术复算', outputQuote: '合计320万元。', evidence: expect.any(Array) }));
    expect(call).toHaveBeenCalledTimes(3); expect(call.mock.calls.every(([params]) => !params.tools)).toBe(true);
    expect(opts.costTracker.totalCost).toBeCloseTo(.03);
  });
  it.each(['no-programmatic-failure', 'model-only-failure', 'no-covered-block'])('does not repair incomplete review solely for %s', async mode => {
    const output = '合计320万元。\n\n未提供成本。', value = review(output);
    value.blocks[1].evidence = [{ materialId: 'invented', quote: 'missing' }];
    if (mode === 'model-only-failure') value.areas[0].status = 'failed';
    if (mode === 'no-covered-block') {
      value.blocks[0].evidence = value.blocks[1].evidence;
      value.calculations = [calculation('sum', 320, [100, 120, 90], '合计320万元。')];
    }
    const call = vi.fn<LLMProvider['call']>().mockResolvedValue(response(JSON.stringify(value)));
    const checked = await verifyOfficeDelivery(options(call, output));
    expect(checked.review.status).toBe('unverified'); expect(checked.output).toBe(output);
    expect(checked.review.revisionAttempt).toBeUndefined(); expect(call).toHaveBeenCalledTimes(1);
  });
  it('retains the original partial review and unknown usage when its revision request fails', async () => {
    const output = '合计320万元。\n\n未提供成本。', value = review(output);
    value.blocks[1].evidence = [{ materialId: 'invented', quote: 'missing' }];
    value.calculations = [calculation('sum', 320, [100, 120, 90], '合计320万元。')];
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(response(JSON.stringify(value))).mockRejectedValueOnce(new Error('offline'));
    const checked = await verifyOfficeDelivery(options(call, output));
    expect(checked.output).toBe(output); expect(checked.review.status).toBe('unverified');
    expect(checked.review.revisionAttempt).toMatchObject({ status: 'request_failed', unsettledRequests: 1 });
    expect(checked.review.checks.find(check => check.id === 'calculation-0')?.status).toBe('failed');
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('bounds a retained model response without breaking Unicode or reporting completion', async () => {
    const raw = '🚀'.repeat(25000), call = vi.fn<LLMProvider['call']>().mockResolvedValue(response(raw));
    const checked = await verifyOfficeDelivery(options(call));
    expect(checked.review.status).toBe('unverified'); expect(checked.review.receipt?.rawOutputTruncated).toBe(true);
    expect(checked.review.receipt?.rawOutput).toBe('🚀'.repeat(24000)); expect(call).toHaveBeenCalledTimes(1);
  });
  it('keeps a paid truncated revision in its receipt without replacing the original draft', async () => {
    const partial = { ...response('尚未完成的修订稿'), stopReason: 'max_tokens' as const };
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(response(JSON.stringify(review('合计310万元。', false)))).mockResolvedValueOnce(partial);
    const opts = options(call), checked = await verifyOfficeDelivery(opts);
    expect(checked.output).toBe(opts.output); expect(checked.review.status).toBe('needs_revision');
    expect(checked.review.revisionAttempt).toMatchObject({ rawOutput: partial.content, stopReason: 'max_tokens', usage: { cost: .01 } });
    expect(opts.costTracker.totalCost).toBeCloseTo(.02); expect(call).toHaveBeenCalledTimes(2);
  });
  it.each([true, false])('repairs once and preserves the failed original even when the second check passes=%s', async passed => {
    const original = '合计320万元。', revised = passed ? '合计310万元。' : original;
    const first = review(original); first.calculations = [calculation('sum', 320, [100, 120, 90], original)];
    const second = passed ? review(revised) : first;
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(response(JSON.stringify(first)))
      .mockResolvedValueOnce(response(revised)).mockResolvedValueOnce(response(JSON.stringify(second)));
    const opts = options(call, original), checked = await verifyOfficeDelivery(opts);
    expect(checked.output).toBe(revised); expect(checked.review.status).toBe(passed ? 'passed' : 'needs_revision');
    expect(checked.review.previous).toMatchObject({ output: original, review: { status: 'needs_revision' } });
    expect(call).toHaveBeenCalledTimes(3); expect(call.mock.calls.every(([params]) => !params.tools)).toBe(true);
    expect(opts.costTracker.totalCost).toBeCloseTo(0.03);
  });
  it('keeps a revised draft unverified if its second review fails to return', async () => {
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(response(JSON.stringify(review('合计310万元。', false))))
      .mockResolvedValueOnce(response('修订稿')).mockRejectedValueOnce(new Error('offline'));
    const checked = await verifyOfficeDelivery(options(call));
    expect(checked.review.status).toBe('unverified'); expect(checked.review.previous?.output).toBe('合计310万元。');
    expect(checked.output).toBe('修订稿'); expect(call).toHaveBeenCalledTimes(3);
  });
  it('does not revise without enough remaining budget for revision and recheck', async () => {
    const call = vi.fn<LLMProvider['call']>().mockResolvedValue(response(JSON.stringify(review('合计310万元。', false))));
    const checked = await verifyOfficeDelivery({ ...options(call), maxCost: 0.011 });
    expect(checked.review.status).toBe('needs_revision'); expect(checked.review.issues.join()).toContain('预算不足');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('honors cancellation after a billed response and never starts a revision', async () => {
    const controller = new AbortController();
    const call = vi.fn<LLMProvider['call']>().mockImplementation(async () => { controller.abort(); return response(JSON.stringify(review('合计310万元。', false))); });
    const progress: OfficeDeliveryResult[] = [];
    const opts = { ...options(call), signal: controller.signal, onProgress: (value: OfficeDeliveryResult) => { progress.push(value); } };
    await expect(verifyOfficeDelivery(opts)).rejects.toThrow();
    expect(opts.costTracker.totalCost).toBeCloseTo(0.01); expect(call).toHaveBeenCalledTimes(1);
    expect(progress[0].review.receipt?.status).toBe('pending');
    expect(progress.at(-1)?.review).toMatchObject({ status: 'unverified', receipt: { status: 'received', usage: { cost: .01 }, rawOutput: expect.stringContaining('areas') } });
  });
  it('waits for durable admission before calling the model and isolates callback snapshots', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const snapshots: OfficeDeliveryResult[] = [];
    const call = vi.fn<LLMProvider['call']>().mockResolvedValue(response(JSON.stringify(review('合计310万元。'))));
    const running = verifyOfficeDelivery({ ...options(call), onProgress: async value => { snapshots.push(value); await gate; } });
    expect(call).not.toHaveBeenCalled(); release();
    const result = await running;
    expect(snapshots[0].review.receipt?.status).toBe('pending');
    expect(snapshots.at(-1)?.review.status).toBe('passed');
    snapshots.at(-1)!.review.checks.length = 0;
    expect(result.review.checks.length).toBeGreaterThan(0);
  });
  it.each([1, 2, 3])('does not start further calls or disguise a progress save failure at write %s', async failingWrite => {
    const call = vi.fn<LLMProvider['call']>().mockResolvedValue(response(JSON.stringify(review('合计310万元。', false))));
    let writes = 0;
    await expect(verifyOfficeDelivery({ ...options(call), onProgress: () => { if (++writes === failingWrite) throw new Error('disk full'); } })).rejects.toThrow('disk full');
    expect(call).toHaveBeenCalledTimes(failingWrite === 1 ? 0 : 1);
  });
  it('retains completed original checks and a paid revision when cancellation races the revision return', async () => {
    const controller = new AbortController(), progress: OfficeDeliveryResult[] = [];
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(response(JSON.stringify(review('合计310万元。', false))))
      .mockImplementationOnce(async () => { controller.abort(); return response('已返回修订原文'); });
    const opts = { ...options(call), signal: controller.signal, onProgress: (value: OfficeDeliveryResult) => { progress.push(value); } };
    await expect(verifyOfficeDelivery(opts)).rejects.toThrow();
    expect(progress.at(-1)).toMatchObject({ output: opts.output, review: { status: 'needs_revision', revisionAttempt: { status: 'received', rawOutput: '已返回修订原文', usage: { cost: .01 } } } });
    expect(progress.at(-1)?.review.checks.length).toBeGreaterThan(0);
    expect(opts.costTracker.totalCost).toBeCloseTo(.02); expect(call).toHaveBeenCalledTimes(2);
  });
  it('saves the revised draft and original review while the recheck is cancelled', async () => {
    const controller = new AbortController(), progress: OfficeDeliveryResult[] = [];
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(response(JSON.stringify(review('合计310万元。', false))))
      .mockResolvedValueOnce(response('修订后的正文'))
      .mockImplementationOnce(async () => { controller.abort(); throw new Error('private provider body'); });
    const opts = { ...options(call), signal: controller.signal, onProgress: (value: OfficeDeliveryResult) => { progress.push(value); } };
    await expect(verifyOfficeDelivery(opts)).rejects.toThrow();
    expect(progress.at(-1)).toMatchObject({ output: '修订后的正文', review: { status: 'unverified', receipt: { status: 'request_failed', unsettledRequests: 1 }, previous: { output: opts.output, review: { status: 'needs_revision', revisionAttempt: { status: 'received' } } } } });
    expect(JSON.stringify(progress)).not.toContain('private provider body');
    expect(opts.costTracker.totalCost).toBeCloseTo(.02); expect(call).toHaveBeenCalledTimes(3);
  });
  it('does not reclassify a saved revised review failure as an upstream revision error', async () => {
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(response(JSON.stringify(review('合计310万元。', false))))
      .mockResolvedValueOnce(response('修订稿')).mockResolvedValueOnce(response(JSON.stringify(review('修订稿'))));
    const saved: OfficeDeliveryResult[] = [];
    await expect(verifyOfficeDelivery({ ...options(call), onProgress: value => {
      saved.push(value);
      if (value.review.previous && value.review.receipt?.status === 'received') throw new Error('final review save failed');
    } })).rejects.toThrow('final review save failed');
    expect(call).toHaveBeenCalledTimes(3);
    expect(saved.at(-1)?.review.previous?.review.revisionAttempt?.status).toBe('received');
  });
});
