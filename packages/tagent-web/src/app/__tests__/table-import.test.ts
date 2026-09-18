import { describe, expect, it } from 'vitest';
import { parse } from 'csv-parse/sync';
import type { TableImportPreview } from '@tagent/core';
import { appendTableMaterial, columnLabel, selectedTable, type TableSelection } from '../../lib/table-import';

const preview = (): TableImportPreview => ({ version: 1, file: { name: '原始.xlsx', bytes: 500, sha256: 'a'.repeat(64), format: 'xlsx' },
  sheets: [{ name: 'Sheet 1', hidden: true, rows: [['名称', '金额', '备注'], [' 001 ', '1234567890123456', 'A,B\n"原文"'], ['地区', '0.3', '=2+2']],
    hiddenRows: [3], hiddenColumns: [2], formulaCells: ['B2'], missingFormulaCells: [], errorCells: [], mergedRanges: [], dateCells: 0 }],
  warnings: [], requiresConfirmation: true, willWrite: false, willExecute: false });
const range: TableSelection = { sheet: 0, startRow: 1, endRow: 3, startColumn: 1, endColumn: 3 };

describe('confirmed table range to task material', () => {
  it('retains exact text, precision, quoting, hidden scope and file identity', () => {
    const data = preview(), result = selectedTable(data, range);
    expect(result.text).toContain(data.file.sha256); expect(result.text).toContain('A1:C3'); expect(result.text).toContain('公式1处');
    expect(result.text).toContain('隐藏行1'); expect(result.text).toContain('隐藏列1'); expect(result.text).toContain('隐藏工作表');
    const csv = result.text.slice(result.text.indexOf('名称,金额,备注'));
    expect(parse(csv, { cast: false })).toEqual(data.sheets[0].rows);
    expect(result.text).not.toContain('自动发送');
  });
  it('uses an explicitly selected subset, without attributing the entire workbook', () => {
    const data = preview(); data.sheets[0].rows.unshift(['说明', '', '']);
    const result = selectedTable(data, { ...range, startRow: 2, endRow: 3, endColumn: 2 });
    expect(result.rows).toEqual([['名称', '金额'], [' 001 ', '1234567890123456']]);
    expect(result.text).toContain('此范围不代表整个文件'); expect(result.range).toBe('A2:B3');
  });
  it.each([{ startRow: 0 }, { endRow: 1 }, { endRow: 4 }, { startColumn: 0 }, { endColumn: 4 }, { sheet: 10 }, { startRow: 1.5 }])('rejects invalid selection %s', change => {
    expect(() => selectedTable(preview(), { ...range, ...change })).toThrow('完整行列范围');
  });
  it.each([['', '金额', '备注'], ['名称', '名称', '备注'], ['X'.repeat(121), '金额', '备注']].map(headers => ({ headers })))('requires usable headers', ({ headers }) => {
    const data = preview(); data.sheets[0].rows[0] = headers;
    expect(() => selectedTable(data, range)).toThrow('列名');
  });
  it('refuses too much data and preserves existing material on append overflow', () => {
    const data = preview(); data.sheets[0].rows = [['名称', '金额', '备注'], ...Array.from({ length: 50 }, () => ['汉'.repeat(1000), '1', ''])];
    expect(() => selectedTable(data, { ...range, endRow: 51 })).toThrow('不会截断');
    expect(appendTableMaterial('  原材料\n', '已确认范围')).toBe('  原材料\n\n\n已确认范围');
    expect(() => appendTableMaterial('x'.repeat(65536), '新材料')).toThrow('原材料未改动');
  });
  it('does not apply a preview which says it writes or executes', () => {
    expect(() => selectedTable({ ...preview(), willExecute: true } as unknown as TableImportPreview, range)).toThrow('安全状态');
  });
  it('labels all supported columns correctly', () => {
    expect([1, 26, 27, 52, 53, 64].map(columnLabel)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'BL']);
  });
});
