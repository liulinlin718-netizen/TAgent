import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import { Hono } from 'hono';
import { load } from 'cheerio';
import { parse } from 'csv-parse/sync';
import { fromBuffer, type ZipFile, type Entry } from 'yauzl';
import { zipSync } from 'fflate';
import readExcelFile from 'read-excel-file/universal';
import { Parser } from 'saxen';
import type { TableImportPreview, TableImportSheet } from '@tagent/core';

const MAX_FILE = 2 * 1024 * 1024, MAX_XML = 8 * 1024 * 1024;
const MAX_ROWS = 5001, MAX_COLUMNS = 64, MAX_CELLS = 100_000;
const fail = (message: string): never => { throw new TableImportError(message); };
export class TableImportError extends Error {}
const hasControls = (value: string) => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const safeName = (value: string) => value.length > 0 && value.length <= 200 && !/[/\\]/.test(value) && !hasControls(value);
const decoder = new TextDecoder('utf-8', { fatal: true });
function address(value: string): [number, number] {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value);
  if (!match) fail('工作表含无效单元格地址。');
  const column = [...match![1]].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0), row = Number(match![2]);
  if (column > MAX_COLUMNS || row > MAX_ROWS) fail('工作表范围超过5001行或64列，请先选择较小的独立数据表。');
  return [row, column];
}
const emptySheet = (name: string): TableImportSheet => ({ name, hidden: false, rows: [], hiddenRows: [], hiddenColumns: [],
  formulaCells: [], missingFormulaCells: [], errorCells: [], mergedRanges: [], dateCells: 0 });

// Read central-directory entries with streaming size checks; never extract any path to disk.
async function archive(bytes: Buffer, signal: AbortSignal): Promise<Map<string, Buffer>> {
  const zip = await new Promise<ZipFile>((resolve, reject) => fromBuffer(bytes,
    { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)));
  return new Promise((resolve, reject) => {
    const files = new Map<string, Buffer>(), seen = new Set<string>();
    let total = 0, declared = 0, done = false, active: Readable | undefined;
    const finish = (error?: Error) => {
      if (done) return;
      done = true; signal.removeEventListener('abort', abort); active?.destroy(); zip.close();
      if (error) reject(error); else resolve(files);
    };
    const abort = () => finish(new TableImportError('文件读取已取消或超时。'));
    const read = async (entry: Entry) => {
      signal.throwIfAborted();
      const name = entry.fileName, mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (seen.size >= 256 || seen.has(name.toLowerCase())) fail('文件包含过多或重复的归档条目。');
      seen.add(name.toLowerCase());
      if (name.length > 240 || name.split('/').some(part => part === '..' || part === '.') || name.startsWith('/')
        || /[\\:]/.test(name) || hasControls(name) || (mode && ![0x8000, 0x4000].includes(mode))) fail('文件包含不安全的归档路径或链接。');
      if (entry.generalPurposeBitFlag & 1) fail('暂不支持加密工作簿。');
      if (/vbaProject|activeX|embeddings|externalLinks|connections\.xml|queryTables/i.test(name)) fail('工作簿含宏、嵌入对象或外部数据连接，请另存为纯数据工作簿。');
      declared += entry.uncompressedSize;
      if (declared > MAX_XML || entry.uncompressedSize > MAX_XML) fail('工作簿解压后超过8 MiB，未读取部分数据。');
      if (name.endsWith('/')) return;
      active = await new Promise<Readable>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of active) {
        signal.throwIfAborted(); size += chunk.length; total += chunk.length;
        if (size > entry.uncompressedSize || total > MAX_XML) fail('工作簿实际解压大小超过限制。');
        chunks.push(Buffer.from(chunk));
      }
      if (size !== entry.uncompressedSize) fail('工作簿内容不完整。');
      const content = Buffer.concat(chunks);
      if (crc32(content) !== entry.crc32) fail('工作簿校验失败，文件可能已经损坏。');
      files.set(name, content); active = undefined;
    };
    zip.on('error', finish); zip.once('end', () => finish());
    zip.on('entry', entry => { void read(entry).then(() => { if (!done) zip.readEntry(); }).catch(finish); });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else zip.readEntry();
  });
}

