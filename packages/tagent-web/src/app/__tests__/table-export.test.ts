import { describe, expect, it } from 'vitest';
import { load } from 'cheerio';
import { fromBuffer } from 'yauzl';
import type { TableAnalysisReceipt } from '@tagent/core';
import { createTableAnalysisTools } from '../../../../tagent-core/src/tools/table-analysis';
import { encodeTableWorkbook, tableWorkbook, workbookNumber, type TableExportContext } from '../../lib/table-workbook';

const context = { eventId: 'event-fixture', runId: 'run-fixture', agentId: 'data-agent', persisted: true };
async function calculate(table = '月份,收入\n1月,0.1\n1月,0.2\n2月,0.6', options: Record<string, unknown> = {}) {
  const [, tool] = createTableAnalysisTools(`private-task-sentinel\n${table}`);
  const receipt = JSON.parse(await tool.execute({ sourceId: 'current', startLine: 2, endLine: table.split('\n').length + 1, format: 'csv',
    action: 'aggregate', ...(options.action === 'inspect' ? {} : { groupBy: ['月份'], metrics: [{ column: '收入', operation: 'sum' }], compare: { baseline: ['1月'], current: ['2月'], metric: 0 } }), ...options }));
  expect(receipt.error).toBeUndefined();
  return receipt as TableAnalysisReceipt;
}

