import { requestSignal } from '../run-control.js';
/**
 * Web Search Tool — 网络搜索
 *
 * Configured search APIs and public HTML providers return candidates only.
 * Relevance is checked against the original topic before candidates are read.
 */

import type { ToolExecutor, ToolExecutionContext } from './registry.js';
import { randomUUID } from 'node:crypto';
import { PublicNetworkError, publicFetch as fetch } from '../public-network.js';
import { searchParallel } from './parallel-search.js';
import { newBrowserPage } from './browser-pool.js';
import { load } from 'cheerio';
import { extractTopicTerms, normalizeSourceUrl, sourceRelevance } from '../research-evidence.js';
import { resolveResearchSearchProvider, type ResearchSearchSelection, type SearchProbeDiagnostic } from '../search-settings.js';

export interface SearchSourceOutput {
  source: string;
  markdown: string;
  query?: string;
  status?: 'ok' | 'empty' | 'failed';
  error?: string;
}

export interface ParsedSearchHit {
  title: string;
  url: string;
  snippet: string;
  source: string;
  dateHint?: string;
}

export function searchConfigurationStatus(env: Record<string, string | undefined> = process.env) {
  const selected = resolveResearchSearchProvider(env.TAGENT_SEARCH_PROVIDER);
  if (selected === 'invalid') return {
    provider: 'invalid', status: 'invalid', connectivity: 'unchecked',
    note: 'TAGENT_SEARCH_PROVIDER 只支持 auto 或 parallel；未自动切换其他服务。',
  };
  return {
    provider: selected,
    status: 'configured',
    connectivity: 'unchecked',
    note: selected === 'parallel'
      ? '已显式选择 Parallel 免费搜索；仅发送检索目标、关键词和匿名关联 ID，受免费服务限流约束。'
      : '使用现有搜索源；模型 API Key 不提供搜索能力，是否可用需要实际检索确认。',
  };
}

