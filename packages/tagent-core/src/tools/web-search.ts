/**
 * Web Search Tool — 网络搜索
 *
 * 搜索策略（按优先级）：
 * 1. Tavily API（最佳效果，需要 TAVILY_API_KEY）
 * 2. SearXNG 公共实例（免费，无需 key，国内可用）
 * 3. Bing 搜索抓取（最终 fallback）
 *
 * 注意：DuckDuckGo 在国内无法访问，已移除。
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

      // 1. Tavily (最佳)
      const tavilyKey = process.env.TAVILY_API_KEY;
      if (tavilyKey) {
        try {
          return await searchWithTavily(query, maxResults, tavilyKey);
        } catch (e) {
          console.warn('[web_search] Tavily failed:', (e as Error).message);
        }
      }

      // 2. SearXNG 公共实例 (免费，国内可达)
      for (const instance of SEARXNG_INSTANCES) {
        try {
          const result = await searchWithSearXNG(instance, query, maxResults);
          if (result) return result;
        } catch (e) {
          console.warn(`[web_search] SearXNG ${instance} failed:`, (e as Error).message);
        }
      }

      // 3. Bing 抓取 (最终 fallback)
      try {
        return await searchWithBing(query, maxResults);
      } catch (e) {
        console.warn('[web_search] Bing failed:', (e as Error).message);
      }

      return `搜索暂时不可用。\n\n建议：设置 TAVILY_API_KEY 环境变量（https://tavily.com 免费注册，每月 1000 次）。`;
    },
  };
}

// ─── SearXNG 公共实例 ────────────────────────────────

const SEARXNG_INSTANCES = [
  'https://search.bus-hit.me',
  'https://searx.be',
  'https://search.ononoki.org',
  'https://search.sapti.me',
];

async function searchWithSearXNG(
  baseUrl: string,
  query: string,
  maxResults: number,
): Promise<string | null> {
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
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    results?: { title: string; url: string; content: string; engine: string }[];
    answers?: string[];
  };

  if (!data.results || data.results.length === 0) return null;

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

// ─── Bing 抓取 (最终 fallback) ───────────────────────

async function searchWithBing(query: string, maxResults: number): Promise<string> {
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
    return `未找到关于 "${query}" 的搜索结果。\n\n建议：设置 TAVILY_API_KEY 环境变量（https://tavily.com 免费注册）。`;
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
