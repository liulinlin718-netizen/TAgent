import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildConversationContext } from '../conversation-context.js';
import { createTableAnalysisTools, type TableAnalysisReceipt } from '../tools/table-analysis.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const fixture = '请按原表分析，不联网。\r\n月份,收入,订单\r\n1月,0.1,2\r\n1月,0.2,3\r\n2月,0.6,5\r\n\r\n单位：万元。';
const selection = { sourceId: 'current', startLine: 2, endLine: 5, format: 'csv' };
const measures = [{ column: '收入', operation: 'sum' }, { column: '订单', operation: 'mean' }];
async function analyze(text: string, args: Record<string, unknown> = {}) {
  const [, tool] = createTableAnalysisTools(text);
  return JSON.parse(await tool.execute({ sourceId: 'current', startLine: 1, endLine: text.split(/\r\n|\n|\r/).length,
    format: 'csv', action: 'aggregate', metrics: [{ column: '值', operation: 'sum' }], ...args }));
}

describe('source-bound read-only table analysis', () => {
  it('reads original numbered lines, exact hashes and complete paginated content', async () => {
    const [read] = createTableAnalysisTools(fixture);
    const catalog = JSON.parse(await read.execute({}));
    expect(catalog.sources[0]).toMatchObject({ id: 'current', sha256: sha(fixture), lines: 7 });
    const chunk = JSON.parse(await read.execute({ sourceId: 'current', startLine: 2, lineCount: 3 }));
    expect(chunk.lines).toEqual([{ line: 2, text: '月份,收入,订单' }, { line: 3, text: '1月,0.1,2' }, { line: 4, text: '1月,0.2,3' }]);
    expect(chunk.nextLine).toBe(5);
    expect(JSON.parse(await read.execute({ sourceId: 'current', startLine: 5 })).nextLine).toBeNull();
  });
  it('uses decimal arithmetic on the selected raw range and compares explicit groups', async () => {
    const receipt = vi.fn<(value: TableAnalysisReceipt) => void>();
    const [, tool] = createTableAnalysisTools(fixture, undefined, receipt);
    const output = JSON.parse(await tool.execute({ ...selection, action: 'aggregate', metrics: measures, groupBy: ['月份'],
      compare: { baseline: ['1月'], current: ['2月'], metric: 0 } }));
    expect(output.provenance).toMatchObject({ sourceSha256: sha(fixture), selectionSha256: sha(fixture.split('\r\n').slice(1, 5).join('\r\n')),
      rows: 3, startLine: 2, endLine: 5 });
    expect(output.groups[0].metrics.map((metric: { value: string }) => metric.value)).toEqual(['0.3', '2.5']);
    expect(output.comparison).toMatchObject({ difference: '0.3', percentChange: '100', status: 'computed', partial: false });
    expect(output).toMatchObject({ executedCode: false, localOnly: true });
    expect(receipt).toHaveBeenCalledWith(output);
    receipt.mock.calls[0][0].provenance.columns.push('mutated');
    expect(output.provenance.columns).not.toContain('mutated');
  });
  it.each(['csv', 'tsv', 'semicolon'])('parses %s quoting, BOM, embedded newlines and literal formulas without evaluation', async format => {
    const delimiter = { csv: ',', tsv: '\t', semicolon: ';' }[format]!;
    const text = '\uFEFF备注' + delimiter + '值\r\n"A' + delimiter + 'B\nC"' + delimiter + '0.1\r\n"=1+2"' + delimiter + '0.2';
    const output = await analyze(text, { format });
    expect(output.groups[0].metrics[0].value).toBe('0.3');
    expect(output.provenance.rows).toBe(2);
    const inspected = await analyze(text, { format, action: 'inspect', metrics: undefined });
    expect(inspected.sample[0].values[0]).toBe('A' + delimiter + 'B\nC');
    expect(inspected.sample[1].values[0]).toBe('=1+2');
  });
  it('parses a GFM table using the existing Markdown ecosystem, including escaped pipes and formatted numerals', async () => {
    const output = await analyze('|备注|值|\n|---|---:|\n|A\\|B|**0.1**|\n|C|`0.2`|', { format: 'markdown' });
    expect(output.groups[0].metrics[0].value).toBe('0.3');
    expect(output.provenance.rows).toBe(2);
  });
  it.each(['值,值\n1,2', ' ,值\n1,2', '名,值\na,1,extra', '名,值\na,1\n\nb,2', '名,值\n"broken,1', '|名|值|\n|--|--|\n|a|1|extra|', '|名|值|\n|--|--|\n|a|'])('rejects ambiguous headers or malformed/ragged data: %s', async text => {
    await expect(analyze(text, { format: text.startsWith('|') ? 'markdown' : 'csv' })).rejects.toThrow();
  });
  it('does not silently accept prose adjacent to a Markdown table or execute HTML cells', async () => {
    for (const text of ['文本\n\n|名|值|\n|--|--|\n|a|1|', '|名|值|\n|--|--|\n|a|<b>1</b>|']) {
      await expect(analyze(text, { format: 'markdown' })).rejects.toThrow();
    }
  });
  it('profiles missing and non-numeric cells, then blocks affected totals unless exclusion is explicit', async () => {
    const text = '名,值\na,1\nb,\nc,=2+2\nd,"1,000"\ne,10%\nf,N/A';
    const inspected = await analyze(text, { action: 'inspect', metrics: undefined });
    expect(inspected.profile[1]).toEqual({ column: '值', missing: 1, numeric: 1, nonNumeric: 4 });
    const blocked = await analyze(text);
    expect(blocked.groups[0].metrics[0]).toMatchObject({ status: 'invalid_values', value: null, missing: 1, invalid: 4, valid: 1 });
    const excluded = await analyze(text, { invalidValues: 'exclude' });
    expect(excluded.groups[0].metrics[0]).toMatchObject({ status: 'partial', value: '1', missing: 1, invalid: 4 });
    expect(excluded.groups[0].metrics[0].invalidExamples[0]).toEqual({ record: 3, value: '=2+2' });
    const count = await analyze(text, { metrics: [{ column: '值', operation: 'count' }] });
    expect(count.groups[0].metrics[0]).toMatchObject({ value: '5', missing: 1, invalid: 0 });
  });
  it('keeps all-missing sums null and computes exact min/max and bounded-rounded averages', async () => {
    expect((await analyze('名,值\na,\nb,')).groups[0].metrics[0]).toMatchObject({ value: null, status: 'no_numeric_values' });
    const result = await analyze('名,值\na,1\nb,0\nc,0\nd,', { metrics: ['mean', 'min', 'max'].map(operation => ({ column: '值', operation })) });
    expect(result.groups[0].metrics.map((metric: { value: string }) => metric.value)).toEqual(['0.33333333', '0', '1']);
    expect(result.groups[0].metrics.every((metric: { status: string }) => metric.status === 'partial')).toBe(true);
    expect((await analyze('名,值\na,9007199254740993\nb,0.00000001')).groups[0].metrics[0].value).toBe('9007199254740993.00000001');
  });
  it.each(['0', '-10'])('does not invent normal growth rates for a %s baseline', async baseline => {
    const output = await analyze(`月,值\n1,${baseline}\n2,10`, { groupBy: ['月'], compare: { baseline: ['1'], current: ['2'], metric: 0 } });
    expect(output.comparison).toMatchObject({ status: 'non_positive_baseline', percentChange: null });
  });
  it('uses explicit group keys instead of assuming row order is chronological', async () => {
    const output = await analyze('月,值\n2,90\n1,120', { groupBy: ['月'], compare: { baseline: ['1'], current: ['2'], metric: 0 } });
    expect(output.comparison).toMatchObject({ percentChange: '-25', difference: '-30' });
    expect(output.groups.map((group: { key: string[] }) => group.key)).toEqual([['2'], ['1']]);
  });
  it('excludes assistant outputs, quotes, summaries and truncated history, and snapshots eligible user inputs', async () => {
    const context = buildConversationContext('ws', 's', [
      { id: 'u', role: 'user', content: '名,值\na,2', timestamp: 'old' },
      { id: 'a', role: 'assistant', content: '名,值\na,999', timestamp: 'old' },
      { id: 's', role: 'user', content: '名,值\na,888', timestamp: 'old', contextKind: 'fork_summary' },
      { id: 'long', role: 'user', content: '名,值\n' + 'a,1\n'.repeat(4000), timestamp: 'old' },
    ]);
    context.items.find(item => item.id === 's')!.kind = 'quoted_excerpt';
    const [read, tool] = createTableAnalysisTools('继续分析原始数据', context);
    context.items[0].content = '名,值\na,999';
    const catalog = JSON.parse(await read.execute({}));
    expect(catalog.sources.map((source: { id: string }) => source.id)).toEqual(['current', 'history:u']);
    expect(catalog.excludedHistory).toEqual(['a', 's', 'long']);
    const result = JSON.parse(await tool.execute({ sourceId: 'history:u', startLine: 1, endLine: 2, format: 'csv', action: 'aggregate', metrics: [{ column: '值', operation: 'sum' }] }));
    expect(result.groups[0].metrics[0].value).toBe('2');
    await expect(read.execute({ sourceId: 'history:a' })).rejects.toThrow('原文');
  });
  it.each([{ data: '值\n999' }, { path: 'C:/private.csv' }, { url: 'https://example.com' }, { code: 'process.exit()' }, { startLine: 0 }, { endLine: 999 }, { sourceId: 'foreign' },
    { metrics: [{ column: '不存在', operation: 'sum' }] }, { groupBy: ['名', '名'] }, { compare: { baseline: ['missing'], current: ['a'], metric: 0 }, groupBy: ['名'] }])('rejects unbound input and invalid arguments %j', async args => {
    await expect(analyze('名,值\na,1', args)).rejects.toThrow();
  });
  it('enforces row, cell, group, source and numeric precision limits without returning partial totals', async () => {
    for (const text of ['名,值\n' + 'a,1\n'.repeat(5001), '名,值\n' + 'x'.repeat(2001) + ',1']) await expect(analyze(text)).rejects.toThrow();
    await expect(analyze('名,值\n' + Array.from({ length: 101 }, (_, i) => `${i},1`).join('\n'), { groupBy: ['名'] })).rejects.toThrow('100组');
    await expect(analyze('名,值\n' + '字'.repeat(22000))).rejects.toThrow('64 KiB');
    expect((await analyze(`名,值\na,${'1'.repeat(41)}`)).groups[0].metrics[0]).toMatchObject({ status: 'invalid_values', value: null });
  });
  it('respects cancellation and declares only trusted local read-only operations', async () => {
    const tools = createTableAnalysisTools(fixture), controller = new AbortController(); controller.abort();
    for (const tool of tools) {
      expect(tool.approval).toBe('local_read_only');
      await expect(tool.execute({}, { signal: controller.signal })).rejects.toThrow();
    }
  });
});