export function createWebSearchTool(options?: { topic?: string; searchSessionId?: string; searchProvider?: ResearchSearchSelection;
  onDiagnostics?: (diagnostics: SearchProbeDiagnostic[]) => void }): ToolExecutor {
  const searchSessionId = options?.searchSessionId || randomUUID();
  const configuration = searchConfigurationStatus({ TAGENT_SEARCH_PROVIDER: options?.searchProvider ?? process.env.TAGENT_SEARCH_PROVIDER });
  return {
    definition: {
      name: 'web_search',
      description: '使用已配置的搜索服务或浏览器查找公开页面候选。搜索摘要和日期线索不是已核实的事实，重要结果需读取原文。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词',
          },
          maxResults: {
            type: 'number',
            description: '最大结果数量（默认 5）',
          },
        },
        required: ['query'],
      },
    },

    async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
      const signal = context?.signal;
      signal?.throwIfAborted();
      const rawQuery = typeof args.query === 'string' ? args.query.trim() : '';
      if (!rawQuery) return 'web_search 需要 query 参数。';

      const query = buildFreshSearchQuery(rawQuery);
      const maxResults = clampNumber(args.maxResults, 5, 1, 10);
      if (configuration.status === 'invalid') return `搜索配置错误：${configuration.note}`;
      const tavilyKey = process.env.TAVILY_API_KEY;
      const alternative = buildTopicSearchQuery(rawQuery);
      if (configuration.provider === 'parallel') {
        const output = await runSearchSource('Parallel Search', async () => {
          const candidates = await searchParallel({ objective: query, queries: [query, alternative], sessionId: searchSessionId, signal });
          return candidates.map(hit => `### ${cleanInlineText(hit.title)}\n- URL: ${hit.url}\n- ${cleanInlineText(hit.snippet)}`
            + (hit.dateHint ? `\n- 日期线索（搜索服务，尚未核实）: ${hit.dateHint}` : '')).join('\n\n');
        });
        signal?.throwIfAborted();
        output.query = [...new Set([query, alternative].filter(Boolean))].join('；');
        options?.onDiagnostics?.(searchDiagnostics([output], options?.topic || query));
        return combineSearchOutputs(query, [output], maxResults, options?.topic)
          || `搜索没有返回与主题相关的可引用页面：${query}\n\n${formatSearchDiagnostics([output], options?.topic || query)}\n\n这不代表网上没有相关信息。当前只使用用户选择的搜索服务，未自动转发到其他服务；可检查服务状态或提供来源 URL。`;
      }
      const fresh = shouldPreferFreshResults(rawQuery) || /近\s*30\s*天|last\s*30\s*days/i.test(rawQuery);
      const searchJobs: Promise<SearchSourceOutput | null>[] = [
        fresh ? runSearchSource('Bing News', () => searchWithPlaywright(alternative || query, 10, 'news', signal)) : Promise.resolve(null),
        tavilyKey ? runSearchSource('Tavily', () => searchWithTavily(query, maxResults, tavilyKey, signal)) : Promise.resolve(null),
        process.env.JINA_API_KEY ? runSearchSource('Jina Search', () => searchWithJinaSearch(query, maxResults, signal)) : Promise.resolve(null),
        runSearchSource('Bing HTTP', () => searchWithBingHTTP(query, maxResults, signal)),
        shouldSearchGitHub(query) ? runSearchSource('GitHub Repos', () => searchGitHubRepos(query, maxResults, signal)) : Promise.resolve(null),
        runSearchSource('SearXNG', () => searchWithSearXNGRace(query, maxResults, signal)),
      ];

      const outputs = (await Promise.all(searchJobs)).filter((item): item is SearchSourceOutput => !!item);
      signal?.throwIfAborted();
      outputs.forEach(output => { output.query = output.source === 'Bing News' ? alternative || query : query; });
      if (alternative && rankSearchOutputs(options?.topic || query, outputs, maxResults).length < Math.min(3, maxResults)) {
        const focused = await runSearchSource('Bing International', () => searchWithBingHTTP(alternative, 10, signal, true));
        if (focused) outputs.push({ ...focused, query: alternative });
      }
      signal?.throwIfAborted();
      if (rankSearchOutputs(options?.topic || query, outputs, maxResults).length < Math.min(3, maxResults)) {
        const browser = await runSearchSource('Playwright Bing', () => searchWithPlaywright(alternative || query, 10, 'web', signal, true));
        if (browser) outputs.push({ ...browser, query: alternative || query });
      }
      signal?.throwIfAborted();
      options?.onDiagnostics?.(searchDiagnostics(outputs, options?.topic || query));
      const combined = combineSearchOutputs(query, outputs, maxResults, options?.topic);
      if (combined) return combined;

      return `搜索没有返回与主题相关的可引用页面：${query}\n\n${formatSearchDiagnostics(outputs, options?.topic || query)}\n\n这不代表网上没有相关信息。可检查网络/代理、使用已配置的搜索 API，或提供来源 URL 读取；不要反复提交相同查询，也不要用记忆补成最新事实。`;
    },
  };
}

function searchDiagnostics(outputs: SearchSourceOutput[], topic: string): SearchProbeDiagnostic[] {
  return outputs.map(output => {
    const parsedCount = parseSearchHits(output.markdown, output.source).length;
    const relevantCount = rankSearchOutputs(topic, [output], parsedCount).length;
    return { source: output.source, status: output.status === 'failed' ? 'failed' : relevantCount ? 'ok' : 'empty',
      parsedCount, relevantCount, ...(output.error ? { error: output.error } : {}) };
  });
}

async function runSearchSource(
  source: string,
  search: () => Promise<string | null>,
): Promise<SearchSourceOutput> {
  try {
    const markdown = await search();
    if (!markdown || !markdown.trim()) return { source, markdown: '', status: 'empty' };
    return { source, markdown, status: 'ok' };
  } catch (error) {
    const reason = searchFailureReason(error);
    console.warn(`[web_search] ${source}: ${reason}`);
    return { source, markdown: '', status: 'failed', error: reason };
  }
}

class SearchProviderError extends Error {}

