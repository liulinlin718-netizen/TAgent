import { describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { previewTableImport, createTableImportRoutes } from '../table-import.js';
import { Hono } from 'hono';
import { limitRequestBody } from '../request-body.js';

const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const headers = '<row r="1"><c r="A1" t="inlineStr"><is><t>月份</t></is></c><c r="B1" t="inlineStr"><is><t>收入</t></is></c></row>';
const numbers = '<row r="2"><c r="A2" t="inlineStr"><is><t> 001😀 </t></is></c><c r="B2"><v>1234567890123456</v></c></row>';
function workbook(rows = headers + numbers, extra: Record<string, string> = {}, sheetAttrs = '', suffix = '') {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="原始数据" sheetId="1" r:id="rId1" ${sheetAttrs}/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${ns}"><sheetData>${rows}</sheetData>${suffix}</worksheet>`,
    ...extra,
  }).map(([name, value]) => [name, strToU8(value)])), { level: 0 }));
}
const read = (bytes: Buffer, name = '数据.xlsx', encoding = 'utf-8') => previewTableImport(bytes, name, encoding, new AbortController().signal);

describe('read-only table file preview', () => {
  it('reads actual XLSX strings/numbers without trimming labels, losing precision or saving', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const data = await read(workbook());
      expect(data.sheets[0].rows).toEqual([['月份', '收入'], [' 001😀 ', '1234567890123456']]);
      expect(data).toMatchObject({ version: 1, requiresConfirmation: true, willWrite: false, willExecute: false });
      expect(data.file.sha256).toMatch(/^[a-f0-9]{64}$/); expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it('preserves cached, uncached, error formula cells and their coordinates without executing formulas', async () => {
    const data = await read(workbook(headers + '<row r="2"><c r="A2"><f>1+2</f><v>3</v></c><c r="B2"><f>SUM(B3:B4)</f></c></row><row r="3"><c r="A3" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>'));
    expect(data.sheets[0]).toMatchObject({ formulaCells: ['A2', 'B2', 'A3'], missingFormulaCells: ['B2'], errorCells: ['A3'] });
    expect(data.sheets[0].rows[1]).toEqual(['3', '[公式无已保存结果]']);
    expect(data.sheets[0].rows[2][0]).toContain('#DIV/0!');
  });
  it('keeps hidden sheets/rows/columns and merge definitions without filling missing cells', async () => {
    const data = await read(workbook(headers + numbers.replace('<row r="2">', '<row r="2" hidden="1">'), {}, 'state="veryHidden"',
      '<cols><col min="1" max="1" hidden="1"/></cols><mergeCells><mergeCell ref="A2:B2"/></mergeCells>'));
    expect(data.sheets[0]).toMatchObject({ hidden: true, hiddenRows: [2], hiddenColumns: [1], mergedRanges: ['A2:B2'] });
  });
  it('retains leading empty rows and columns for original range selection', async () => {
    const data = await read(workbook('<row r="3"><c r="B3" t="inlineStr"><is><t>表头</t></is></c></row><row r="4"><c r="B4"><v>7</v></c></row>'));
    expect(data.sheets[0].rows).toEqual([['', ''], ['', ''], ['', '表头'], ['', '7']]);
  });
  it.each(['csv', 'tsv'])('reads %s quoting and formula-like text as literal values', async format => {
    const sep = format === 'tsv' ? '\t' : ',';
    const data = await read(Buffer.from(`名称${sep}备注\r\n"A${sep}B"${sep}"=HYPERLINK(""https://example.com"",""x"")"\r\n`), `材料.${format}`);
    expect(data.sheets[0].rows[1]).toEqual([`A${sep}B`, '=HYPERLINK("https://example.com","x")']);
  });
  it('supports explicit UTF-16LE and fails invalid UTF-8 rather than emitting replacement characters', async () => {
    expect((await read(Buffer.from('\ufeff列\r\n中文', 'utf16le'), '表.csv', 'utf-16le')).sheets[0].rows).toEqual([['列'], ['中文']]);
    await expect(read(Buffer.from([0xc3, 0x28]), '坏.csv')).rejects.toThrow('无法完整读取');
  });
  it.each(['bad.xls', 'bad.xlsm', '../bad.xlsx', 'bad\n.xlsx'])('rejects %s without reading', async name => {
    await expect(read(workbook(), name)).rejects.toThrow();
  });
  it('rejects empty, oversize, corrupt ZIP and bad CSV shapes', async () => {
    await expect(read(Buffer.alloc(0))).rejects.toThrow('非空');
    await expect(read(Buffer.alloc(2 * 1024 * 1024 + 1))).rejects.toThrow('2 MiB');
    await expect(read(Buffer.from('not a zip'))).rejects.toThrow('无法完整读取');
    await expect(read(Buffer.from('A,B\n1,2,3'), '表.csv')).rejects.toThrow('无法完整读取');
  });
  it.each(['xl/vbaProject.bin', 'xl/externalLinks/externalLink1.xml', 'xl/embeddings/object.bin', 'xl/connections.xml'])('blocks active/external parts: %s', async part => {
    await expect(read(workbook(undefined, { [part]: 'untrusted' }))).rejects.toThrow('宏、嵌入对象或外部数据连接');
  });
  it('rejects sparse runaway ranges, duplicate cells, XML entities and decompression overflow', async () => {
    await expect(read(workbook(headers + numbers.replaceAll('r="2"', 'r="999999"').replaceAll('A2', 'A999999').replaceAll('B2', 'B999999')))).rejects.toThrow('超限');
    await expect(read(workbook(headers + numbers + numbers))).rejects.toThrow('重复');
    await expect(read(workbook(undefined, { 'xl/sharedStrings.xml': '<!DOCTYPE a [<!ENTITY x "boom">]><sst/>' }))).rejects.toThrow('实体');
    const bomb = Buffer.from(zipSync({ 'xl/sharedStrings.xml': new Uint8Array(9 * 1024 * 1024) }));
    await expect(read(bomb)).rejects.toThrow('8 MiB');
  });
  it('checks CRC before parsing a changed archive entry', async () => {
    const bytes = workbook(); const offset = bytes.indexOf(Buffer.from('1234567890123456')); expect(offset).toBeGreaterThan(0);
    bytes[offset] = '9'.charCodeAt(0);
    await expect(read(bytes)).rejects.toThrow('校验失败');
  });
  it.each(['1', 'true', '0', 'false'])('reads the %s date-system spelling without changing percentage or ID values', async epoch => {
    const styles = `<styleSheet xmlns="${ns}"><numFmts count="1"><numFmt numFmtId="164" formatCode="000000"/></numFmts><cellXfs count="3"><xf numFmtId="14"/><xf numFmtId="10"/><xf numFmtId="164"/></cellXfs></styleSheet>`;
    const data = await read(workbook(headers + '<row r="2"><c r="A2" s="0"><v>1</v></c><c r="B2" s="1"><v>0.15</v></c><c r="C2" s="2"><v>123</v></c><c r="D2" t="b"><v>1</v></c></row>', {
      'xl/styles.xml': styles,
      'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="${epoch}"/><sheets><sheet name="原始数据" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    }));
    expect(data.sheets[0].rows[1]).toEqual([['1', 'true'].includes(epoch) ? '1904-01-02T00:00:00.000Z' : '1900-01-01T00:00:00.000Z', '0.15', '123', 'TRUE']);
    expect(data.sheets[0].dateCells).toBe(1);
  });
  it('rejects unordered or malformed cells rather than returning partial rows', async () => {
    await expect(read(workbook(headers + '<row r="2"><c r="B2"><v>2</v></c><c r="A2"><v>1</v></c></row>'))).rejects.toThrow();
    await expect(read(workbook(headers + '<row r="2"><c r="A2" t="s"><v>999</v></c></row>'))).rejects.toThrow();
    await expect(read(workbook(headers, { 'xl/worksheets/sheet1.xml': `<worksheet xmlns="${ns}"><sheetData>${headers}</worksheet>` }))).rejects.toThrow();
  });
  it('does not follow external worksheet relationships', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(read(workbook(undefined, { 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" TargetMode="External" Target="http://127.0.0.1/private"/></Relationships>' }))).rejects.toThrow('外部地址');
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it('decodes Chinese GBK only with explicit encoding selection', async () => {
    const bytes = Buffer.from([0xc1, 0xd0, 0x0a, 0xd6, 0xd0, 0xce, 0xc4]);
    expect((await read(bytes, '表.csv', 'gb18030')).sheets[0].rows).toEqual([['列'], ['中文']]);
    await expect(read(bytes, '表.csv')).rejects.toThrow('无法完整读取');
  });
  it('honors cancellation without creating preview data', async () => {
    await expect(previewTableImport(workbook(), '表.xlsx', 'utf-8', AbortSignal.abort())).rejects.toThrow();
  });
  it('checks prefixed cells before the reader can allocate their ranges', async () => {
    const valid = `<x:worksheet xmlns:x="${ns}"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>值</x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2"><x:v>7</x:v></x:c></x:row></x:sheetData></x:worksheet>`;
    expect((await read(workbook('', { 'xl/worksheets/sheet1.xml': valid }))).sheets[0].rows).toEqual([['值'], ['7']]);
    await expect(read(workbook('', { 'xl/worksheets/sheet1.xml': valid.replace('r="A2"', 'r="ZZZ2"') }))).rejects.toThrow('64列');
    await expect(read(workbook('', { 'xl/worksheets/sheet1.xml': valid.replace('r="A2"', 'r="A2" x:r="ZZZ2"') }))).rejects.toThrow('属性无效');
  });
  it('rejects Excel fictional leap day rather than inventing a calendar date', async () => {
    const styles = `<styleSheet xmlns="${ns}"><cellXfs count="1"><xf numFmtId="14"/></cellXfs></styleSheet>`;
    await expect(read(workbook('<row r="1"><c r="A1" s="0"><v>60</v></c></row>', { 'xl/styles.xml': styles }))).rejects.toThrow('1900-02-29');
    expect((await read(workbook('<row r="1"><c r="A1" s="0"><v>61</v></c></row>', { 'xl/styles.xml': styles }))).sheets[0].rows).toEqual([['1900-03-01T00:00:00.000Z']]);
  });
  it('rejects duplicate relationships instead of reading a different file than the preflight checked', async () => {
    const type = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
    await expect(read(workbook(undefined, {
      'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Type="${type}" Target="worksheets/sheet1.xml"/><Relationship Id="rId1" Type="${type}" Target="worksheets/alternate.xml"/></Relationships>`,
      'xl/worksheets/alternate.xml': `<worksheet xmlns="${ns}"><sheetData>${headers}${numbers.replace('1234567890123456', '999')}</sheetData></worksheet>`,
    }))).rejects.toThrow('关系');
  });
  it('rejects hidden nested workbook sheets before the reader attempts them', async () => {
    await expect(read(workbook(undefined, {
      'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="原始数据" sheetId="1" r:id="rId1"/></sheets><extension><sheet name="额外表" sheetId="2" r:id="rId2"/></extension></workbook>`,
    }))).rejects.toThrow('工作表结构');
  });
  it('returns only preview via bounded HTTP, with unsupported body types rejected', async () => {
    const app = new Hono(); app.use('*', limitRequestBody); app.route('/api/data/import', createTableImportRoutes());
    const result = await app.request('/api/data/import/preview?name=test.xlsx', { method: 'POST', body: workbook(), headers: { 'content-type': 'application/octet-stream' } });
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ requiresConfirmation: true, willWrite: false, willExecute: false });
    expect((await app.request('/api/data/import/preview', { method: 'POST', body: '{}' })).status).toBe(415);
  });
});