async function xlsx(bytes: Buffer, signal: AbortSignal): Promise<TableImportSheet[]> {
  const files = await archive(bytes, signal);
  const xml = (name: string) => {
    const file = files.get(name); if (!file) return fail('工作簿缺少必需的XML文件。');
    const text = decoder.decode(file);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail('工作簿不允许XML实体或外部文档声明。');
    const validator = new Parser();
    const invalid = () => fail('工作簿XML结构或属性无效。');
    validator.on('error', invalid); validator.on('warn', invalid);
    validator.on('openTag', (_, attributes) => { attributes(); });
    validator.parse(text);
    const document = load(text, { xmlMode: true });
    // Match the XLSX reader's local-name handling before bounding any data coordinates.
    document('*').each((_, node) => {
      if (!('name' in node) || !('attribs' in node)) return;
      node.name = node.name.split(':').at(-1)!;
      const attributes: Record<string, string> = Object.create(null);
      for (const [name, value] of Object.entries(node.attribs)) {
        const local = name === 'xmlns' || name.startsWith('xmlns:') ? name : name.split(':').at(-1)!;
        if (Object.hasOwn(attributes, local)) invalid();
        attributes[local] = value;
      }
      node.attribs = attributes;
    });
    return document;
  };
  for (const name of files.keys()) if (/\.(xml|rels)$/.test(name)) xml(name);
  const types = xml('[Content_Types].xml');
  if (types('Override').toArray().some(node => /macroEnabled|vba|activeX/i.test(types(node).attr('ContentType') || ''))) fail('暂不读取含宏或活动内容的工作簿。');
  const book = xml('xl/workbook.xml'), rels = xml('xl/_rels/workbook.xml.rels');
  const properties = book('workbook > workbookPr');
  if (properties.length > 1 || properties.length !== book('workbookPr').length) fail('工作簿日期属性不明确。');
  const epoch = properties.attr('date1904');
  if (epoch !== undefined && !['0', '1', 'false', 'true'].includes(epoch)) fail('工作簿日期系统无效。');
  // The reader recognizes only the numeric XML boolean spelling for the 1904 epoch.
  if (epoch === 'true') { properties.attr('date1904', '1'); files.set('xl/workbook.xml', Buffer.from(book.xml())); }
  const sheetNodes = book('workbook > sheets > sheet').toArray();
  if (book('workbook').length !== 1 || book('sheets').length !== 1 || book('sheet').length !== sheetNodes.length) fail('工作表结构无效。');
  if (!sheetNodes.length || sheetNodes.length > 16) fail('需要1至16个工作表。');
  const relationships = rels('Relationships > Relationship').toArray();
  const relationshipIds = relationships.map(node => rels(node).attr('Id'));
  if (rels('Relationships').length !== 1 || rels('Relationship').length !== relationships.length
    || relationshipIds.some(id => !id) || new Set(relationshipIds).size !== relationships.length) fail('工作簿关系编号缺失、重复或结构无效。');
  const sheetIds = sheetNodes.map(node => book(node).attr('id'));
  if (sheetIds.some(id => !id) || new Set(sheetIds).size !== sheetNodes.length) fail('工作表关系编号缺失或重复。');
  let cells = 0, gridCells = 0;
  const metadata = sheetNodes.map(node => {
    const name = book(node).attr('name') || ''; if (!safeName(name)) fail('工作表名称无效。');
    const sheet = emptySheet(name); sheet.hidden = ['hidden', 'veryHidden'].includes(book(node).attr('state') || '');
    const id = book(node).attr('id');
    const relationship = relationships.find(item => rels(item).attr('Id') === id);
    if (!relationship || rels(relationship).attr('TargetMode') === 'External') return fail('工作表关系无效或指向外部地址。');
    if (!['http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', 'http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet'].includes(rels(relationship).attr('Type') || '')) fail('工作表关系类型无效。');
    const target = rels(relationship).attr('Target') || '';
    const path = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target));
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path)) return fail('不支持该工作表类型或路径。');
    const $ = xml(path), seenCells = new Set<string>(), errorValues = new Map<string, string>(), numericValues = new Map<string, number>();
    if ($('worksheet').length !== 1 || $('sheetData').length !== 1 || $('row').length !== $('sheetData > row').length
      || $('c').length !== $('sheetData > row > c').length) fail('工作表结构无效。');
    let maxRow = 0, maxColumn = 0;
    let previousRow = 0;
    $('sheetData > row').each((_, row) => {
      const index = Number($(row).attr('r'));
      if (!Number.isInteger(index) || index <= previousRow || index > MAX_ROWS) fail('工作表行号无效、重复或超限。');
      previousRow = index;
      if ($(row).attr('hidden') === '1' || $(row).attr('hidden') === 'true') sheet.hiddenRows.push(index);
    });
    $('sheetData > row > c').each((_, cell) => {
      const ref = $(cell).attr('r') || '', [row, col] = address(ref);
      if (++cells > MAX_CELLS || seenCells.has(ref)) fail('工作簿单元格过多或地址重复。');
      if (Number($(cell).parent().attr('r')) !== row) fail('单元格地址与所在行不一致。');
      seenCells.add(ref); maxRow = Math.max(maxRow, row); maxColumn = Math.max(maxColumn, col);
      if (!$(cell).attr('t') || $(cell).attr('t') === 'n') numericValues.set(ref, Number($(cell).children('v').text()));
      if ($(cell).children('f').length) {
        sheet.formulaCells.push(ref);
        if (!$(cell).children('v').length || $(cell).children('v').text() === '') sheet.missingFormulaCells.push(ref);
      }
      if ($(cell).attr('t') === 'e') { sheet.errorCells.push(ref); errorValues.set(ref, $(cell).children('v').text().slice(0, 120)); }
    });
    gridCells += maxRow * maxColumn;
    if (gridCells > MAX_CELLS) fail('工作簿展开后的数据区域过大，未截断读取。');
    $('cols > col').each((_, col) => {
      if (!['1', 'true'].includes($(col).attr('hidden') || '')) return;
      const min = Number($(col).attr('min')), max = Number($(col).attr('max'));
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 16384) fail('隐藏列定义无效。');
      for (let index = min; index <= Math.min(max, maxColumn); index++) sheet.hiddenColumns.push(index);
    });
    sheet.mergedRanges = $('mergeCells > mergeCell').toArray().map(cell => $(cell).attr('ref') || '');
    if (sheet.mergedRanges.length > 1000) fail('合并区域过多。');
    for (const range of sheet.mergedRanges) {
      const ends = range.split(':'); if (ends.length !== 2) fail('合并区域格式无效。');
      address(ends[0]); address(ends[1]);
    }
    return { sheet, maxRow, maxColumn, errorValues, numericValues };
  });
  if (new Set(metadata.map(item => item.sheet.name)).size !== metadata.length) fail('工作表名称重复。');
  // Repack only validated entries so local-header/central-directory disagreements cannot bypass the limits.
  const checkedArchive = zipSync(Object.fromEntries(files), { level: 0 });
  signal.throwIfAborted();
  const parsed = await readExcelFile(checkedArchive.buffer as ArrayBuffer, { trim: false, parseNumber: value => value });
  signal.throwIfAborted();
  if (parsed.length !== metadata.length) fail('工作表解析数量不一致。');
  return metadata.map(({ sheet, maxRow, maxColumn, errorValues, numericValues }, index) => {
    if (parsed[index].sheet !== sheet.name) fail('工作表顺序不一致。');
    sheet.rows = Array.from({ length: maxRow }, (_, row) => Array.from({ length: maxColumn }, (_, col) => {
      const value = parsed[index].data[row]?.[col];
      if (value instanceof Date) {
        if (!Number.isFinite(value.getTime())) return fail('日期单元格无效。');
        const column = col + 1, label = column <= 26 ? String.fromCharCode(64 + column) : `${String.fromCharCode(64 + Math.floor((column - 1) / 26))}${String.fromCharCode(65 + (column - 1) % 26)}`;
        const serial = numericValues.get(`${label}${row + 1}`);
        // Excel's fictional 1900-02-29 must not become a real date; this reader applies its offset before March too.
        if (!['1', 'true'].includes(epoch || '') && serial !== undefined) {
          if (serial >= 60 && serial < 61) return fail('工作簿含Excel虚构的1900-02-29日期，请先修正原数据。');
          if (serial >= 1 && serial < 60) value.setUTCDate(value.getUTCDate() + 1);
        }
        sheet.dateCells++; return value.toISOString();
      }
      if (value === null || value === undefined) return '';
      if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
      if (typeof value !== 'string') return fail('数值解析未保留原始精度。');
      return value;
    }));
    for (const ref of sheet.missingFormulaCells) { const [row, col] = address(ref); sheet.rows[row - 1][col - 1] = '[公式无已保存结果]'; }
    for (const ref of sheet.errorCells) { const [row, col] = address(ref); sheet.rows[row - 1][col - 1] = `[Excel单元格错误: ${errorValues.get(ref)}]`; }
    return sheet;
  });
}