function searchFailureReason(error: unknown): string {
  if (error instanceof SearchProviderError) return error.message;
  if (error instanceof PublicNetworkError) return '目标被公网访问安全规则拦截';
  const detail = error instanceof Error ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ''}` : '';
  if (/CERT|certificate|SSL|TLS/i.test(detail)) return 'TLS 证书校验失败，请检查网络或代理；未绕过证书校验';
  if (/timeout|timed out|aborted/i.test(detail)) return '请求超时，请检查网络或代理';
  if (/\b429\b/.test(detail)) return '搜索服务限流，请稍后重试';
  if (/\b(401|403)\b/.test(detail)) return '搜索服务拒绝访问，请检查授权或服务限制';
  if (error instanceof AggregateError) return '所有 SearXNG 实例均未返回可用结果';
  return '搜索服务请求失败，请检查网络或服务配置';
}

function formatSearchDiagnostics(outputs: SearchSourceOutput[], topic: string): string {
  return '### 搜索来源状态\n' + outputs.map(output => {
    if (output.status === 'failed') return `- ${output.source}：失败，${output.error}`;
    const candidates = parseSearchHits(output.markdown, output.source).length;
    if (!candidates) return `- ${output.source}：未取得可解析候选，可能没有匹配项或页面响应不完整`;
    const relevant = rankSearchOutputs(topic, [output], candidates).length;
    return `- ${output.source}：解析到 ${candidates} 条候选，主题过滤后保留 ${relevant} 条`;
  }).join('\n');
}

function assertBingSearchResponse(url: string, mode: 'web' | 'news', status?: number, query?: string): void {
  if (status !== undefined && status >= 400) throw new Error(`Bing HTTP ${status}`);
  const target = new URL(url);
  if (!/(^|\.)bing\.com$/.test(target.hostname) || target.pathname !== (mode === 'news' ? '/news/search' : '/search') || !target.searchParams.get('q')) {
    throw new SearchProviderError('搜索请求跳转到非搜索页面，未取得搜索结果；请检查搜索入口或网络/代理');
  }
  if (query !== undefined && target.searchParams.get('q')?.trim() !== query.trim()) {
    throw new SearchProviderError('搜索跳转改变了检索词，未将其他查询的结果用作本次材料');
  }
}

function bingSearchUrl(query: string, maxResults: number, mode: 'web' | 'news', international: boolean): string {
  const params = new URLSearchParams({ q: query });
  if (mode === 'web') {
    params.set('count', String(maxResults));
    params.set('mkt', international ? 'en-US' : 'zh-CN');
    if (international) params.set('ensearch', '1');
  }
  return `https://www.bing.com/${mode === 'news' ? 'news/search' : 'search'}?${params}`;
}

export function rankSearchOutputs(
  query: string,
  outputs: SearchSourceOutput[],
  maxResults: number,
  signal?: AbortSignal,
): ParsedSearchHit[] {
  signal?.throwIfAborted();
  const hits: ParsedSearchHit[] = [];
  const seen = new Set<string>();

  for (const output of outputs) {
    for (const hit of parseSearchHits(output.markdown, output.source)) {
      const key = normalizeSourceUrl(hit.url);
      if (!key || seen.has(key)) continue;
      if (sourceRelevance(query, `${hit.title} ${hit.snippet}`) < 0.6) continue;
      seen.add(key);
      hits.push({ ...hit, url: key });
    }
  }

  const score = (hit: ParsedSearchHit) => sourceRelevance(query, `${hit.title} ${hit.snippet}`)
    + (hit.source === 'Bing News' ? 0.25 : 0) - (new URL(hit.url).pathname === '/' ? 0.5 : 0);
  return hits.sort((a, b) => score(b) - score(a)).slice(0, maxResults);
}

function combineSearchOutputs(query: string, outputs: SearchSourceOutput[], maxResults: number, topic?: string): string | null {
  const hits = rankSearchOutputs(topic || query, outputs, maxResults);

  if (hits.length === 0) return null;

  const lines = [
    `## 聚合搜索结果: "${query}"`,
    '',
    `- 聚合来源: ${[...new Set(hits.map(hit => hit.source))].join(', ')}`,
    `- 实际查询: ${[...new Set(outputs.map(output => output.query).filter(Boolean))].join('；')}`,
    `- 去重结果数: ${hits.length}`,
    '',
  ];

  for (const hit of hits) {
    lines.push(`### ${hit.title}`);
    lines.push(`- URL: ${hit.url}`);
    lines.push(`- 来源: ${hit.source}`);
    if (hit.snippet) lines.push(`- ${hit.snippet.slice(0, 420)}`);
    if (hit.dateHint) lines.push(`- 日期线索（搜索服务，尚未核实）: ${hit.dateHint}`);
    lines.push('');
  }

  lines.push(formatSearchDiagnostics(outputs, topic || query));
  return lines.join('\n');
}

