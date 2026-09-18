import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { load } from 'cheerio';
import { fromBuffer } from 'yauzl';
import type { ChatMessage } from '../../lib/conversations';
import { canExportReport, reportExportInput, type ReportExportInput } from '../../lib/report-export';
import { encodeReportDocument } from '../../lib/report-document';

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'reply-fixture', role: 'assistant', content: '# 收入简报\n\n已收到310万元。',
  run: { id: 'run-fixture', status: 'finished' }, persisted: true,
  traces: [{ type: 'complete', timestamp: 1, runId: 'run-fixture', data: { success: true } }], ...overrides });
const input = (content: string) => reportExportInput(message({ content }));
async function readDoc(source: ReportExportInput) {
  const result = await encodeReportDocument(source), files = new Map<string, string>();
  const buffer = Buffer.from(await result.blob.arrayBuffer());
  await new Promise<void>((resolve, reject) => fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) { reject(error); return; }
    zip.on('error', reject); zip.on('end', resolve); zip.on('entry', entry => {
      if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { reject(error); return; }
        const chunks: Buffer[] = [];
        stream.on('data', chunk => chunks.push(chunk)); stream.on('error', reject);
        stream.on('end', () => { files.set(entry.fileName, Buffer.concat(chunks).toString('utf8')); zip.readEntry(); });
      });
    }); zip.readEntry();
  }));
  const xml = load(files.get('word/document.xml')!, { xmlMode: true });
  const paragraphs = xml('w\\:p').toArray().map(node => xml(node).find('w\\:t').toArray().map(child => xml(child).text()).join(''));
  const notes = load(files.get('word/footnotes.xml') || '', { xmlMode: true })('w\\:t').toArray().map(node => load(node, { xmlMode: true }).text()).join('');
  return { ...result, files, xml, paragraphs, text: paragraphs.join('\n') + '\n' + notes, all: [...files.values()].join('\n') };
}
afterEach(() => vi.unstubAllGlobals());