export async function previewTableImport(bytes: Buffer, name: string, encoding: string, signal: AbortSignal): Promise<TableImportPreview> {
  signal.throwIfAborted();
  if (!safeName(name)) fail('文件名无效。');
  if (!bytes.length || bytes.length > MAX_FILE) fail('请选择不超过2 MiB的非空表格文件。');
  const format = /\.(xlsx|csv|tsv)$/i.exec(name)?.[1].toLowerCase() as TableImportPreview['file']['format'] | undefined;
  if (!format) fail('支持.xlsx、.csv或.tsv；旧版.xls或加密文件请先另存为.xlsx。');
  try {
    let sheets: TableImportSheet[];
    if (format === 'xlsx') sheets = await xlsx(bytes, signal);
    else {
      if (!['utf-8', 'gb18030', 'utf-16le'].includes(encoding)) fail('请选择支持的文件编码。');
      const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      if (text.includes('\u0000')) fail('文件含二进制内容或编码不匹配。');
      const rows = parse(text, { delimiter: format === 'tsv' ? '\t' : ',', bom: true, cast: false, columns: false,
        skip_empty_lines: false, relax_column_count: false, max_record_size: 65536 }) as string[][];
      if (rows.length > MAX_ROWS || rows.some(row => row.length > MAX_COLUMNS) || rows.length * (rows[0]?.length || 0) > MAX_CELLS) fail('表格行列或数据区域超过读取上限。');
      sheets = [{ ...emptySheet(name), rows }];
    }
    if (sheets.some(sheet => sheet.rows.some(row => row.some(cell => cell.length > 2000)))) fail('表格包含超过2000字符的单元格，未截断读取。');
    const result: TableImportPreview = { version: 1, file: { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), format: format!,
      ...(format === 'xlsx' ? {} : { encoding }) }, sheets, warnings: [
      '预览未保存原文件。确认选择的数据会进入任务草稿，发送任务后才随会话保存并提交给模型。',
      ...(format === 'xlsx' ? ['读取底层保存值，不重新计算公式、不读取显示格式或换算单位；百分比、货币、编号格式请核对。', '标准日期转为ISO文本；隐藏行列仍包含，合并单元格不自动填充，图片、图表及批注不作为数据。'] : []),
    ], requiresConfirmation: true, willWrite: false, willExecute: false };
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) fail('完整预览超过1 MiB，请先将所需范围另存为独立表格。');
    return result;
  } catch (error) {
    if (error instanceof TableImportError) throw error;
    if (signal.aborted) fail('文件读取已取消或超时。');
    return fail('无法完整读取表格，请核对文件格式、编码、引号与列数；未生成部分数据预览。');
  }
}

export function createTableImportRoutes() {
  const app = new Hono(); let active = 0;
  app.post('/preview', async c => {
    if (c.req.header('content-type')?.split(';')[0] !== 'application/octet-stream') return c.json({ error: '请提交原始表格文件。' }, 415);
    if (active >= 2) return c.json({ error: '已有文件正在读取，请稍后手动重试。' }, 429);
    active++;
    try {
      const bytes = Buffer.from(await c.req.arrayBuffer());
      return c.json(await previewTableImport(bytes, c.req.query('name') || '', c.req.query('encoding') || 'utf-8', AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)])));
    } catch (error) {
      return c.json({ error: error instanceof TableImportError ? error.message : '文件读取失败，未保存或调用模型。' }, 400);
    } finally { active--; }
  });
  return app;
}