function parseSearchHits(markdown: string, source: string): ParsedSearchHit[] {
  const blocks = markdown.split(/\n(?=###\s+)/g);
  const hits: ParsedSearchHit[] = [];

  for (const block of blocks) {
    const title = block.match(/^###\s+(.+)$/m)?.[1]?.trim();
    const url =
      block.match(/-\s*URL:\s*(https?:\/\/\S+)/i)?.[1]?.trim() ||
      block.match(/URL Source:\s*(https?:\/\/\S+)/i)?.[1]?.trim() ||
      block.match(/\((https?:\/\/[^)\s]+)\)/i)?.[1]?.trim();
    if (!title || !url) continue;
    const dateHint = block.match(/^- 日期线索（搜索服务，尚未核实）: (\d{4}-\d{2}-\d{2})$/m)?.[1];
    hits.push({
      title: cleanInlineText(title),
      url: stripTrailingPunctuation(url),
      snippet: extractSnippet(block),
      source,
      ...(dateHint ? { dateHint } : {}),
    });
  }

  if (hits.length === 0 && source === 'Jina Search') {
    hits.push(...parseJinaSearchText(markdown, source));
  }

  return hits;
}

function parseJinaSearchText(text: string, source: string): ParsedSearchHit[] {
  const blocks = text.split(/\n(?=Title:\s+)/g);
  const hits: ParsedSearchHit[] = [];
  for (const block of blocks) {
    const title = block.match(/Title:\s*(.+)/i)?.[1]?.trim();
    const url =
      block.match(/URL Source:\s*(https?:\/\/\S+)/i)?.[1]?.trim() ||
      block.match(/URL:\s*(https?:\/\/\S+)/i)?.[1]?.trim();
    if (!title || !url) continue;
    hits.push({
      title: cleanInlineText(title),
      url: stripTrailingPunctuation(url),
      snippet: cleanInlineText(block.replace(/Title:\s*.+/i, '').replace(/URL Source:\s*https?:\/\/\S+/i, '').slice(0, 500)),
      source,
    });
  }
  return hits;
}

function extractSnippet(block: string): string {
  return cleanInlineText(
    block
      .split('\n')
      .map(line => line.trim())
      .find(line => line.startsWith('- ') && !line.toLowerCase().startsWith('- url:') && !line.toLowerCase().startsWith('- 来源:'))
      ?.replace(/^-\s*/, '') || '',
  );
}

function cleanInlineText(value: string): string {
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function buildFreshSearchQuery(query: string): string {
  if (!shouldPreferFreshResults(query)) return query;

  const now = getShanghaiDateParts();
  const hasCurrentYear = query.includes(String(now.year));
  const hasCurrentMonth = query.includes(`${now.month}月`) || query.includes(`${now.month} 月`);
  const hasFreshMarker = /最新|实时|近期|今日|今天|新闻|资讯|latest|recent|current|news|today/i.test(query);
  const suffixParts = [
    hasCurrentYear ? '' : `${now.year}年`,
    hasCurrentMonth ? '' : `${now.month}月`,
    hasFreshMarker ? '' : '最新',
  ].filter(Boolean);

  return `${query} ${suffixParts.join(' ')}`.trim();
}

function shouldPreferFreshResults(query: string): boolean {
  return /最新|实时|近期|当前|现在|现状|趋势|今日|今天|新闻|资讯|近\s*30\s*天|过去\s*30\s*天|近三十天|近一个月|近一月|本月|latest|recent|current|news|today|this year|last\s*30\s*days/i.test(query);
}

function shouldSearchGitHub(query: string): boolean {
  return /github|repo|repository|开源|源码|框架|skill|mcp|framework/i.test(query);
}

export function buildTopicSearchQuery(query: string, now = new Date()): string {
  // Keep the subject first; conversational prefixes and dates can dominate HTML search.
  // Search operators remain untouched so a requested domain/phrase is never broadened.
  if (/\bsite:|\bfiletype:|["“”]/i.test(query)) return query;
  const explicitDates = query.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
  const explicitDate = explicitDates.length === 1 ? new Date(`${explicitDates[0]}T00:00:00Z`) : undefined;
  if (explicitDates.length && (!explicitDate || !Number.isFinite(explicitDate.getTime())
    || explicitDate.toISOString().slice(0, 10) !== explicitDates[0])) return query;
  const translations: Record<string, string> = { 支付: 'payments', 人工智能: 'AI', 智能体: 'agent' };
  const topic = extractTopicTerms(explicitDate ? query.replace(explicitDate.toISOString().slice(0, 10), '') : query).slice(0, 6).map(term => translations[term] || term).join(' ')
    .replace(/\b(?:payments agent|agent payments)\b/g, 'agentic payments');
  if (!topic) return explicitDate ? query : '';
  if (explicitDate) return `${topic} news ${explicitDates[0]}`;
  if (!shouldPreferFreshResults(query) && !/近\s*30\s*天|last\s*30\s*days/i.test(query)) return topic;
  const date = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', timeZone: 'Asia/Shanghai' }).format(now);
  return `${topic} news ${date}`;
}

function getShanghaiDateParts(): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date());

  const get = (type: string) => Number(parts.find(part => part.type === type)?.value || '0');
  return { year: get('year'), month: get('month'), day: get('day') };
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[),.，。]+$/g, '');
}

// ─── SearXNG 并行竞速 ────────────────────────────────

const SEARXNG_INSTANCES = [
  'https://search.bus-hit.me',
  'https://searx.be',
  'https://search.ononoki.org',
  'https://search.sapti.me',
];

/** 并行请求所有 SearXNG 实例，取最快成功的结果 */
async function searchWithSearXNGRace(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const controller = new AbortController();
  const raceSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const jobs = SEARXNG_INSTANCES.map(instance => searchWithSearXNG(instance, query, maxResults, raceSignal));
  try { return await Promise.any(jobs); }
  finally { controller.abort(); await Promise.allSettled(jobs); }
}

async function searchWithSearXNG(
  baseUrl: string,
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<string> {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    categories: 'general',
    language: 'auto',
  });

  const response = await fetch(`${baseUrl}/search?${params}`, {
    headers: {
      'User-Agent': 'TAgent/0.1 (Research Assistant)',
      Accept: 'application/json',
    },
    signal: requestSignal(5000, signal), // 5 秒超时（缩短，避免阻塞）
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = (await response.json()) as {
    results?: { title: string; url: string; content: string; engine: string }[];
    answers?: string[];
  };

  if (!data.results || data.results.length === 0) {
    throw new Error('no results');
  }

  const results = data.results.slice(0, maxResults);
  let output = `## 搜索结果: "${query}"\n\n`;

  if (data.answers && data.answers.length > 0) {
    output += `### 摘要\n${data.answers[0]}\n\n`;
  }

  for (const r of results) {
    output += `### ${r.title}\n`;
    output += `- URL: ${r.url}\n`;
    if (r.content) output += `- ${r.content.slice(0, 300)}\n`;
    output += '\n';
  }

  return output;
}

// ─── Tavily ──────────────────────────────────────────

async function searchWithTavily(
  query: string,
  maxResults: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: true,
    }),
    signal: requestSignal(15000, signal),
  });

  if (!response.ok) throw new Error(`Tavily HTTP ${response.status}`);

  const data = (await response.json()) as {
    answer?: string;
    results: { title: string; url: string; content: string }[];
  };

  let output = `## 搜索结果: "${query}"\n\n`;
  if (data.answer) {
    output += `### 摘要\n${data.answer}\n\n`;
  }
  for (const r of data.results) {
    output += `### ${r.title}\n- URL: ${r.url}\n- ${r.content.slice(0, 300)}\n\n`;
  }
  return output;
}

