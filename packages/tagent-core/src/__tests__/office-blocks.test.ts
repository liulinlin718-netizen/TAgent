import { describe, expect, it, vi } from 'vitest';
import { CostTracker, type LLMProvider, type LLMResponse } from '@tagent/ai';
import { officeOutputBlocks, officeTableRows, type OfficeBlockSchema } from '../office-blocks.js';
import { officeReviewTemplate, parseOfficeReview, verifyOfficeDelivery } from '../office-delivery.js';

const schema = 'table-rows-v1';
const input = '任务甲依赖需求确认。其他人员配置材料未提供。';
const table = '| 风险 | 影响 |\n| --- | --- |\n| 需求确认延后 | 后续任务相应顺延 |\n| 人员资料未提供 | 项目无人负责 |';
const output = '## 风险清单\n\n以下按给定材料整理。\n\n' + table + '\n\n未执行外部操作。';
const materials = [{ id: 'input', label: '给定材料', text: input }];
function verdict(body: string, blockSchema: OfficeBlockSchema = schema) {
  const value = officeReviewTemplate(body, blockSchema);
  return { ...value, areas: value.areas.map(area => ({ ...area, status: 'passed', reason: '模拟协议检查' })),
    blocks: value.blocks.map(block => ({ ...block, verdict: 'grounded', reason: '模拟有依据判断', evidence: [{ materialId: 'input', quote: input }] })) };
}

