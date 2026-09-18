import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Definition, Nodes, PhrasingContent, RootContent, Table as MarkdownTable } from 'mdast';
import { AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, FootnoteReferenceRun, HeadingLevel, LevelFormat, Packer,
  PageNumber, Paragraph, Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType,
  type ILevelsOptions, type IParagraphOptions, type IRunOptions, type ParagraphChild } from 'docx';
import type { ReportExportInput } from './report-export';

const LIMIT = 200000;
const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9' };
const font = { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: 'Microsoft YaHei' };
const headingLevels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

function validateText(value: string) {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\uD800-\uDFFF]/u.test(value)) {
    throw new Error('内容包含 Word 无法完整保存的字符，未生成文件。');
  }
}

function safeLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function plain(node: Nodes): string {
  if ('value' in node) return node.value;
  if (node.type === 'image' || node.type === 'imageReference') return node.alt || '';
  if ('children' in node) return node.children.map(child => plain(child)).join('');
  return '';
}

/** Converts only the selected reply. Raw model receipts and other messages never enter this boundary. */
export async function encodeReportDocument(input: ReportExportInput): Promise<{ fileName: string; blob: Blob; warnings: string[] }> {
  const values = [input.content, input.messageId, input.runId || '', input.status, input.saved, input.review,
    ...input.details.flatMap(detail => [detail.label, detail.text])];
  values.forEach(validateText);
  if (!input.content.trim() || input.content.length > LIMIT || input.details.length > 1000
    || values.reduce((size, value) => size + value.length, 0) > 400000) throw new Error('回复为空或超过 Word 导出容量，未截断生成文件。');
  const tree = fromMarkdown(input.content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const definitions = new Map<string, Definition>();
  const noteIds = new Map<string, number>();
  const warnings = new Set<string>();
  let nodeCount = 0, maxColumns = 0;
  function scan(node: Nodes, depth = 0) {
    if (++nodeCount > 20000 || depth > 32) throw new Error('回复结构过于复杂，未生成不完整文件。');
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if (node.type === 'footnoteDefinition' && !noteIds.has(node.identifier)) noteIds.set(node.identifier, noteIds.size + 1);
    if (node.type === 'table') {
      maxColumns = Math.max(maxColumns, ...node.children.map(row => row.children.length));
      if (node.children.length > 1001 || maxColumns > 12) throw new Error('表格超过1000条数据或12列，请拆分报告后下载；未丢弃单元格。');
    }
    if ('children' in node) node.children.forEach(child => scan(child, depth + 1));
  }
  scan(tree);
  const landscape = maxColumns > 6;
  const pageWidth = landscape ? 15840 : 12240, pageHeight = landscape ? 12240 : 15840;
  const textWidth = pageWidth - 2160;
  const numbering: Array<{ reference: string; levels: ILevelsOptions[] }> = [];
  const links = new Map<string, string>();
  const raw = (text: string, style: IRunOptions = {}): TextRun[] => text.split('\n').map((line, index) => new TextRun({ ...style, text: line, ...(index ? { break: 1 } : {}) }));
  const para = (children: ParagraphChild[], options: IParagraphOptions = {}) => new Paragraph({ children,
    spacing: { after: 160, line: 300 }, widowControl: true, wordWrap: false, ...options });
  const literal = (text: string, style: IRunOptions = {}) => para(raw(text, style));
  const detailParagraph = (children: ParagraphChild[]) => para(children, { spacing: { after: 80, line: 260 }, run: { size: 21 } });
  const detailText = (value: string) => detailParagraph(raw(value, { size: 21 }));
  function link(children: ParagraphChild[], url: string): ParagraphChild[] {
    const safe = safeLink(url);
    if (!safe) {
      warnings.add('非 HTTP(S)、相对或带凭据的链接仅保留文字，不启用跳转。');
      return [...children, ...raw(` (${url})`)];
    }
    links.set(safe, url);
    return [new ExternalHyperlink({ link: safe, children })];
  }
  function inline(nodes: PhrasingContent[], style: IRunOptions = {}): ParagraphChild[] {
    return nodes.flatMap(node => {
      switch (node.type) {
        case 'text': return raw(node.value, style);
        case 'strong': return inline(node.children, { ...style, bold: true });
        case 'emphasis': return inline(node.children, { ...style, italics: true });
        case 'delete': return inline(node.children, { ...style, strike: true });
        case 'inlineCode': return raw(node.value, { ...style, font: { ...font, ascii: 'Consolas', hAnsi: 'Consolas' } });
        case 'break': return [new TextRun({ break: 1 })];
        case 'link': return link(inline(node.children, { ...style, color: '175950', underline: {} }), node.url);
        case 'linkReference': {
          const definition = definitions.get(node.identifier);
          return definition ? link(inline(node.children, style), definition.url) : inline(node.children, style);
        }
        case 'image': case 'imageReference': {
          warnings.add('图片未下载或嵌入，保留图片说明与来源地址。');
          const url = node.type === 'image' ? node.url : definitions.get(node.identifier)?.url;
          return raw(`[图片：${node.alt || '无说明'}${url ? `；${url}` : ''}]`, style);
        }
        case 'html': warnings.add('HTML 以原始文字保存，不执行或渲染。'); return raw(node.value, style);
        case 'footnoteReference': {
          const id = noteIds.get(node.identifier);
          return id ? [new FootnoteReferenceRun(id)] : raw(`[^${node.label || node.identifier}]`, style);
        }
        default: throw new Error('遇到尚不支持的行内结构，未生成不完整文件。');
      }
    });
  }
  function table(node: MarkdownTable, indent: number): Table {
    const columns = Math.max(...node.children.map(row => row.children.length));
    const available = textWidth - indent;
    const weights = Array.from({ length: columns }, (_, i) => {
      const lengths = node.children.map(row => Array.from(plain(row.children[i] || { type: 'text', value: '' })).length);
      return Math.min(32, Math.max(5, ...lengths.map(length => Math.sqrt(length) * 3)));
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map(weight => Math.floor(available * weight / sum));
    widths[widths.length - 1] += available - widths.reduce((a, b) => a + b, 0);
    return new Table({ width: { size: available, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED,
      indent: { size: indent, type: WidthType.DXA }, borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
      rows: node.children.map((row, index) => new TableRow({ tableHeader: index === 0 ? true : undefined,
        children: Array.from({ length: columns }, (_, column) => new TableCell({ width: { size: widths[column], type: WidthType.DXA },
          margins: { top: 100, bottom: 100, left: 120, right: 120 }, verticalAlign: VerticalAlign.CENTER,
          shading: { fill: index === 0 ? 'E8EEF0' : index % 2 ? 'FFFFFF' : 'F5F7F8' },
          children: [para(inline(row.children[column]?.children || [], { bold: index === 0, color: '000000' }), {
            spacing: { after: 40, line: 280 }, alignment: node.align?.[column] === 'right' ? AlignmentType.RIGHT
              : node.align?.[column] === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT })] })) })) });
  }
  function blocks(nodes: RootContent[], depth = 0, quoteDepth = 0): Array<Paragraph | Table> {
    if (depth > 8 || quoteDepth > 8) throw new Error('列表或引用超过8层，未压平或截断内容。');
    const indent = depth * 360 + quoteDepth * 240;
    return nodes.flatMap((node): Array<Paragraph | Table> => {
      switch (node.type) {
        case 'heading': return [para(inline(node.children), { heading: headingLevels[node.depth - 1], indent: { left: indent },
          keepNext: true, spacing: { before: 300, after: 160 } })];
        case 'paragraph': return [para(inline(node.children), { indent: { left: indent } })];
        case 'blockquote': return blocks(node.children, depth, quoteDepth + 1);
        case 'thematicBreak': return [para([], { border: { bottom: border }, spacing: { before: 120, after: 220 } })];
        case 'code': return [para(raw(node.value, { font: { ...font, ascii: 'Consolas', hAnsi: 'Consolas' }, size: 21 }),
          { indent: { left: indent + 180 }, spacing: { before: 120, after: 200, line: 280 } })];
        case 'html': warnings.add('HTML 以原始文字保存，不执行或渲染。'); return [literal(node.value)];
        case 'definition': return [];
        case 'footnoteDefinition': return [];
        case 'table': return [table(node, indent), para([], { spacing: { after: 160 } })];
        case 'list': {
          const reference = `list-${numbering.length}`;
          numbering.push({ reference, levels: [{ level: depth, start: node.start ?? 1,
            format: node.ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET, text: node.ordered ? `%${depth + 1}.` : '•',
            style: { paragraph: { indent: { left: indent + 360, hanging: 240 } }, run: { font } } }] });
          return node.children.flatMap(item => {
            let first = true;
            return item.children.flatMap(child => {
              if (first && child.type === 'paragraph') {
                first = false;
                return [para([...(typeof item.checked === 'boolean' ? raw(item.checked ? '[x] ' : '[ ] ') : []), ...inline(child.children)],
                  { numbering: { reference, level: depth }, spacing: { after: 100, line: 300 } })];
              }
              const prefix = first ? [para([], { numbering: { reference, level: depth } })] : [];
              first = false;
              return [...prefix, ...blocks([child], depth + 1, quoteDepth)];
            });
          });
        }
        default: throw new Error('遇到尚不支持的 Markdown 结构，未生成不完整文件。');
      }
    });
  }
  const first = tree.children[0];
  const hasTitle = first?.type === 'heading' && first.depth === 1;
  const title = hasTitle ? plain(first) : 'TAgent 办公回复';
  const body = blocks(hasTitle ? tree.children.slice(1) : tree.children);
  const footnotes: Record<string, { children: Paragraph[] }> = {};
  function addNotes(node: Nodes) {
    if (node.type === 'footnoteDefinition' && !footnotes[noteIds.get(node.identifier)!]) {
      const content = blocks(node.children);
      if (content.some(item => item instanceof Table)) throw new Error('脚注内的表格暂不支持 Word 导出，请移到正文后下载；未丢弃内容。');
      footnotes[noteIds.get(node.identifier)!] = { children: content as Paragraph[] };
    }
    if ('children' in node) node.children.forEach(addNotes);
  }
  addNotes(tree);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.content));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const children: Array<Paragraph | Table> = [para(hasTitle ? inline(first.children) : raw(title), { heading: HeadingLevel.TITLE,
    spacing: { after: 240 }, keepNext: true }), literal(input.status, { size: 21 }), literal(`${input.saved}；${input.review}。`, { size: 21 }), ...body];
  children.push(para(raw('导出与核对记录'), { heading: HeadingLevel.HEADING_1, keepNext: true, spacing: { before: 440, after: 160 } }),
    detailText('本文件仅包含本条回复、链接与核对摘要，不包含其他会话、核对模型原始回执或完整工具材料。下载不重新调用模型或联网核验。'),
    detailText('程序检查和模型辅助核对均有边界，不等于独立事实核查。文件可编辑，编辑后不代表原回复或原核对结果。'));
  for (const [label, value] of [['运行状态', input.status], ['保存状态', input.saved], ['核对状态', input.review], ['消息编号', input.messageId],
    ['运行编号', input.runId || '未记录'], ['导出时间（UTC）', new Date().toISOString()], ['原回复 SHA-256', hash]]) {
    children.push(detailParagraph([...raw(`${label}：`, { bold: true, size: 21 }), ...raw(value, { size: 21 })]));
  }
  for (const warning of warnings) children.push(detailText(warning));
  for (const detail of input.details) children.push(detailParagraph([...raw(`${detail.label}：`, { bold: true, size: 21 }), ...raw(detail.text, { size: 21 })]));
  if (links.size) {
    children.push(para(raw('正文链接'), { heading: HeadingLevel.HEADING_2, keepNext: true }));
    for (const [url, original] of links) children.push(para([new ExternalHyperlink({ link: url, children: raw(original, { color: '175950', underline: {} }) })]));
  }
  const headingStyles = Object.fromEntries(['title', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6'].map((name, index) => [name,
    { run: { font, color: '000000', bold: true, size: [36, 30, 26, 24, 23, 22, 22][index] }, paragraph: { keepNext: true, spacing: { before: index ? 300 : 0, after: 160 } } }]));
  const document = new Document({ creator: 'TAgent', lastModifiedBy: 'TAgent', title, description: '本条回复及导出时的核对状态，不是独立质量认证。',
    footnotes, styles: { default: { document: { run: { font, size: 23, color: '000000', language: { value: 'zh-CN', eastAsia: 'zh-CN' } },
      paragraph: { spacing: { after: 160, line: 300 } } }, ...headingStyles } }, numbering: { config: numbering },
    sections: [{ properties: { page: { size: { width: pageWidth, height: pageHeight }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
      children, footers: { default: new Footer({ children: [para([new TextRun({ children: ['TAgent  |  ', PageNumber.CURRENT], size: 20 })], { alignment: AlignmentType.RIGHT })] }) } }] });
  const name = Array.from(title.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '')).slice(0, 60).join('') || '办公回复';
  return { fileName: `tagent-${name}-${hash.slice(0, 8)}.docx`, blob: await Packer.toBlob(document), warnings: [...warnings] };
}
