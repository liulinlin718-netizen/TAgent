import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => ({ goto: vi.fn(), close: vi.fn(), html: '', redirect: '' }));
const parallel = vi.hoisted(() => vi.fn());
vi.mock('../tools/parallel-search.js', () => ({ searchParallel: parallel }));
vi.mock('../tools/browser-pool.js', () => ({
  newBrowserPage: async () => ({
    page: { goto: browser.goto, url: () => browser.redirect || browser.goto.mock.lastCall?.[0], waitForSelector: async () => {}, content: async () => browser.html },
    ctx: { close: browser.close },
  }),
}));
import { createWebSearchTool, rankSearchOutputs, searchConfigurationStatus } from '../tools/web-search.js';

beforeEach(() => {
  browser.goto.mockReset(); browser.html = ''; browser.redirect = '';
  parallel.mockReset(); vi.stubEnv('TAGENT_SEARCH_PROVIDER', 'auto');
  vi.stubEnv('TAVILY_API_KEY', ''); vi.stubEnv('JINA_API_KEY', '');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('fresh search provider routing', () => {
  it('keeps domestic AI candidates even when snippets use China instead of the user\'s relative wording', async () => {
    parallel.mockResolvedValue([
      { title: '国产大模型融资进展', url: 'https://example.com/domestic-ai', snippet: '中国 AI 公司公布新产品。' },
      { title: 'Chinese AI models', url: 'https://publisher.example/china', snippet: 'China artificial intelligence industry updates.' },
      { title: '今天国内风电行业', url: 'https://example.com/wind', snippet: '风电设备股价上涨。' },
      { title: 'US AI products', url: 'https://example.com/us', snippet: 'US AI companies release a product.' },
    ]);
    const onDiagnostics = vi.fn();
    const output = await createWebSearchTool({ searchProvider: 'parallel', topic: '今天的国内AI资讯', onDiagnostics })
      .execute({ query: '国内AI资讯 2026-09-15' });
    expect(output).toContain('https://example.com/domestic-ai');
    expect(output).toContain('https://publisher.example/china');
    expect(output).not.toContain('https://example.com/wind');
    expect(output).not.toContain('https://example.com/us');
    expect(onDiagnostics).toHaveBeenCalledWith([{ source: 'Parallel Search', status: 'ok', parsedCount: 4, relevantCount: 2 }]);
    expect(parallel).toHaveBeenCalledTimes(1);
  });
  it('does not rank stale results after task cancellation', () => {
    const controller = new AbortController(); controller.abort(new Error('Task stopped'));
    expect(() => rankSearchOutputs('AI agent', [], 5, controller.signal)).toThrow('Task stopped');
  });
  it('aborts all in-flight HTTP providers and does not launch fallback browser searches', async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const http = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      signals.push(init.signal);
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', http);
    const task = createWebSearchTool().execute({ query: 'office notes' }, { signal: controller.signal });
    await vi.waitFor(() => expect(signals.length).toBeGreaterThan(1));
    controller.abort();
    await expect(task).rejects.toThrow();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(browser.goto).not.toHaveBeenCalled();
    const count = http.mock.calls.length;
    await Promise.resolve();
    expect(http).toHaveBeenCalledTimes(count);
  });

  it('does not send searches to an opt-in service by default or confuse model keys with search health', async () => {
    await createWebSearchTool().execute({ query: 'AI agent' });
    expect(parallel).not.toHaveBeenCalled();
    expect(searchConfigurationStatus({ DEEPSEEK_API_KEY: 'secret' })).toMatchObject({ provider: 'auto', connectivity: 'unchecked' });
    expect(JSON.stringify(searchConfigurationStatus({ TAGENT_SEARCH_PROVIDER: 'https://user:secret@example.com' }))).not.toContain('secret');
  });
  it('uses only the selected provider, preserves dated queries and reuses the anonymous search session', async () => {
    vi.stubEnv('TAGENT_SEARCH_PROVIDER', 'parallel');
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-09T00:00:00Z'));
    parallel.mockResolvedValue([
      { title: 'AI agents for office work', url: 'https://example.com/agents', snippet: 'AI agent release', dateHint: '2025-04-01' },
      { title: 'Generic AI directory', url: 'https://example.com/directory', snippet: 'AI art generators' },
    ]);
    try {
      const tool = createWebSearchTool({ topic: 'AI Agent', searchSessionId: 'opaque-test-session' });
      const output = await tool.execute({ query: '近30天 AI Agent', maxResults: 1 });
      await tool.execute({ query: 'AI agent tools' });
      expect(parallel.mock.calls[0][0]).toMatchObject({ objective: expect.stringContaining('2026年 6月'), sessionId: 'opaque-test-session' });
      expect(parallel.mock.calls[1][0].sessionId).toBe('opaque-test-session');
      expect(output).toContain('Parallel Search');
      expect(output).toContain('- URL: https://example.com/agents');
      expect(output).toContain('日期线索（搜索服务，尚未核实）: 2025-04-01');
      expect(output).not.toContain('/directory');
      expect(browser.goto).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('snapshots the provider and returns structured diagnostics without raw candidate content', async () => {
    vi.stubEnv('TAGENT_SEARCH_PROVIDER', 'parallel');
    const onDiagnostics = vi.fn();
    const tool = createWebSearchTool({ topic: 'AI agent', onDiagnostics });
    vi.stubEnv('TAGENT_SEARCH_PROVIDER', 'auto');
    parallel.mockResolvedValue([{ title: 'AI agent office tools', url: 'https://example.com/agent', snippet: 'Private candidate excerpt' }]);
    await tool.execute({ query: 'AI agent' });
    expect(parallel).toHaveBeenCalledTimes(1);
    expect(onDiagnostics).toHaveBeenCalledWith([{ source: 'Parallel Search', status: 'ok', parsedCount: 1, relevantCount: 1 }]);
    expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain('Private candidate excerpt');
    expect(fetch).not.toHaveBeenCalled();
    await createWebSearchTool({ searchProvider: 'invalid' }).execute({ query: 'AI agent' });
    expect(parallel).toHaveBeenCalledTimes(1);
  });
  it('does not silently switch providers on a selected service failure or invalid configuration', async () => {
    vi.stubEnv('TAGENT_SEARCH_PROVIDER', 'parallel');
    parallel.mockRejectedValue(new Error('HTTP 429 Bearer secret'));
    const output = await createWebSearchTool().execute({ query: 'AI agents' });
    expect(output).toContain('限流');
    expect(output).not.toContain('secret');
    expect(output).not.toContain('- URL:');
    expect(browser.goto).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv('TAGENT_SEARCH_PROVIDER', 'misspelled');
    expect(await createWebSearchTool().execute({ query: 'AI agents' })).toContain('搜索配置错误');
    expect(parallel).toHaveBeenCalledTimes(1);
  });
  it('uses the news URL contract and yields article candidates when HTTP providers fail', async () => {
    browser.html = '<a class="title" data-author="Publisher" href="https://example.com/agent">AI agent office release</a>';
    const output = await createWebSearchTool({ topic: 'AI Agent 最新进展' }).execute({ query: 'AI Agent 最新进展', maxResults: 1 });
    const url = new URL(browser.goto.mock.calls[0][0]);
    expect(url.pathname).toBe('/news/search');
    expect([...url.searchParams.keys()]).toEqual(['q']);
    expect(url.searchParams.get('q')).toMatch(/^ai agent news /);
    expect(output).toContain('- 来源: Bing News');
    expect(output).toContain('- URL: https://example.com/agent');
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
  it('reports regional homepage redirects as a provider failure, not absent news or irrelevant results', async () => {
    browser.redirect = 'https://cn.bing.com/';
    const output = await createWebSearchTool({ topic: '支付 agent 现状' }).execute({ query: '支付 agent 现状' });
    expect(output).toContain('Bing News：失败，搜索请求跳转到非搜索页面');
    expect(output).toContain('所有 SearXNG 实例均未返回可用结果');
    expect(output).toContain('这不代表网上没有相关信息');
    expect(output).not.toContain('- URL:');
    expect(output).not.toContain('无关结果已排除');
    expect(browser.close).toHaveBeenCalledTimes(2);
  });
  it('keeps TLS validation failures visible without exposing raw exception credentials', async () => {
    browser.goto.mockRejectedValue(new Error('net::ERR_CERT_COMMON_NAME_INVALID proxy https://user:secret@example.com/'));
    const output = await createWebSearchTool().execute({ query: 'AI Agent 最新进展' });
    expect(output).toContain('TLS 证书校验失败');
    expect(output).not.toContain('secret');
    expect(output).not.toContain('- URL:');
    expect(console.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('secret'));
    expect(browser.close).toHaveBeenCalledTimes(2);
  });
  it('distinguishes parsed-but-filtered candidates from an empty response without fabricating results', async () => {
    browser.html = '<a class="title" data-author="Publisher" href="https://example.com/sports">Local football results</a>';
    const output = await createWebSearchTool({ topic: 'AI agent' }).execute({ query: 'AI Agent 最新进展' });
    expect(output).toContain('Bing News：解析到 1 条候选，主题过滤后保留 0 条');
    expect(output).toContain('Playwright Bing：未取得可解析候选');
    expect(output).not.toContain('- URL:');
  });
  it('retains actual results from a working provider while identifying failed providers separately', async () => {
    browser.redirect = 'https://cn.bing.com/';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('bing.com/search')
      ? new Response('<li class="b_algo"><h2><a href="https://example.com/agents">AI agent announcement</a></h2><p>Office AI agent release</p></li>')
      : new Response(null, { status: 503 })));
    const output = await createWebSearchTool({ topic: 'AI agent' }).execute({ query: 'AI Agent 最新进展', maxResults: 1 });
    expect(output).toContain('- 聚合来源: Bing HTTP');
    expect(output).toContain('- URL: https://example.com/agents');
    expect(output).toContain('Bing News：失败');
    expect(output).toContain('Bing HTTP：解析到 1 条候选，主题过滤后保留 1 条');
  });

  it('uses the international result view for the dated topic fallback, not a second domestic query', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-09T00:00:00Z'));
    const onDiagnostics = vi.fn();
    const http = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (!url.hostname.endsWith('bing.com')) return new Response(null, { status: 503 });
      return new Response(url.searchParams.get('ensearch') === '1'
        ? '<li class="b_algo"><h2><a href="https://example.com/agents">AI agent releases</a></h2><p>2025年4月1日: AI agents for office work.</p></li>'
        : '<li class="b_algo"><h2><a href="https://example.com/art">AI drawing tools</a></h2><p>Image generators</p></li>');
    });
    vi.stubGlobal('fetch', http);
    try {
      const output = await createWebSearchTool({ topic: '近30天 AI Agent 最新进展', onDiagnostics }).execute({ query: '近30天 AI Agent 最新进展', maxResults: 1 });
      const calls = http.mock.calls.filter(([url]) => new URL(url).hostname.endsWith('bing.com'));
      expect(calls).toHaveLength(2);
      const primary = new URL(calls[0][0]), fallback = new URL(calls[1][0]);
      expect(primary.searchParams.get('q')).toContain('2026年 6月');
      expect(primary.searchParams.get('mkt')).toBe('zh-CN');
      expect(fallback.searchParams.get('q')).toBe('ai agent news June 2026');
      expect(fallback.searchParams.get('mkt')).toBe('en-US');
      expect(fallback.searchParams.get('ensearch')).toBe('1');
      expect(output).toContain('- 来源: Bing International');
      expect(output).toContain('2025年4月1日');
      expect(output).not.toContain('https://example.com/art');
      expect(onDiagnostics).toHaveBeenCalledWith(expect.arrayContaining([
        { source: 'Bing HTTP', status: 'empty', parsedCount: 1, relevantCount: 0 },
        { source: 'Bing International', status: 'ok', parsedCount: 1, relevantCount: 1 },
      ]));
      expect(browser.goto).toHaveBeenCalledTimes(1); // News probe only; no extra browser fallback.
      expect(parallel).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('keeps exact phrases and site operators unchanged when changing the Bing result view', async () => {
    const query = 'site:example.com "AI agent"';
    const http = vi.fn(async (_input: string) => new Response(null, { status: 503 })); vi.stubGlobal('fetch', http);
    await createWebSearchTool().execute({ query });
    const fallback = http.mock.calls.map(call => new URL(String(call[0])))
      .filter(url => url.hostname.endsWith('bing.com') && url.searchParams.get('ensearch') === '1');
    expect(fallback).toHaveLength(1);
    expect(fallback[0].searchParams.get('q')).toBe(query);
    const browserQuery = new URL(browser.goto.mock.calls[0][0]);
    expect(browserQuery.searchParams.get('q')).toBe(query);
    expect(browserQuery.searchParams.get('ensearch')).toBe('1');
  });

  it('does not use results from a Bing redirect that replaced the query', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input);
      if (!url.hostname.endsWith('bing.com')) return new Response(null, { status: 503 });
      return url.searchParams.get('q') === 'other-topic'
        ? new Response('<li class="b_algo"><h2><a href="https://example.com/mislabelled">AI agent tools</a></h2></li>')
        : new Response(null, { status: 302, headers: { location: 'https://www.bing.com/search?q=other-topic' } });
    }));
    browser.redirect = 'https://www.bing.com/search?q=other-topic';
    browser.html = '<li class="b_algo"><h2><a href="https://example.com/mislabelled">AI agent tools</a></h2></li>';
    const output = await createWebSearchTool().execute({ query: 'AI agent' });
    expect(output).toContain('搜索跳转改变了检索词');
    expect(output).not.toContain('- URL:');
    expect(output).not.toContain('mislabelled');
  });

  it('does not add fallback requests when the first provider has enough relevant candidates', async () => {
    const http = vi.fn(async (input: string) => new URL(input).hostname.endsWith('bing.com')
      ? new Response('<li class="b_algo"><h2><a href="https://example.com/agent">AI agent tool</a></h2></li>')
      : new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', http);
    await createWebSearchTool().execute({ query: 'AI agent', maxResults: 1 });
    expect(http.mock.calls.filter(([url]) => new URL(url).hostname.endsWith('bing.com'))).toHaveLength(1);
    expect(browser.goto).not.toHaveBeenCalled();
  });
});