describe('versioned office review blocks', () => {
  it('reads named cells independently of numbering, outer pipes, emphasis and escaped pipes', () => {
    const body = '**材料依据** | # | 风险名称\n--- | --- | ---\n未说明缓冲 | 1 | 缓冲未纳入\\|排期';
    expect(officeTableRows(body)).toEqual([{ text: '未说明缓冲 | 1 | 缓冲未纳入\\|排期', cells: [
      { header: '材料依据', text: '未说明缓冲' }, { header: '#', text: '1' }, { header: '风险名称', text: '缓冲未纳入|排期' },
    ] }]);
  });
  it('does not guess cells for malformed rows, quoted tables or code examples', () => {
    const body = '| 风险 | 材料依据 |\n| --- | --- |\n| 缓冲未纳入 | 未说明 | 多余列 |';
    expect(officeTableRows(body)).toEqual([]);
    expect(officeTableRows('```md\n' + table + '\n```')).toEqual([]);
    expect(officeTableRows(table.split('\n').map(line => '> ' + line).join('\n'))).toEqual([]);
  });
  it('keeps legacy paragraph numbering as the default for historical receipts', () => {
    const legacy = officeOutputBlocks(output);
    expect(legacy).toEqual(output.trim().split(/\n\s*\n/).map((text, index) => ({ index, text })));
    expect(legacy).toHaveLength(4);
    const checked = parseOfficeReview(JSON.stringify(verdict(output, 'paragraph-v1')), input, output, materials, 'fixture');
    expect(checked.coverage).toEqual({ expectedBlocks: 4, checkedBlocks: 4 });
    expect(checked.blockSchema).toBe('paragraph-v1');
  });

  it('gives each top-level table row its own exact quote, header and section context', () => {
    const blocks = officeOutputBlocks(output, schema);
    expect(blocks).toHaveLength(6);
    expect(blocks.map(block => block.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(blocks[2]).toMatchObject({ label: '表格 1 · 表头', text: '| 风险 | 影响 |\n| --- | --- |' });
    expect(blocks[4]).toEqual({ index: 4, text: '| 人员资料未提供 | 项目无人负责 |', label: '表格 1 · 第 2 行',
      context: { section: '## 风险清单', tableHeader: '| 风险 | 影响 |' } });
    for (const block of blocks) expect(output).toContain(block.text);
    expect(blocks[5].text).toBe('未执行外部操作。');
  });

  it.each(['\n', '\r\n'])('preserves escaped pipes, inline code, Unicode and original offsets (%j)', newline => {
    const body = ['## 中文报告 🌐', '', '| 事项 | 原值 |', '| :--- | ---: |', '| 甲\\|乙 | `x\\|y` |', '| 新值 | 30 |'].join(newline);
    const blocks = officeOutputBlocks(body, schema);
    expect(blocks).toHaveLength(4);
    expect(blocks[2].text).toBe('| 甲\\|乙 | `x\\|y` |');
    expect(blocks[2].context?.section).toBe('## 中文报告 🌐');
    expect(blocks[1].text).toBe(['| 事项 | 原值 |', '| :--- | ---: |'].join(newline));
    for (const block of blocks) expect(body).toContain(block.text);
  });

  it('recognizes GFM tables without outer pipes and with empty or extra cells without dropping raw content', () => {
    const body = '事项 | 状态\n--- | ---\n甲 |\n乙 | 原文 | 额外单元格';
    const blocks = officeOutputBlocks(body, schema);
    expect(blocks.map(block => block.text)).toEqual(['事项 | 状态\n--- | ---', '甲 |', '乙 | 原文 | 额外单元格']);
  });

  it.each([
    '```markdown\n' + table + '\n```',
    table.split('\n').map(line => '> ' + line).join('\n'),
    '- 示例\n\n' + table.split('\n').map(line => '  ' + line).join('\n'),
    '| 普通 | 文字 |\n| 无分隔行 | 不猜表格 |',
  ])('does not isolate rows from fenced, quoted, nested or malformed table-like text', body => {
    expect(officeOutputBlocks(body, schema)).toEqual(officeOutputBlocks(body));
  });

  it('retains every table and intervening section while keeping each header separate', () => {
    const body = '## 输入\n\n| 日期 | 数量 |\n| --- | --- |\n| 今天 | 10 |\n\n## 输出\n\n| 对象 | 结果 |\n| --- | --- |\n| 甲 | 待确认 |';
    const rows = officeOutputBlocks(body, schema).filter(block => block.context?.tableHeader);
    expect(rows).toHaveLength(2);
    expect(rows[0].context).toEqual({ section: '## 输入', tableHeader: '| 日期 | 数量 |' });
    expect(rows[1]).toMatchObject({ label: '表格 2 · 第 1 行', context: { section: '## 输出', tableHeader: '| 对象 | 结果 |' } });
  });

  it('keeps an empty-body table header and adjacent non-table text', () => {
    const body = '说明\n\n| 列 | 值 |\n| --- | --- |\n\n后文';
    expect(officeOutputBlocks(body, schema).map(block => block.text)).toEqual(['说明', '| 列 | 值 |\n| --- | --- |', '后文']);
  });

  it('rejects an unknown version instead of silently renumbering it', () => {
    expect(() => officeOutputBlocks(output, 'future-v9' as OfficeBlockSchema)).toThrow('版本');
  });

  it('requires every row verdict and never fills missing rows from a whole-table or header verdict', () => {
    const value = verdict(output);
    value.blocks.splice(4, 1);
    expect(() => parseOfficeReview(JSON.stringify(value), input, output, materials, 'fixture', schema)).toThrow('全部输出');
    expect(() => parseOfficeReview(JSON.stringify(verdict(output, 'paragraph-v1')), input, output, materials, 'fixture', schema)).toThrow('全部输出');
  });

  it('keeps the precise failed row without changing the other independently checked rows', () => {
    const value = verdict(output);
    value.blocks[4].verdict = 'unsupported';
    const checked = parseOfficeReview(JSON.stringify(value), input, output, materials, 'fixture', schema);
    expect(checked.status).toBe('needs_revision');
    expect(checked.blockSchema).toBe(schema);
    expect(checked.checks.find(check => check.id === 'block-3')?.status).toBe('passed');
    expect(checked.checks.find(check => check.id === 'block-4')).toMatchObject({ status: 'failed', label: '表格 1 · 第 2 行', outputQuote: '| 人员资料未提供 | 项目无人负责 |' });
    expect(checked.coverage).toEqual({ expectedBlocks: 6, checkedBlocks: 6 });
  });

  it('does not treat table context as a new material source', () => {
    const value = verdict(output);
    value.blocks[4].evidence = [{ materialId: 'tableHeader', quote: '| 风险 | 影响 |' }];
    expect(() => parseOfficeReview(JSON.stringify(value), input, output, materials, 'fixture', schema)).toThrow('未提供');
  });

  it('passes the new schema to live verification and retains it in pending and final records', async () => {
    const call = vi.fn<LLMProvider['call']>(async params => {
      const payload = JSON.parse(params.messages[1].content);
      expect(payload.blockSchema).toBe(schema);
      expect(payload.blocks).toEqual(officeOutputBlocks(output, schema));
      expect(payload.responseTemplate).toEqual(officeReviewTemplate(output, schema));
      expect(params.tools).toBeUndefined();
      return { content: JSON.stringify(verdict(output)), toolCalls: [], stopReason: 'end', model: 'deepseek-chat',
        usage: { inputTokens: 100, outputTokens: 100, cost: .001 } } as LLMResponse;
    });
    const saved: string[] = [];
    const result = await verifyOfficeDelivery({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: input, materials, output, qualityChecks: [], costTracker: new CostTracker(), maxCost: .1,
      onProgress: item => { saved.push(item.review.blockSchema!); } });
    expect(saved).toEqual([schema, schema]);
    expect(result.review.coverage).toEqual({ expectedBlocks: 6, checkedBlocks: 6 });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('performs only one review and preserves failures when revisions are explicitly disabled', async () => {
    const value = verdict(output); value.blocks[4].verdict = 'unsupported';
    const call = vi.fn<LLMProvider['call']>().mockResolvedValue({ content: JSON.stringify(value), toolCalls: [], stopReason: 'end', model: 'deepseek-chat',
      usage: { inputTokens: 100, outputTokens: 100, cost: .001 } });
    const result = await verifyOfficeDelivery({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: input, materials, output, qualityChecks: [], costTracker: new CostTracker(), maxCost: 1, maxRevisions: 0 });
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.output).toBe(output);
    expect(result.review.status).toBe('needs_revision');
    expect(result.review.previous).toBeUndefined();
    expect(result.review.revisionAttempt).toBeUndefined();
  });

  it('retains the entire long table as unverified when row coverage would exceed the existing limit', async () => {
    const body = '| 行 | 值 |\n| --- | --- |\n' + Array.from({ length: 80 }, (_, index) => `| ${index} | 待核对 |`).join('\n');
    const call = vi.fn<LLMProvider['call']>();
    const result = await verifyOfficeDelivery({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: input, materials, output: body, qualityChecks: [], costTracker: new CostTracker(), maxCost: 1 });
    expect(call).not.toHaveBeenCalled();
    expect(result.output).toBe(body);
    expect(result.review).toMatchObject({ blockSchema: schema, status: 'unverified', coverage: { expectedBlocks: 81, checkedBlocks: 0 } });
  });
});
