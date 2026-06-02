/**
 * Web Search Tool — 网络搜索
 *
 * 搜索策略（按优先级）：
 * 1. Tavily API（最佳效果，需要 TAVILY_API_KEY）
 * 2. Bing 搜索抓取（国内稳定可达，主力方案）
 * 3. SearXNG 公共实例（并行竞速 + 快速超时）
 *
 * 设计决策：
 * - Bing 提升为 #2（国内稳定 200ms 响应）
 * - SearXNG 降为 #3（公共实例不稳定，经常 403/超时）
 * - SearXNG 改为并行竞速（Promise.any）而非串行重试
 * - 超时缩短为 5 秒，避免阻塞 Agent 迭代
 */

import type { ToolExecutor } from './registry.js';

export function createWebSearchTool(): ToolExecutor {
  return {
    definition: {
      name: 'web_search',
      description: '搜索互联网获取最新信息。适合调研、了解现状、查找资料。',
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

    async execute(args: Record<string, unknown>): Promise<string> {
      const query = args.query as string;
      const maxResults = (args.maxResults as number) || 5;

      // 1. Tavily (最佳 — 需要 API key)
      const tavilyKey = process.env.TAVILY_API_KEY;
      if (tavilyKey) {
        try {
          return await searchWithTavily(query, maxResults, tavilyKey);
        } catch (e) {
          console.warn('[web_search] Tavily failed:', (e as Error).message);
        }
      }

      // 2. Bing 抓取（国内稳定可达，主力方案）
      try {
        const bingResult = await searchWithBing(query, maxResults);
        if (bingResult) return bingResult;
      } catch (e) {
        console.warn('[web_search] Bing failed:', (e as Error).message);
      }

      // 3. SearXNG 并行竞速（任意一个成功即返回）
      try {
        const searxResult = await searchWithSearXNGRace(query, maxResults);
        if (searxResult) return searxResult;
      } catch (e) {
        console.warn('[web_search] SearXNG all failed:', (e as Error).message);
      }

      return `搜索暂时不可用。\n\n建议：设置 TAVILY_API_KEY 环境变量（https://tavily.com 免费注册，每月 1000 次）。`;
    },
  };
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
): Promise<string | null> {
  try {
    return await Promise.any(
      SEARXNG_INSTANCES.map(instance =>
        searchWithSearXNG(instance, query, maxResults),
      ),
    );
  } catch {
    // AggregateError: all promises rejected
    return null;
  }
}

async function searchWithSearXNG(
  baseUrl: string,
  query: string,
  maxResults: number,
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
    signal: AbortSignal.timeout(5000), // 5 秒超时（缩短，避免阻塞）
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
    signal: AbortSignal.timeout(15000),
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

// ─── Bing 抓取 (国内稳定主力) ────────────────────────

async function searchWithBing(query: string, maxResults: number): Promise<string | null> {
  const encoded = encodeURIComponent(query);
  const response = await fetch(`https://www.bing.com/search?q=${encoded}&count=${maxResults}&mkt=zh-CN`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) throw new Error(`Bing HTTP ${response.status}`);

  const html = await response.text();

  // Extract Bing search results — <li class="b_algo" ...> blocks
  const results: { title: string; url: string; snippet: string }[] = [];

  // Match each b_algo list item (flexible: class may have extra attributes)
  const blockRegex = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
    const block = blockMatch[1];

    // Title: first <a> with href inside <h2>
    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;

    const url = titleMatch[1];
    const title = titleMatch[2].replace(/<[^>]+>/g, '').trim();

    // Snippet: content in .b_caption or <p> after title
    const snippetMatch = block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch
      ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim()
      : '';

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

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
