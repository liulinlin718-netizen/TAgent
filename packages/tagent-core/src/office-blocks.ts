import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';

export type OfficeBlockSchema = 'paragraph-v1' | 'table-rows-v1';
export interface OfficeOutputBlock {
  index: number;
  text: string;
  label?: string;
  context?: { section: string; tableHeader?: string };
}

const paragraphs = (text: string) => text.trim().split(/\n\s*\n/).filter(block => block.trim());
const parseMarkdown = (text: string) => fromMarkdown(text, { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] });

export interface OfficeTableRow {
  text: string;
  cells: { header: string; text: string }[];
}

/** Top-level GFM rows only; column identity comes from the parsed header, not pipe offsets. */
export function officeTableRows(output: string): OfficeTableRow[] {
  type Node = { type: string; value?: string; children?: Node[] };
  const plainText = (node: Node): string => node.type === 'text' || node.type === 'inlineCode'
    ? node.value ?? '' : (node.children ?? []).map(plainText).join('');
  const rows: OfficeTableRow[] = [];
  for (const table of parseMarkdown(output).children) {
    if (table.type !== 'table') continue;
    const headers = table.children[0]?.children.map(cell => plainText(cell).trim()) ?? [];
    for (const row of table.children.slice(1)) {
      const start = row.position?.start.offset, end = row.position?.end.offset;
      if (start === undefined || end === undefined) throw new Error('表格行缺少原文位置，未省略该行。');
      // Ragged rows are left to the model review; do not assign text to guessed columns.
      if (row.children.length !== headers.length) continue;
      rows.push({ text: output.slice(start, end), cells: row.children.map((cell, index) => ({ header: headers[index], text: plainText(cell) })) });
    }
  }
  return rows;
}

export function officeOutputBlocks(output: string, schema: OfficeBlockSchema = 'paragraph-v1'): OfficeOutputBlock[] {
  if (schema === 'paragraph-v1') return paragraphs(output).map((text, index) => ({ index, text }));
  if (schema !== 'table-rows-v1') throw new Error('未知办公核对分段版本，不能重新解释历史编号。');

  const tree = parseMarkdown(output);
  const blocks: Omit<OfficeOutputBlock, 'index'>[] = [];
  let cursor = 0, tableNumber = 0, section = '';
  for (const node of tree.children) {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) throw new Error('Markdown 节点缺少原文位置，未省略内容后核对。');
    if (node.type === 'heading') section = output.slice(start, end);
    // Nested/quoted tables and fenced examples keep their surrounding paragraph context.
    if (node.type !== 'table') continue;
    blocks.push(...paragraphs(output.slice(cursor, start)).map(text => ({ text })));
    tableNumber++;
    const rows = node.children.map(row => {
      const rowStart = row.position?.start.offset, rowEnd = row.position?.end.offset;
      if (rowStart === undefined || rowEnd === undefined) throw new Error('表格行缺少原文位置，未省略该行。');
      return { start: rowStart, end: rowEnd, text: output.slice(rowStart, rowEnd) };
    });
    const header = rows[0]?.text ?? '';
    blocks.push({ text: output.slice(start, rows[1]?.start ?? end).trimEnd(),
      label: `表格 ${tableNumber} · 表头`, context: { section } });
    for (const [index, row] of rows.slice(1).entries()) {
      blocks.push({ text: row.text, label: `表格 ${tableNumber} · 第 ${index + 1} 行`, context: { section, tableHeader: header } });
    }
    cursor = end;
  }
  blocks.push(...paragraphs(output.slice(cursor)).map(text => ({ text })));
  return blocks.map((block, index) => ({ ...block, index }));
}