describe('Word reply export', () => {
  it('requires a finished assistant reply, not a user message or a streaming fragment', () => {
    for (const change of [{ role: 'user' as const }, { content: '' }, { isStreaming: true }, { run: { id: 'x', status: 'running' as const } }]) {
      expect(canExportReport(message(change))).toBe(false);
      expect(() => reportExportInput(message(change))).toThrow('结束');
    }
    expect(canExportReport(message())).toBe(true);
  });
  it('does not promote an unrelated complete event or an unverified legacy message to success', () => {
    const unknown = reportExportInput(message({ traces: [{ type: 'complete', timestamp: 1, runId: 'another-run', data: { success: true } }] }));
    expect(unknown.status).toContain('未取得');
    expect(reportExportInput(message({ traces: [], run: undefined, persisted: undefined })).saved).toContain('未在本入口核实');
  });
  it('preserves failure, interruption and unsaved status without exporting private receipts', async () => {
    const value = message({ persisted: false, run: { id: 'run-fixture', status: 'interrupted' },
      deliveryReview: { version: 1, status: 'unverified', model: 'fixture', checkedAt: '2026-09-14', checks: [{ id: '1', label: '金额', status: 'failed', method: 'programmatic', reason: '账单不一致' }], issues: ['材料不足'], materialCount: 1,
        receipt: { status: 'received', rawOutput: 'PRIVATE-RAW-RECEIPT', inputCharacters: 1, maxOutputTokens: 1, unsettledRequests: 0 },
        previous: { output: 'PRIVATE-PREVIOUS-DRAFT', review: { version: 1, status: 'unverified', model: 'fixture', checkedAt: '', checks: [], issues: [], materialCount: 0 } } } });
    const document = await readDoc(reportExportInput(value));
    expect(document.text).toContain('任务中断'); expect(document.text).toContain('尚未确认保存');
    expect(document.text).toContain('账单不一致'); expect(document.text).toContain('材料不足');
    expect(document.all).not.toContain('PRIVATE-RAW'); expect(document.all).not.toContain('PRIVATE-PREVIOUS');
    expect(reportExportInput(message({ traces: [{ type: 'complete', timestamp: 1, runId: 'run-fixture', data: { success: false } }] })).status).toContain('未完整完成');
  });
  it('roundtrips Chinese, emoji, emphasis, all heading levels, code, quotations and exact body hash', async () => {
    const content = '# 年度报告\n\n中文 😀 **重点** *建议* ~~旧值~~ `x < 2 && y > 1`\n\n## 一 结论\n\n### 执行\n\n#### 四级\n\n##### 五级\n\n###### 六级\n\n> 保留不确定性\n\n```ts\n  const x = "<xml>&";\n  next();\n```';
    const document = await readDoc(input(content));
    for (const text of ['中文 😀 重点 建议 旧值 x < 2 && y > 1', '保留不确定性', '  const x = "<xml>&";', '  next();']) expect(document.text).toContain(text);
    for (const level of ['Title', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6']) expect(document.xml(`w\\:pStyle[w\\:val="${level}"]`).length).toBeGreaterThan(0);
    expect(document.xml('w\\:b').length).toBeGreaterThan(0); expect(document.xml('w\\:i').length).toBeGreaterThan(0); expect(document.xml('w\\:strike').length).toBeGreaterThan(0);
    expect(document.text).toContain(createHash('sha256').update(content).digest('hex'));
    expect(document.fileName).toMatch(/^tagent-年度报告-[a-f0-9]{8}\.docx$/);
  });
  it('exports incomplete row coverage without losing its reason or including the raw receipt', async () => {
    const document = await readDoc(reportExportInput(message({ deliveryReview: {
      version: 1, blockSchema: 'table-rows-v1', status: 'unverified', model: 'fixture', checkedAt: '2026-09-16', materialCount: 1,
      checks: [], coverage: { expectedBlocks: 31, checkedBlocks: 0 }, issues: ['核对输出达到长度限制，尚未完成全部检查。'],
      receipt: { status: 'received', stopReason: 'max_tokens', rawOutput: 'PRIVATE-INCOMPLETE-JSON', inputCharacters: 100, maxOutputTokens: 4096, unsettledRequests: 0 },
    } })));
    expect(document.text).toContain('办公交付尚未完成核对');
    expect(document.text).toContain('0/31 处内容');
    expect(document.text).toContain('核对输出达到长度限制');
    expect(document.all).not.toContain('PRIVATE-INCOMPLETE-JSON');
  });
  it('keeps native ordered starts, nested lists, continuation paragraphs and task checkboxes', async () => {
    const document = await readDoc(input('3. 首项\n\n   续段\n\n   - 二级\n     - [x] 已确认\n     - [ ] 待核对\n\n4. 末项\n\n8. 新列表'));
    expect(document.text).toContain('续段'); expect(document.text).toContain('[x] 已确认'); expect(document.text).toContain('[ ] 待核对');
    const numbering = load(document.files.get('word/numbering.xml')!, { xmlMode: true });
    expect(numbering('w\\:start[w\\:val="3"]').length).toBeGreaterThan(0);
    expect(document.xml('w\\:ilvl[w\\:val="2"]').length).toBeGreaterThan(0);
    expect(document.xml('w\\:p').filter((_, node) => document.xml(node).text().includes('续段')).find('w\\:numPr').length).toBe(0);
  });
  it('retains escaped table pipes, alignments, long cells and every row rather than a screen page', async () => {
    const content = '| 编号 | 金额 | 说明 |\n| :--- | ---: | :---: |\n'
      + Array.from({ length: 65 }, (_, i) => `| 00${i} | 0.30 | **甲\\|乙** ${i === 64 ? '末项'.repeat(140) : '备注'} |`).join('\n');
    const document = await readDoc(input(content));
    expect(document.xml('w\\:tbl')).toHaveLength(1); expect(document.xml('w\\:tr')).toHaveLength(66); expect(document.xml('w\\:tc')).toHaveLength(198);
    expect(document.text).toContain('甲|乙'); expect(document.text).toContain('末项'.repeat(140));
    expect(document.xml('w\\:tblHeader')).toHaveLength(1);
    expect(document.xml('w\\:jc[w\\:val="right"]').length).toBeGreaterThan(0);
    expect(document.xml('w\\:trHeight')).toHaveLength(0);
    expect(document.all).toContain('D9D9D9');
  });
  it('supports reference links and footnotes, with visible URLs for printed documents', async () => {
    const document = await readDoc(input('参考 [报告][ref] 与 [官网](https://example.com/a?q=1&b=2)。[^来源]\n\n[ref]: https://example.com/report\n\n[^来源]: 2026-09-14 原文说明。'));
    expect(document.text).toContain('报告'); expect(document.text).toContain('https://example.com/report');
    expect(document.text).toContain('https://example.com/a?q=1&b=2'); expect(document.text).toContain('2026-09-14 原文说明');
    expect(document.xml('w\\:footnoteReference')).toHaveLength(1);
    const relationships = load(document.files.get('word/_rels/document.xml.rels')!, { xmlMode: true });
    const external = relationships('Relationship[TargetMode="External"]').toArray();
    expect(external.length).toBeGreaterThan(0);
    expect(external.every(node => node.attribs.Type.endsWith('/hyperlink'))).toBe(true);
  });
  it('does not fetch or activate HTML, images, script links, file links or credentials', async () => {
    const fetch = vi.fn(() => { throw new Error('Unexpected network'); }); vi.stubGlobal('fetch', fetch);
    const document = await readDoc(input('<script>alert("x")</script>\n\n![图示](https://example.com/tracker.png)\n\n[执行](javascript:alert%281%29) [本地](file:///C:/private.txt) [凭据](https://user:password@example.com/)'));
    expect(fetch).not.toHaveBeenCalled(); expect(document.text).toContain('<script>alert("x")</script>');
    expect(document.text).toContain('[图片：图示；https://example.com/tracker.png]'); expect(document.warnings).toHaveLength(3);
    const relationships = load(document.files.get('word/_rels/document.xml.rels')!, { xmlMode: true });
    expect(relationships('Relationship[TargetMode="External"]')).toHaveLength(0);
    expect([...document.files.keys()].some(name => /media|vba|embeddings/i.test(name))).toBe(false);
    expect(document.xml('w\\:altChunk')).toHaveLength(0);
  });
  it('retains research dates, URLs, old source limitations and incomplete verification', async () => {
    const value = message({ research: { assessment: { status: 'insufficient_evidence', researchDate: '2026-09-14', windowStart: '2026-08-15', sourceCount: 1,
      datedSourceCount: 0, primarySourceCount: 0, independentPublisherCount: 1, issues: ['近期证据不足'] },
    sources: [{ id: 'S1', url: 'https://example.com/2025', title: '旧报告', query: 'query-private', retrievedAt: '2026-09-14', publication: { date: '2025-06-08', basis: 'url_hint' },
      readable: true, relevant: true, publisher: 'unverified', excerpt: 'PRIVATE-SOURCE-EXCERPT', passages: ['PRIVATE-PASSAGE'] }],
    review: { passed: false, checks: [{ id: 'F1', status: 'rejected', reason: '旧内容不能作最新依据' }], missingRequirements: ['缺少一手源'] } } });
    const document = await readDoc(reportExportInput(value));
    for (const text of ['2026-09-14', '2025-06-08', 'https://example.com/2025', '窗口外旧来源', '仅 URL 线索', '旧内容不能作最新依据', '缺少一手源']) expect(document.text).toContain(text);
    expect(document.all).not.toContain('PRIVATE-'); expect(document.all).not.toContain('query-private');
  });
  it('chooses a wider page for wide tables and preserves data past header width', async () => {
    const content = '| A | B | C | D | E | F | G |\n|---|---|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |';
    const document = await readDoc(input(content));
    expect(Number(document.xml('w\\:pgSz').attr('w:w'))).toBeGreaterThan(Number(document.xml('w\\:pgSz').attr('w:h')));
    expect(document.xml('w\\:tr').last().find('w\\:tc').last().text()).toContain('8');
  });
  it.each(['\u0000', '\u000b', '\ud800', '\uffff'])('rejects XML-incompatible character %j without a partial download', async value => {
    await expect(encodeReportDocument(input(`报告${value}`))).rejects.toThrow('无法完整保存');
  });
  it('rejects empty, oversized or excessively nested content without truncation', async () => {
    await expect(encodeReportDocument({ ...input('正文'), content: '' })).rejects.toThrow('为空');
    await expect(encodeReportDocument(input('字'.repeat(200001)))).rejects.toThrow('容量');
    await expect(encodeReportDocument(input('> '.repeat(34) + '正文'))).rejects.toThrow('复杂');
    await expect(encodeReportDocument(input(Array.from({ length: 10 }, (_, i) => `${'  '.repeat(i)}- 层级`).join('\n')))).rejects.toThrow('8层');
    const columns = Array.from({ length: 13 }, (_, i) => String(i));
    await expect(encodeReportDocument(input(`|${columns.join('|')}|\n|${columns.map(() => '---').join('|')}|`))).rejects.toThrow('12列');
  });
  it('sanitizes only the download name, not source title text', async () => {
    const document = await readDoc(input('# 销售:比较/确认?\n\n正文'));
    expect(document.fileName).not.toMatch(/[<>:"/\\|?*]/); expect(document.text).toContain('销售:比较/确认?');
  });
});