async function unpack(blob: Blob): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const buffer = Buffer.from(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error); return; }
      zip.on('error', reject); zip.on('end', () => resolve(files));
      zip.on('entry', entry => {
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { reject(error); return; }
          const chunks: Buffer[] = [];
          stream.on('data', chunk => chunks.push(chunk)); stream.on('error', reject);
          stream.on('end', () => { files.set(entry.fileName, Buffer.concat(chunks).toString('utf8')); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

async function readWorkbook(receipt: unknown, exportContext: TableExportContext = context) {
  const output = await encodeTableWorkbook(receipt, exportContext);
  const files = await unpack(output.blob);
  const strings = load(files.get('xl/sharedStrings.xml') || '', { xmlMode: true });
  const shared = strings('si').toArray().map(item => strings(item).find('t').toArray().map(node => strings(node).text()).join(''));
  const names = load(files.get('xl/workbook.xml')!, { xmlMode: true })('sheet').toArray().map(node => node.attribs.name);
  const sheets = new Map(names.map((name, index) => {
    const $ = load(files.get(`xl/worksheets/sheet${index + 1}.xml`)!, { xmlMode: true });
    return [name, { xml: $, rows: $('sheetData row').toArray().map(row => $(row).children('c').toArray().map(cell => {
      const t = $(cell).attr('t') || 'n', raw = $(cell).children('v').text();
      return { type: t, value: t === 's' ? shared[Number(raw)] : t === 'inlineStr' ? $(cell).find('is t').text() : raw };
    })) }];
  }));
  return { ...output, files, sheets };
}

describe('Excel calculation delivery', () => {
  it('writes actual tool results as usable values, with freeze panes, visible status and provenance', async () => {
    const value = await calculate(), book = await readWorkbook(value);
    expect([...book.sheets.keys()]).toEqual(['统计结果', '基期与本期', '计算说明']);
    const results = book.sheets.get('统计结果')!;
    expect(results.rows).toHaveLength(3);
    expect(results.rows[1][4]).toEqual({ type: 'n', value: '0.3' });
    expect(results.rows[2][4]).toEqual({ type: 'n', value: '0.6' });
    expect(results.xml('pane').attr('state')).toBe('frozen');
    const comparison = book.sheets.get('基期与本期')!.rows[1];
    expect(comparison[4].value).toBe('0.3'); expect(comparison[5].value).toBe('100');
    const all = [...book.files.values()].join('\n');
    expect(all).toContain(value.provenance.selectionSha256); expect(all).toContain(context.eventId); expect(all).toContain(context.runId);
    expect(all).not.toContain('private-task-sentinel');
    expect(book.fileName).toMatch(/^tagent-统计结果-[a-f0-9]{12}\.xlsx$/);
    expect(await unpack(book.blob)).toEqual(book.files);
  });

  it.each(['0', '0.3', '-0.3', '999999999999999', '0.123456789123456'])('keeps %s numeric when Excel can preserve it', value => {
    expect(workbookNumber(value)).toMatchObject({ type: Number, value: Number(value) });
  });
  it.each(['1234567890123456', '0.1234567890123456', '0.000000000000000000000001', '-1234567890123456'])('does not lose precision for %s', value => {
    expect(workbookNumber(value)).toMatchObject({ type: String, value, format: '@' });
  });
  it('roundtrips long precise values and emoji without interpreting labels as dates or numbers', async () => {
    const value = await calculate('月份,收入\n001😀,1234567890123456\n2026-01,0.000000000000000000000001', { compare: undefined });
    const book = await readWorkbook(value), rows = book.sheets.get('统计结果')!.rows;
    expect(rows[1][0]).toEqual({ type: 's', value: '001😀' });
    expect(rows[2][0]).toEqual({ type: 's', value: '2026-01' });
    expect(rows[1][4]).toEqual({ type: 's', value: '1234567890123456' });
    expect(rows[2][4]).toEqual({ type: 's', value: '0.000000000000000000000001' });
  });
  it('retains missing/invalid results, exception samples and unavailable comparison rather than zero', async () => {
    const value = await calculate('月份,收入\n1月,=2+2\n1月,\n2月,0.6');
    const book = await readWorkbook(value), rows = book.sheets.get('统计结果')!.rows;
    expect(rows[1][4]).toEqual({ type: 's', value: '未计算' });
    expect(rows[1].map(cell => cell.value)).toContain('含无效值，未计算');
    expect(rows[1][7].value).toBe('1'); expect(rows[1][8].value).toBe('1');
    expect(book.sheets.get('异常样本')!.rows[1].at(-1)).toEqual({ type: 's', value: '=2+2' });
    expect(book.sheets.get('基期与本期')!.rows[1][5].value).toBe('未计算');
  });
  it('exports partial exclusions and zero/negative baseline warnings', async () => {
    const value = await calculate('月份,收入\n1月,-1\n1月,invalid\n2月,2', { invalidValues: 'exclude' });
    const book = await readWorkbook(value), result = book.sheets.get('统计结果')!.rows[1], comparison = book.sheets.get('基期与本期')!.rows[1];
    expect(result[4].value).toBe('-1'); expect(result[5].value).toBe('部分数据');
    expect(comparison[5].value).toBe('未计算'); expect(comparison[6].value).toContain('零或负基期');
    expect(comparison[7].value).toContain('含缺失或无效');
  });
  it('never exports an empty numeric group as a zero total', async () => {
    const book = await readWorkbook(await calculate('月份,收入\n1月,\n2月,0.6'));
    const rows = book.sheets.get('统计结果')!.rows;
    expect(rows[1][4]).toEqual({ type: 's', value: '未计算' });
    expect(rows[1][5].value).toBe('无有效数值');
    expect(book.sheets.get('基期与本期')!.rows[1][5].value).toBe('未计算');
  });
  it('exports every group and separate dimensions, not the visible UI page or concatenated names', async () => {
    const data = '月份,区域,收入\n' + Array.from({ length: 100 }, (_, index) => `组${index},A / B,1`).join('\n');
    const value = await calculate(data, { groupBy: ['月份', '区域'], compare: undefined });
    const book = await readWorkbook(value), rows = book.sheets.get('统计结果')!.rows;
    expect(rows).toHaveLength(101); expect(rows[100][0].value).toBe('组99'); expect(rows[100][1].value).toBe('A / B');
  });
  it('writes inspection samples as explicitly limited text, not as a full original worksheet', async () => {
    const value = await calculate('月份,收入\n' + Array.from({ length: 9 }, (_, index) => `${'长'.repeat(170)},${index}`).join('\n'), { action: 'inspect', compare: undefined });
    const book = await readWorkbook(value);
    expect([...book.sheets.keys()]).toEqual(['字段检查', '前5条样本', '计算说明']);
    const rows = book.sheets.get('前5条样本')!.rows;
    expect(rows).toHaveLength(6); expect(rows[1][1].value).toHaveLength(160);
  });
  it('never creates formulas, macros, hyperlinks or external relationships from cell text', async () => {
    const malicious = '=HYPERLINK("https://example.com/collect","open")';
    const data = '月份,收入\n"' + malicious.replaceAll('"', '""') + '",=2+2\n@SUM(A1),1\n+cmd,2\n-cmd,3';
    const book = await readWorkbook(await calculate(data, { compare: undefined }));
    expect(book.sheets.get('统计结果')!.rows[1][0].value).toBe(malicious);
    for (const [name, content] of book.files) {
      expect(name).not.toMatch(/vbaProject|externalLinks|activeX|oleObjects/i);
      if (name.endsWith('.xml') || name.endsWith('.rels')) {
        const $ = load(content, { xmlMode: true });
        expect($('f, hyperlink, Relationship[TargetMode="External"]')).toHaveLength(0);
      }
    }
  });
  it('does not claim a running or unpersisted task is a final saved deliverable', async () => {
    const book = await readWorkbook(await calculate(), { ...context, persisted: false, running: true });
    const details = book.sheets.get('计算说明')!.rows.flat().map(cell => cell.value).join('\n');
    expect(details).toContain('任务尚在运行'); expect(details).toContain('下载不代表后端保存成功');
  });
  it('refuses malformed/oversized receipts and unsupported XML characters without generating partial exports', async () => {
    expect(() => tableWorkbook({ version: 99 }, context)).toThrow('计算记录不完整');
    const value = await calculate();
    if (value.action !== 'aggregate') throw new Error('fixture');
    value.groups[0].key[0] = 'bad\u0000'; value.comparison = undefined;
    expect(() => tableWorkbook(value, context)).toThrow('Excel 无法完整保存');
    value.groups = Array.from({ length: 100 }, (_, index) => ({ key: [String(index) + 'x'.repeat(1900)], rows: 1, metrics: [{ ...value.groups[1].metrics[0], valid: 1 }] }));
    value.provenance.rows = 100;
    expect(() => tableWorkbook(value, context)).toThrow('超过导出上限');
  });
});
