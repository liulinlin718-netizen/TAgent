import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResearchSource } from '../research-evidence.js';

const mocks = vi.hoisted(() => ({ search: vi.fn(), fetch: vi.fn(), browser: vi.fn() }));
vi.mock('../tools/web-search.js', () => ({ createWebSearchTool: () => ({ execute: mocks.search }) }));
vi.mock('../tools/browser-pool.js', () => ({ newBrowserPage: mocks.browser }));
vi.mock('../public-network.js', async importOriginal => ({
  ...await importOriginal<typeof import('../public-network.js')>(), publicFetch: mocks.fetch,
}));
import { createWebResearchTool } from '../tools/web-research.js';

const one = 'https://publisher-one.example/report';
const two = 'https://publisher-two.example/report';
const original = 'https://original.example/announcements/agent';
const other = 'https://other-original.example/release';
const nested = 'https://nested.example/release';
const beyond = 'https://beyond.example/release';
const links = [original, other, 'http://127.0.0.1/private'];
const html = (urls: string[]) => `<html><head><meta property="article:published_time" content="2026-09-10"></head><body><article>
<h1>AI Agent release report</h1><p>${'The AI Agent release is planned, not yet generally available. '.repeat(12)}</p>
${urls.map(url => `<p>The AI Agent release is described in the <a href="${url}">original announcement</a>.</p>`).join('')}
</article></body></html>`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('JINA_API_KEY', '');
  mocks.browser.mockRejectedValue(new Error('Browser unavailable in fixture'));
  mocks.search.mockResolvedValue([one, `${one}/duplicate-site`, two].map(url => `### AI Agent release\n- URL: ${url}\n- AI Agent release report`).join('\n'));
  mocks.fetch.mockImplementation(async (url: string) => new Response(html(url === one ? links : url === original ? [nested] : url === nested ? [beyond] : []), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe('bounded original citation reading', () => {
  it('follows a standalone original link with its local context but checks the target date independently', async () => {
    mocks.search.mockResolvedValue(`### 中国 AI 早报\n- URL: ${one}\n- 中国AI资讯`);
    mocks.fetch.mockImplementation(async (url: string) => new Response(url === one
      ? html([]).replace('</article>', `<p>**中国大模型发布**</p><p><a href="${original}">阅读原文</a></p><p>国产大模型进入实验阶段。</p></article>`)
      : html([]).replace('2026-09-10', '2026-09-09').replace('</article>', '<p>中国大模型实验产品，尚未正式开放。</p></article>'),
    { headers: { 'content-type': 'text/html' } }));
    const sources: ResearchSource[] = [];
    const output = await createWebResearchTool({ now: new Date('2026-09-10T02:00:00Z'), topic: '今天的国内AI资讯', onSources: items => sources.push(...items) })
      .execute({ query: '国内 AI 资讯', maxResults: 2, maxPages: 2 });
    expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual([one, original]);
    expect(sources.find(source => source.url === original)).toMatchObject({ discoveredFrom: one, readable: true, relevant: true,
      publication: { date: '2026-09-09', basis: 'publication_metadata' } });
    expect(output).toContain('发布日期 2026-09-09 早于核验窗口');
  });
  it('labels yesterday-only materials as background next to the actual text in a same-day request', async () => {
    mocks.search.mockResolvedValue(`### AI Agent release\n- URL: ${one}\n- AI Agent news`);
    mocks.fetch.mockResolvedValue(new Response(html([]).replace('2026-09-10', '2026-09-14'), { headers: { 'content-type': 'text/html' } }));
    const output = await createWebResearchTool({ now: new Date('2026-09-15T02:00:00Z'), topic: '今天的AI Agent资讯' })
      .execute({ query: 'AI Agent', maxPages: 2 });
    expect(output).toContain('核验窗口: 2026-09-15 至 2026-09-15');
    const materials = output.split('## 来源材料')[1];
    expect(materials).toContain('发布日期 2026-09-14 早于核验窗口 2026-09-15 至 2026-09-15');
    expect(materials).toContain('该材料只能支持有归因的背景');
    expect(materials).toContain('not yet generally available');
  });
  it('continues past yesterday to today and retains the original task date when the tool query is shortened', async () => {
    mocks.search.mockResolvedValue([one, two, original, other].map(url => `### AI Agent release\n- URL: ${url}\n- AI Agent news`).join('\n'));
    mocks.fetch.mockImplementation(async (url: string) => new Response(html([]).replace('2026-09-10',
      url === one || url === two ? '2026-09-14' : '2026-09-15'), { headers: { 'content-type': 'text/html' } }));
    const output = await createWebResearchTool({ now: new Date('2026-09-15T02:00:00Z'), topic: '今天的AI Agent资讯' })
      .execute({ query: 'AI Agent', maxPages: 2, maxResults: 4 });
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ query: expect.stringContaining('2026-09-15') }), undefined);
    expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual([one, two, original, other]);
    const materials = output.split('## 来源材料')[1];
    expect(materials).toContain(`- URL: ${original}`);
    expect(materials).not.toContain(`- URL: ${one}`);
  });
  it('reads independent sites first and traces two citation levels but never a third', async () => {
    const sources: ResearchSource[] = [];
    const output = await createWebResearchTool({ now: new Date('2026-09-11T00:00:00Z'), topic: 'AI Agent', onSources: items => sources.push(...items) })
      .execute({ query: 'AI Agent 最新进展', maxPages: 3, maxResults: 5 });
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ query: expect.stringContaining('2026年 9月') }), undefined);
    expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual([one, two, original, other, nested]);
    expect(sources.find(source => source.url === nested)?.discoveredFrom).toBe(original);
    expect(sources.find(source => source.url === original)).toMatchObject({ readable: true, relevant: true, discoveredFrom: one,
      publication: { date: '2026-09-10', basis: 'publication_metadata' } });
    expect(sources.find(source => source.url === original)?.passages?.join(' ')).toContain('not yet generally available');
    expect(output).toContain(original);
    expect(mocks.browser).not.toHaveBeenCalled();
  });
  it('follows citations discovered after the first search batch and prioritizes a usable publisher page', async () => {
    const later = 'https://later.example/report';
    const primary = 'https://openai.com/index/fixture-release';
    mocks.search.mockResolvedValue([one, two, later, other].map(url => `### AI Agent release\n- URL: ${url}\n- AI Agent report`).join('\n'));
    mocks.fetch.mockImplementation(async (url: string) => new Response(
      url === one || url === two ? html([]).replace('2026-09-10', '2025-01-01') : html(url === later ? [primary] : []),
      { headers: { 'content-type': 'text/html' } }));
    const sources: ResearchSource[] = [];
    const output = await createWebResearchTool({ now: new Date('2026-09-11T00:00:00Z'), topic: '近30天 AI Agent 最新进展', onSources: items => sources.push(...items) })
      .execute({ query: 'AI Agent 最新进展', maxPages: 2, maxResults: 4 });
    expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual([one, two, later, other, primary]);
    expect(sources.find(source => source.url === primary)).toMatchObject({ discoveredFrom: later, readable: true, relevant: true });
    const materials = output.split('## 来源材料')[1];
    expect(materials).toContain(primary);
    expect(materials).not.toContain(one);
  });
  it('traces a short original-source link using the read parent but checks the destination independently', async () => {
    const primary = 'https://openai.com/index/fixture-agents-api';
    mocks.fetch.mockImplementation(async (url: string) => {
      const page = url === one ? html([original]) : url === original
        ? html([]).replace('</article>', `<p>OpenAI has released the <a href="${primary}">Agents API</a> in public beta.</p></article>`)
        : html(url === primary ? [beyond] : []);
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    });
    const sources: ResearchSource[] = [];
    await createWebResearchTool({ topic: 'AI Agent', onSources: items => sources.push(...items) }).execute({ query: 'AI Agent', maxPages: 3 });
    expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual([one, two, original, primary]);
    expect(sources.find(source => source.url === primary)).toMatchObject({ discoveredFrom: original, readable: true, relevant: true,
      publisher: 'primary', publication: { date: '2026-09-10', basis: 'publication_metadata' } });
  });
  it('does not transfer the parent date or relevance to an unrelated linked page or follow its links', async () => {
    mocks.fetch.mockImplementation(async (url: string) => new Response(url === one ? html([original]) : url === original
      ? `<title>AI Agent release</title><article><p>${'Manage cookie consent and marketing preferences. '.repeat(20)}</p><p><a href="${nested}">original announcement</a></p></article>` : html([]),
    { headers: { 'content-type': 'text/html' } }));
    const sources: ResearchSource[] = [];
    await createWebResearchTool({ topic: 'AI Agent', onSources: items => sources.push(...items) }).execute({ query: 'AI Agent', maxPages: 2 });
    expect(sources.find(source => source.url === original)).toMatchObject({ readable: true, relevant: false, publication: { basis: 'unknown' } });
    expect(mocks.fetch.mock.calls.map(call => call[0])).not.toContain(nested);
  });
  it('keeps old original material as background instead of promoting its publisher to recent evidence', async () => {
    const primary = 'https://openai.com/index/old-fixture';
    mocks.fetch.mockImplementation(async (url: string) => new Response(html(url === one ? [primary] : [])
      .replace('2026-09-10', url === primary ? '2025-01-01' : '2026-09-10'), { headers: { 'content-type': 'text/html' } }));
    const sources: ResearchSource[] = [];
    const output = await createWebResearchTool({ now: new Date('2026-09-11T00:00:00Z'), topic: '近30天 AI Agent 最新进展', onSources: items => sources.push(...items) })
      .execute({ query: 'AI Agent 最新进展', maxPages: 2 });
    expect(sources.find(source => source.url === primary)?.publication.date).toBe('2025-01-01');
    const materials = output.split('## 来源材料')[1];
    expect(materials).not.toContain(`- URL: ${primary}`);
    expect(materials).toContain('本次已读取，具体事实仍需核对；发布日期: 2025-01-01');
  });
  it('filters prohibited citations before allocating slots so permitted originals are still read', async () => {
    mocks.fetch.mockImplementation(async (url: string) => new Response(html(url === one ? [
      'https://blocked-one.example/release', 'https://blocked-two.example/release', original,
    ] : []), { headers: { 'content-type': 'text/html' } }));
    await createWebResearchTool({ allowedDomains: ['publisher-one.example', 'publisher-two.example', 'original.example'], topic: 'AI Agent' })
      .execute({ query: 'AI Agent', maxPages: 2 });
    expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual([one, two, original]);
  });
  it('reserves a later search batch before spending all citation slots on the first publisher', async () => {
    const later = 'https://later.example/report';
    const primary = 'https://anthropic.com/news/fixture-release';
    const secondary = 'https://secondary.example/report';
    mocks.search.mockResolvedValue([one, two, later, other].map(url => `### AI Agent report\n- URL: ${url}\n- AI Agent release`).join('\n'));
    mocks.fetch.mockImplementation(async (url: string) => new Response(html(url === one ? [original, secondary, nested] : url === later ? [primary] : [])
      .replace('2026-09-10', url === primary ? '2026-09-10' : '2025-01-01'), { headers: { 'content-type': 'text/html' } }));
    await createWebResearchTool({ now: new Date('2026-09-11T00:00:00Z'), topic: '近30天 AI Agent 最新进展' })
      .execute({ query: 'AI Agent 最新进展', maxPages: 4, maxResults: 8 });
    const reads = mocks.fetch.mock.calls.map(call => call[0]);
    expect(reads).toEqual([one, two, original, secondary, later, other, primary, nested]);
  });
  it('bounds citation fan-out to four reads and all reads to eight while avoiding cycles', async () => {
    const candidates = Array.from({ length: 8 }, (_, index) => `https://search-${index}.example/report`);
    mocks.search.mockResolvedValue(candidates.map(url => `### AI Agent report\n- URL: ${url}\n- AI Agent release`).join('\n'));
    mocks.fetch.mockImplementation(async (url: string) => new Response(html([
      ...Array.from({ length: 12 }, (_, index) => `https://citation-${index}.example/release`), candidates[0], url,
    ]).replace('2026-09-10', '2025-01-01'), { headers: { 'content-type': 'text/html' } }));
    const sources: ResearchSource[] = [];
    await createWebResearchTool({ now: new Date('2026-09-11T00:00:00Z'), topic: '近30天 AI Agent 最新进展', onSources: items => sources.push(...items) })
      .execute({ query: 'AI Agent 最新进展', maxPages: 5, maxResults: 8 });
    const reads = mocks.fetch.mock.calls.map(call => call[0]);
    expect(reads).toHaveLength(8);
    expect(new Set(reads).size).toBe(8);
    expect(sources.filter(source => source.discoveredFrom)).toHaveLength(4);
  });
  it('counts redirected reads once and deduplicates final URLs and tracking variants', async () => {
    mocks.fetch.mockImplementation(async (url: string) => {
      const response = new Response(html(url === one ? [original, `${other}?utm_source=mirror`] : url === original ? [other, one] : []),
        { headers: { 'content-type': 'text/html' } });
      if (url === original) Object.defineProperty(response, 'url', { value: other });
      return response;
    });
    const output = await createWebResearchTool({ topic: 'AI Agent' }).execute({ query: 'AI Agent', maxPages: 3 });
    const reads = mocks.fetch.mock.calls.map(call => call[0]);
    expect(reads).toEqual([one, two, original, other]);
    expect(new Set(reads).size).toBe(reads.length);
    expect(output.match(new RegExp(`^- URL: ${other}$`, 'gm'))).toHaveLength(1);
    expect(output).toContain(`实际读取地址: ${other}`);
    expect(output).toContain('本次已读取，具体事实仍需核对');
  });
  it('does not let two redirects to the same article fill the source target and hide the next independent result', async () => {
    const alias = 'https://alias.example/old-report';
    mocks.search.mockResolvedValue([one, alias, two].map(url => `### AI Agent report\n- URL: ${url}\n- AI Agent release`).join('\n'));
    mocks.fetch.mockImplementation(async (url: string) => {
      const response = new Response(html([]), { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: url === alias ? `${one}?utm_source=alias` : url });
      return response;
    });
    const output = await createWebResearchTool({ topic: 'AI Agent' }).execute({ query: 'AI Agent', maxResults: 3, maxPages: 2 });
    expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual([one, alias, two]);
    expect(output.match(new RegExp(`^- URL: ${one}$`, 'gm'))).toHaveLength(1);
    expect(output).toContain(`- URL: ${two}`);
  });
  it('does not drop a different ref version when deduplicating search pages', async () => {
    const urls = [`${one}?ref=old`, `${one}?ref=current`];
    mocks.search.mockResolvedValue(urls.map(url => `### AI Agent report\n- URL: ${url}\n- AI Agent release`).join('\n'));
    mocks.fetch.mockImplementation(async () => new Response(html([]), { headers: { 'content-type': 'text/html' } }));
    const output = await createWebResearchTool({ topic: 'AI Agent' }).execute({ query: 'AI Agent', maxResults: 2, maxPages: 2 });
    expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual(urls);
    for (const url of urls) expect(output).toContain(`- URL: ${url}`);
  });
  it('retains a readable page if a concurrent alias returns a verification page for the same destination', async () => {
    const alias = 'https://alias.example/old-report';
    mocks.search.mockResolvedValue([one, alias, two].map(url => `### AI Agent report\n- URL: ${url}\n- AI Agent release`).join('\n'));
    mocks.fetch.mockImplementation(async (url: string) => {
      const response = new Response(url === alias ? '<main>Verify you are human. ' + 'Checking '.repeat(70) + '</main>' : html([]),
        { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: url === alias ? one : url });
      return response;
    });
    const output = await createWebResearchTool({ topic: 'AI Agent' }).execute({ query: 'AI Agent', maxResults: 3, maxPages: 2 });
    expect(output).toContain(`- URL: ${one}`);
    expect(output).toContain('not yet generally available');
    expect(output).not.toContain('Verify you are human');
    expect(output).toContain(`- URL: ${two}`);
  });
  it('preserves failed original reads without inventing evidence or retrying the citation', async () => {
    mocks.fetch.mockImplementation(async (url: string) => url === original ? new Response('', { status: 503 })
      : new Response(html(url === one ? [original] : []), { headers: { 'content-type': 'text/html' } }));
    const sources: ResearchSource[] = [];
    await createWebResearchTool({ topic: 'AI Agent', onSources: items => sources.push(...items) }).execute({ query: 'AI Agent', maxPages: 2 });
    expect(sources.find(source => source.url === original)).toMatchObject({ discoveredFrom: one, readable: false, relevant: false,
      publication: { basis: 'unknown' } });
    expect(mocks.fetch.mock.calls.filter(call => call[0] === original)).toHaveLength(1);
  });
  it('does not read a browser HTTP error body as evidence, even when it echoes the task keywords', async () => {
    mocks.fetch.mockResolvedValue(new Response('', { status: 503 }));
    const content = vi.fn().mockResolvedValue(html([]));
    const close = vi.fn();
    mocks.browser.mockResolvedValue({ ctx: { close }, page: {
      goto: vi.fn().mockResolvedValue({ status: () => 403 }), content,
    } });
    const sources: ResearchSource[] = [];
    await createWebResearchTool({ topic: 'AI Agent', onSources: items => sources.push(...items) })
      .execute({ query: 'AI Agent', maxResults: 1, maxPages: 1 });
    expect(content).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ readable: false, relevant: false, publication: { basis: 'unknown' } });
  });
  it('stops tracing immediately after cancellation without scheduling the next citation level', async () => {
    const controller = new AbortController();
    const tool = createWebResearchTool({ topic: 'AI Agent', onSources: items => {
      if (items.some(item => item.discoveredFrom)) controller.abort(new Error('Stop research'));
    } });
    await expect(tool.execute({ query: 'AI Agent', maxPages: 3 }, { signal: controller.signal })).rejects.toThrow('Stop research');
    expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual([one, two, original, other]);
  });
  it('does not follow original-looking citations outside the tool whitelist or to private addresses', async () => {
    await createWebResearchTool({ allowedDomains: ['publisher-one.example', 'publisher-two.example'], topic: 'AI Agent' })
      .execute({ query: 'AI Agent', maxPages: 2 });
    expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual([one, two]);
    expect(mocks.browser).not.toHaveBeenCalled();
  });
  it('continues within the read budget when initial pages are old, undated or unrelated, and ranks usable material first', async () => {
    const urls = Array.from({ length: 6 }, (_, index) => `https://publisher-${index}.example/article`);
    mocks.search.mockResolvedValue(urls.map(url => `### AI Agent report\n- URL: ${url}\n- Latest AI Agent release`).join('\n'));
    mocks.fetch.mockImplementation(async (url: string) => {
      const index = urls.indexOf(url);
      const page = index === 0 ? html([]).replace('2026-09-10', '2025-01-01')
        : index === 1 ? html([]).replace(/<meta[^>]+>/, '')
        : index === 2 ? '<title>AI Agent report</title><main>' + 'Manage cookie consent and marketing preferences. '.repeat(30) + '</main>'
        : html([]);
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    });
    const sources: ResearchSource[] = [];
    const output = await createWebResearchTool({ now: new Date('2026-09-11T00:00:00Z'), topic: '近30天 AI Agent 最新进展', onSources: items => sources.push(...items) })
      .execute({ query: 'AI Agent', maxPages: 2, maxResults: 6 });
    expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual(urls);
    expect(mocks.fetch.mock.calls.length).toBeLessThanOrEqual(8);
    expect(sources).toHaveLength(6);
    expect(sources[0].publication.date).toBe('2025-01-01');
    expect(sources[2].relevant).toBe(false);
    const materialSection = output.split('## 来源材料')[1];
    expect(materialSection).toContain(urls[3]);
    expect(materialSection).toContain(urls[4]);
    expect(materialSection).not.toContain(urls[0]);
    expect(mocks.browser).not.toHaveBeenCalled();
  });
  it('does not force a 30-day window on a general current-state task', async () => {
    mocks.fetch.mockImplementation(async () => new Response(html([]).replace('2026-09-10', '2025-01-01'), { headers: { 'content-type': 'text/html' } }));
    await createWebResearchTool({ now: new Date('2026-09-11T00:00:00Z'), topic: 'AI Agent 现状' })
      .execute({ query: 'AI Agent 现状', maxPages: 2 });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});