async function searchWithJinaSearch(query: string, maxResults: number, signal?: AbortSignal): Promise<string | null> {
  const headers: Record<string, string> = {
    'User-Agent': 'TAgent/0.1 (Research Assistant)',
    Accept: 'text/plain',
  };
  if (process.env.JINA_API_KEY) {
    headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  }

  const response = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
    headers,
    signal: requestSignal(12000, signal),
  });

  if (!response.ok) throw new Error(`Jina Search HTTP ${response.status}`);
  const text = await response.text();
  if (!text.trim()) return null;

  const hits = parseJinaSearchText(text, 'Jina Search').slice(0, maxResults);
  if (hits.length === 0) return `## 搜索结果: "${query}" (Jina)\n\n${text.slice(0, 4000)}`;

  let output = `## 搜索结果: "${query}" (Jina)\n\n`;
  for (const hit of hits) {
    output += `### ${hit.title}\n- URL: ${hit.url}\n`;
    if (hit.snippet) output += `- ${hit.snippet.slice(0, 300)}\n`;
    output += '\n';
  }
  return output;
}

async function searchGitHubRepos(query: string, maxResults: number, signal?: AbortSignal): Promise<string | null> {
  const searchQuery = `${query} in:name,description,readme`;
  const params = new URLSearchParams({
    q: searchQuery,
    sort: 'updated',
    order: 'desc',
    per_page: String(Math.min(maxResults, 10)),
  });

  const headers: Record<string, string> = {
    'User-Agent': 'TAgent/0.1 (Research Assistant)',
    Accept: 'application/vnd.github+json',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(`https://api.github.com/search/repositories?${params}`, {
    headers,
    signal: requestSignal(10000, signal),
  });

  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  const data = (await response.json()) as {
    items?: Array<{
      full_name: string;
      html_url: string;
      description: string | null;
      stargazers_count: number;
      updated_at: string;
      language: string | null;
    }>;
  };

  if (!data.items?.length) return null;
  let output = `## GitHub 仓库搜索结果: "${query}"\n\n`;
  for (const item of data.items.slice(0, maxResults)) {
    output += `### ${item.full_name}\n`;
    output += `- URL: ${item.html_url}\n`;
    output += `- ${item.description || 'No description'}\n`;
    output += `- Stars: ${item.stargazers_count}; Language: ${item.language || 'unknown'}; Updated: ${item.updated_at}\n\n`;
  }
  return output;
}

// ─── Bing HTML candidates; availability depends on the public service ───

// ─── Playwright 浏览器搜索 (Agent-Browser 方案) ──────

async function searchWithPlaywright(query: string, maxResults: number, mode: 'web' | 'news' = 'web', signal?: AbortSignal, international = false): Promise<string | null> {
  const { ctx, page } = await newBrowserPage(undefined, signal);
  try {
    const url = bingSearchUrl(query, maxResults, mode, international);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    assertBingSearchResponse(page.url(), mode, response?.status(), query);
    if (mode === 'news') {
      await page.waitForSelector('a.title[data-author]', { timeout: 5000 }).catch(() => {});
      const hits = parseBingNewsResults(await page.content()).slice(0, maxResults);
      return hits.length ? hits.map(hit => `### ${hit.title}\n- URL: ${hit.url}\n- ${hit.snippet}\n`).join('\n') : null;
    }
    await page.waitForSelector('#b_results, .b_algo', { timeout: 8000 }).catch(() => {});

    const results = parseBingResults(await page.content()).slice(0, maxResults);

    if (results.length === 0) return null;
    let output = `## 浏览器搜索结果: "${query}" (Playwright)\n\n`;
    for (const r of results) {
      output += `### ${r.title}\n- URL: ${r.url}\n`;
      if (r.snippet) output += `- ${r.snippet}\n`;
      output += '\n';
    }
    return output;
  } finally {
    await ctx.close();
  }
}

// ─── HTTP Bing (快速 fallback) ─────────────────────

async function searchWithBingHTTP(query: string, maxResults: number, signal?: AbortSignal, international = false): Promise<string | null> {
  const response = await fetch(bingSearchUrl(query, maxResults, 'web', international), {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': international ? 'en-US,en;q=0.9,zh;q=0.8' : 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: requestSignal(10000, signal),
  });

  if (!response.ok) throw new Error(`Bing HTTP ${response.status}`);
  assertBingSearchResponse(response.url, 'web', response.status, query);

  const results = parseBingResults(await response.text()).slice(0, maxResults);

  if (results.length === 0) {
    return null; // 让调用方 fallback 到 SearXNG
  }

  let output = `## 搜索结果: "${query}" (Bing)\n\n`;
  for (const r of results) {
    output += `### ${r.title}\n`;
    output += `- URL: ${r.url}\n`;
    if (r.snippet) output += `- ${r.snippet}\n`;
    output += '\n';
  }

  return output;
}

export function parseBingResults(html: string): ParsedSearchHit[] {
  const $ = load(html);
  return $('.b_algo').toArray().flatMap(element => {
    const link = $(element).find('h2 a').first();
    const title = link.text().trim();
    const url = normalizeSourceUrl(link.attr('href') || '');
    const snippet = $(element).find('.b_caption p, .b_lineclamp2, p').first().text().trim();
    return title && url ? [{ title, url, snippet, source: 'Bing HTTP' }] : [];
  });
}

export function parseBingNewsResults(html: string): ParsedSearchHit[] {
  const $ = load(html);
  return $('a.title[data-author]').toArray().flatMap(element => {
    const link = $(element);
    const url = normalizeSourceUrl(link.attr('href') || '');
    const title = link.text().trim();
    if (!url || !title || /(^|\.)bing\.com$/.test(new URL(url).hostname)) return [];
    const snippet = link.parent().parent().find('.snippet').first().text().trim();
    return [{ title, url, snippet, source: 'Bing News' }];
  });
}
