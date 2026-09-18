import { requestSignal } from '../run-control.js';
import { researchWindowStart, requestsSameDayResearch } from '../research-window.js';
export { requiresRecentWindow } from '../research-window.js';
/**
 * Web Research Tool
 *
 * One bounded research action:
 * search -> open the top sources -> extract readable text -> return a compact evidence pack.
 *
 * This keeps browser automation inside a predictable tool boundary. The agent gets better
 * source material without manually looping through search, navigation, and extraction steps.
 */

import type { ToolExecutor, ToolExecutionContext } from './registry.js';
import type { ResearchSearchSelection } from '../search-settings.js';
import { createWebSearchTool } from './web-search.js';
import { newBrowserPage } from './browser-pool.js';
import { assertPublicUrl, publicFetch as fetch, PublicNetworkError } from '../public-network.js';
import { resolvedPageUrl } from './browser-network.js';
import { evidencePassages, normalizeSourceUrl, publisherKind, publisherSite, selectCitationCandidates, extractPageEvidence, formatSourceReferences, makeResearchSource, researchSourceConstraints, sourceRelevance, type PublicationEvidence, type ResearchSource, type SourceReference } from '../research-evidence.js';

interface SourceMaterial {
  title: string;
  url: string;
  snippet?: string;
  text: string;
  method: 'fetch' | 'playwright';
  error?: string;
  publication?: PublicationEvidence;
  references?: SourceReference[];
  passages?: string[];
  discoveredFrom?: string;
  requestedUrls?: string[];
}

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_MAX_CHARS_PER_PAGE = 2400;
const MIN_USEFUL_TEXT_LENGTH = 500;

export interface ResearchDateContext {
  isoDate: string;
  year: number;
  month: number;
  day: number;
}

export interface SourceDateEvidence {
  label: string;
  confidence: 'none' | 'year' | 'month' | 'day';
  evidence?: string;
}

export function createWebResearchTool(options?: { allowedDomains?: string[]; now?: Date; topic?: string; searchSessionId?: string;
  searchProvider?: ResearchSearchSelection; onSources?: (sources: ResearchSource[]) => void }): ToolExecutor {
  const searchTool = createWebSearchTool({ topic: options?.topic, searchSessionId: options?.searchSessionId, searchProvider: options?.searchProvider });
  return {
    definition: {
      name: 'web_research',
      description:
        '对一个问题执行一次受控联网调研：搜索、读取前几个公开来源、抽取正文，并返回带来源的结构化材料包。适合调研、现状分析、竞品分析和需要最新公开信息的问题。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '调研问题或搜索关键词',
          },
          maxResults: {
            type: 'number',
            description: '搜索结果数量，默认 5',
          },
          maxPages: {
            type: 'number',
            description: '返回的来源材料数量，默认 3，最多 5；含失败替补和原文追溯在内最多尝试读取 8 个页面',
          },
          maxCharsPerPage: {
            type: 'number',
            description: '每个来源最多返回字符数，默认 2400',
          },
        },
        required: ['query'],
      },
    },

    async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
      const signal = context?.signal;
      signal?.throwIfAborted();
      const query = normalizeString(args.query);
      if (!query) return 'web_research 需要 query 参数。';

      const maxResults = clampNumber(args.maxResults, DEFAULT_MAX_RESULTS, 1, 8);
      const maxPages = clampNumber(args.maxPages, DEFAULT_MAX_PAGES, 1, 5);
      const maxCharsPerPage = clampNumber(
        args.maxCharsPerPage,
        DEFAULT_MAX_CHARS_PER_PAGE,
        800,
        5000,
      );

      const dateContext = getResearchDateContext(options?.now);
      const topic = options?.topic || query;
      const dateRequirement = { researchDate: dateContext.isoDate,
        windowStart: researchWindowStart(dateContext.isoDate, topic) };
      const recordSource = (item: SourceMaterial): ResearchSource => makeResearchSource({
        url: item.url, title: item.title, query, retrievedAt: dateContext.isoDate,
        publication: item.publication || { basis: 'unknown' }, readable: isReadableMaterial(item),
        relevant: sourceRelevance(topic, item.passages?.join('\n') || item.text) >= 0.6,
        excerpt: item.text.slice(0, 2400), references: item.references, passages: item.passages, discoveredFrom: item.discoveredFrom,
        requestedUrls: item.requestedUrls,
      });
      const isUsableMaterial = (item: SourceMaterial) => !researchSourceConstraints(recordSource(item), dateRequirement)
        .some(issue => issue.scope === 'any' || !!dateRequirement.windowStart);
      const searchQuery = buildFreshResearchQuery(query, dateContext, topic);
      const searchOutput = await searchTool.execute({ query: searchQuery, maxResults }, context);
      signal?.throwIfAborted();
      const seenSites = new Set<string>();
      const candidates = parseSearchResults(searchOutput)
        .filter(item => isUrlAllowed(item.url, options?.allowedDomains).allowed)
        .map(item => {
          const site = publisherSite(item.url);
          const repeated = seenSites.has(site);
          seenSites.add(site);
          return { ...item, repeated };
        }).sort((a, b) => Number(a.repeated) - Number(b.repeated))
        .slice(0, maxResults);

      if (candidates.length === 0) {
        return [
          `# Web Research: ${query}`,
          '',
          `- 当前日期: ${dateContext.isoDate}`,
          ...(dateRequirement.windowStart ? [`- 核验窗口: ${dateRequirement.windowStart} 至 ${dateContext.isoDate}（北京时间）`] : []),
          `- 实际检索词: ${searchQuery}`,
          '',
          '## 搜索结果',
          searchOutput,
          '',
          '## 状态',
          '没有找到可读取的公开来源。请尝试更具体的关键词，或配置 Tavily / 可用搜索源。',
        ].join('\n');
      }

      const checkedMaterials: SourceMaterial[] = [];
      const attempted = new Set<string>();
      const depths = new Map<string, number>();
      const maxReads = Math.min(8, maxResults + 2);
      const maxCitationReads = Math.min(4, maxPages * 2);
      let reads = 0;
      let citationReads = 0;
      const readBatch = async (items: Array<Pick<SourceMaterial, 'url' | 'title' | 'snippet' | 'discoveredFrom'> & { depth: number }>) => {
        const batch = await Promise.all(items.flatMap(item => {
          const key = normalizeSourceUrl(item.url);
          if (!key || attempted.has(key) || reads >= maxReads) return [];
          attempted.add(key);
          reads++;
          if (item.depth > 0) citationReads++;
          return [readSource({ ...item, url: key }, maxCharsPerPage, options?.allowedDomains, signal).then(material => {
            const finalKey = normalizeSourceUrl(material.url);
            attempted.add(finalKey);
            depths.set(finalKey, Math.min(depths.get(finalKey) ?? item.depth, item.depth));
            return { ...material, url: finalKey, discoveredFrom: item.discoveredFrom, requestedUrls: [key] };
          })];
        }));
        for (const material of batch) {
          const index = checkedMaterials.findIndex(previous => normalizeSourceUrl(previous.url) === normalizeSourceUrl(material.url));
          const previous = checkedMaterials[index];
          // Multiple aliases may finish concurrently. Keep one actual page and
          // its request provenance, without letting a failed reread erase good material.
          const selected = previous && isReadableMaterial(previous) && !isReadableMaterial(material) ? previous : material;
          const merged = { ...selected, discoveredFrom: selected.discoveredFrom || previous?.discoveredFrom || material.discoveredFrom,
            requestedUrls: [...new Set([...(previous?.requestedUrls || []), ...(material.requestedUrls || [])])] };
          if (index < 0) checkedMaterials.push(merged);
          else checkedMaterials[index] = merged;
        }
        options?.onSources?.(batch.map(recordSource));
        signal?.throwIfAborted();
      };
      // Search pages and observed citations share one read budget. Follow at most
      // two citation levels, including links found in later search batches.
      let index = 0;
      while (reads < maxReads) {
        if (checkedMaterials.filter(isUsableMaterial).length < maxPages && index < candidates.length) {
          await readBatch(candidates.slice(index, index + 2).map(candidate => ({ ...candidate, depth: 0 })));
          index += 2;
        }
        if (citationReads < maxCitationReads && reads < maxReads) {
          const parents = checkedMaterials.filter(item => isReadableMaterial(item) && recordSource(item).relevant
            && (depths.get(normalizeSourceUrl(item.url)) ?? 0) < 2);
          const citations = selectCitationCandidates(parents, topic, attempted, parents.length * 40)
            .filter(item => isUrlAllowed(item.url, options?.allowedDomains).allowed)
            .slice(0, Math.min(2, maxCitationReads - citationReads, maxReads - reads));
          if (citations.length) {
            await readBatch(citations.map(citation => ({ ...citation,
              depth: (depths.get(normalizeSourceUrl(citation.discoveredFrom)) ?? 0) + 1 })));
            continue;
          }
        }
        signal?.throwIfAborted();
        if (checkedMaterials.filter(isUsableMaterial).length >= maxPages) break;
        if (index >= candidates.length) break;
      }

      const readableMaterials = checkedMaterials.filter(isReadableMaterial)
        .sort((a, b) => Number(isUsableMaterial(b)) - Number(isUsableMaterial(a))
          || Number(publisherKind(b.url) === 'primary') - Number(publisherKind(a.url) === 'primary')
          || Number(!!b.discoveredFrom) - Number(!!a.discoveredFrom)).slice(0, maxPages);
      const failedMaterials = checkedMaterials.filter(item => !isReadableMaterial(item));
      const materials = [
        ...readableMaterials,
        ...failedMaterials.slice(0, Math.max(0, maxPages - readableMaterials.length)),
      ];

      return formatResearchPack(query, searchQuery, dateContext.isoDate, searchOutput, materials, checkedMaterials.map(recordSource), dateRequirement.windowStart);
    },
  };
}

export function buildFreshResearchQuery(query: string, dateContext: Pick<ResearchDateContext, 'year' | 'month'> & Partial<Pick<ResearchDateContext, 'isoDate'>>, originalTask = query): string {
  if (!shouldPreferFreshResearch(query) && !shouldPreferFreshResearch(originalTask)) return query;

  const hasCurrentYear = query.includes(String(dateContext.year));
  const hasCurrentMonth = query.includes(`${dateContext.month}月`) || query.includes(`${dateContext.month} 月`);
  const hasFreshMarker = /最新|实时|近期|近\s*30\s*天|近三十天|过去\s*30\s*天|近一个月|近一月|本月|今日|今天|新闻|资讯|趋势|现状|latest|recent|current|news|today|last\s*30\s*days/i.test(query);
  const suffixParts = [
    hasCurrentYear ? '' : `${dateContext.year}年`,
    hasCurrentMonth ? '' : `${dateContext.month}月`,
    hasFreshMarker ? '' : '最新',
    requestsSameDayResearch(originalTask) && dateContext.isoDate && !query.includes(dateContext.isoDate) ? dateContext.isoDate : '',
  ].filter(Boolean);

  return `${query} ${suffixParts.join(' ')}`.trim();
}

export function shouldPreferFreshResearch(query: string): boolean {
  return /最新|实时|近期|近\s*30\s*天|近三十天|过去\s*30\s*天|近一个月|近一月|本月|当前|现在|现状|趋势|今日|今天|新闻|资讯|latest|recent|current|news|today|this year|last\s*30\s*days/i.test(query);
}

export function getResearchDateContext(now = new Date()): ResearchDateContext {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const get = (type: string) => parts.find(part => part.type === type)?.value || '00';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  return {
    isoDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    year,
    month,
    day,
  };
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseSearchResults(markdown: string): { title: string; url: string; snippet?: string }[] {
  const results: { title: string; url: string; snippet?: string }[] = [];
  const blocks = markdown.split(/\n(?=###\s+)/g);

  for (const block of blocks) {
    const title = block.match(/^###\s+(.+)$/m)?.[1]?.trim() || 'Untitled';
    const url =
      block.match(/-\s*URL:\s*(https?:\/\/\S+)/i)?.[1]?.trim() ||
      block.match(/\((https?:\/\/[^)\s]+)\)/i)?.[1]?.trim();

    if (!url) continue;
    const cleanedUrl = stripTrailingPunctuation(url);
    if (!isHttpUrl(cleanedUrl)) continue;

    const snippet = block
      .split('\n')
      .map(line => line.trim())
      .find(line => line.startsWith('- ') && !/^-(?:\s*)(?:url|来源):/i.test(line))
      ?.replace(/^-\s*/, '')
      .slice(0, 500);

    if (!results.some(item => item.url === cleanedUrl)) {
      results.push({ title, url: cleanedUrl, snippet });
    }
  }

  return results;
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[),.，。]+$/g, '');
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isUrlAllowed(url: string, allowedDomains?: string[]): { allowed: boolean; reason?: string } {
  try {
    assertPublicUrl(url, allowedDomains);
    return { allowed: true };
  } catch (error) {
    return { allowed: false, reason: error instanceof Error ? error.message : '无效地址' };
  }
}

async function readSource(
  candidate: { title: string; url: string; snippet?: string },
  maxChars: number,
  allowedDomains?: string[],
  signal?: AbortSignal,
): Promise<SourceMaterial> {
  let blocked = false;
  const fetchResult = await readWithFetch(candidate, maxChars, allowedDomains, signal).catch(error => {
    blocked = error instanceof PublicNetworkError;
    return {
      ...candidate,
      text: '',
      method: 'fetch' as const,
      error: error instanceof Error ? error.message : String(error),
    };
  });

  if (blocked || signal?.aborted) return fetchResult;

  if (isReadableMaterial(fetchResult) && fetchResult.text.length >= MIN_USEFUL_TEXT_LENGTH) return fetchResult;

  const jinaResult = process.env.JINA_API_KEY ? await readWithJinaReader(candidate, maxChars, signal).catch(error => ({
    ...candidate,
    text: fetchResult.text,
    method: 'fetch' as const,
    error: error instanceof Error ? error.message : String(error),
  })) : fetchResult;

  if (signal?.aborted) return jinaResult;
  if (isReadableMaterial(jinaResult) && jinaResult.text.length >= MIN_USEFUL_TEXT_LENGTH) return jinaResult;

  const browserResult = await readWithPlaywright(candidate, maxChars, allowedDomains, signal).catch(error => ({
    ...candidate,
    text: jinaResult.text.length > fetchResult.text.length ? jinaResult.text : fetchResult.text,
    method: 'playwright' as const,
    error: error instanceof Error ? error.message : String(error),
  }));

  const best = [fetchResult, jinaResult, browserResult]
    .sort((a, b) => Number(isReadableMaterial(b)) - Number(isReadableMaterial(a)) || b.text.length - a.text.length)[0];
  return normalizeMaterialQuality(best);
}

async function readWithFetch(
  candidate: { title: string; url: string; snippet?: string },
  maxChars: number,
  allowedDomains?: string[],
  signal?: AbortSignal,
): Promise<SourceMaterial> {
  const response = await fetch(candidate.url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 TAgent/0.1',
      Accept: 'text/html,application/xhtml+xml,text/plain',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: requestSignal(10000, signal),
    allowedDomains,
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/') && !contentType.includes('html')) {
    throw new Error(`unsupported content-type: ${contentType || 'unknown'}`);
  }

  const html = Buffer.from(await response.arrayBuffer());
  const evidence = extractPageEvidence(html, response.url || candidate.url, contentType);
  return { ...candidate, url: response.url || candidate.url, title: evidence.title || candidate.title, text: truncate(evidence.text, maxChars),
    publication: evidence.publication, references: evidence.references, passages: evidencePassages(evidence.text, `${candidate.title} ${candidate.snippet || ''}`), method: 'fetch' };
}

async function readWithJinaReader(
  candidate: { title: string; url: string; snippet?: string },
  maxChars: number,
  signal?: AbortSignal,
): Promise<SourceMaterial> {
  const headers: Record<string, string> = {
    'User-Agent': 'TAgent/0.1 (Research Assistant)',
    Accept: 'text/plain',
  };
  if (process.env.JINA_API_KEY) {
    headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  }

  const response = await fetch(`https://r.jina.ai/${candidate.url}`, {
    headers,
    signal: requestSignal(12000, signal),
  });

  if (!response.ok) throw new Error(`Jina Reader HTTP ${response.status}`);
  const text = await response.text();
  const title = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || candidate.title;
  return {
    ...candidate,
    title,
    text: truncate(cleanText(text), maxChars),
    method: 'fetch',
  };
}

async function readWithPlaywright(
  candidate: { title: string; url: string; snippet?: string },
  maxChars: number,
  allowedDomains?: string[],
  signal?: AbortSignal,
): Promise<SourceMaterial> {
  const { ctx, page } = await newBrowserPage(allowedDomains, signal);
  try {
    const response = await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (!response) throw new Error('浏览器未返回页面响应');
    if (response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const finalUrl = resolvedPageUrl(page);
    const data = extractPageEvidence(await page.content(), finalUrl);
    return {
      ...candidate,
      url: finalUrl,
      title: data.title || candidate.title,
      text: truncate(data.text, maxChars),
      publication: data.publication,
      references: data.references,
      passages: evidencePassages(data.text, `${candidate.title} ${candidate.snippet || ''}`),
      method: 'playwright',
    };
  } finally {
    await ctx.close();
  }
}

function cleanText(text: string): string {
  return text
    .replace(/\r/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeMaterialQuality(material: SourceMaterial): SourceMaterial {
  const text = material.text.trim();
  if (!text) return { ...material, text: '', error: material.error || '没有抽取到正文' };

  if (looksLikeVerificationPage(text)) {
    return { ...material, text: '', error: '页面需要验证或存在反爬拦截' };
  }

  if (text.length < 160) {
    return { ...material, text: '', error: `正文过短，仅 ${text.length} 字符` };
  }

  return material;
}

export function isReadableMaterial(material: Pick<SourceMaterial, 'text'>): boolean {
  return material.text.trim().length >= 160 && !looksLikeVerificationPage(material.text);
}

export function inferSourceDateEvidence(material: Pick<SourceMaterial, 'url' | 'snippet' | 'text' | 'title' | 'publication'>): SourceDateEvidence {
  if (material.publication?.basis === 'publication_metadata' && material.publication.date) {
    return { label: `${material.publication.date}（发布元数据）`, confidence: 'day', evidence: material.publication.raw };
  }
  // Legacy date hints remain labeled as hints, never proof of publication.
  const searchable = material.url;

  const fullDate = searchable.match(/\b(20\d{2})[-/.年](0?[1-9]|1[0-2])[-/.月](0?[1-9]|[12]\d|3[01])日?\b/);
  if (fullDate) {
    const [, year, month, day] = fullDate;
    return {
      label: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
      confidence: 'day',
      evidence: fullDate[0],
    };
  }

  const monthDate = searchable.match(/\b(20\d{2})[-/.年](0?[1-9]|1[0-2])月?\b/);
  if (monthDate) {
    const [, year, month] = monthDate;
    return {
      label: `${year}-${month.padStart(2, '0')}`,
      confidence: 'month',
      evidence: monthDate[0],
    };
  }

  const yearDate = searchable.match(/\b(20\d{2})\b/);
  if (yearDate) {
    return {
      label: yearDate[1],
      confidence: 'year',
      evidence: yearDate[0],
    };
  }

  return {
    label: '未发现明确日期',
    confidence: 'none',
  };
}

export function describeSourceVerifiability(material: SourceMaterial): string {
  if (!isReadableMaterial(material)) return '低：未读取到可用正文';
  if (material.publication?.basis === 'publication_metadata') return '正文及发布元数据已读取；事实和发布者身份仍需核对';
  return '正文已读取，但发布日期未核实；不得称为最新或仅据此认定权威';
}

function looksLikeVerificationPage(text: string): boolean {
  const normalized = text.toLowerCase().trim().slice(0, 350);
  if (/^(?:access denied\s*)?you (?:don't|do not) have permission to access\s+["“]?https?:\/\//i.test(normalized)) return true;
  if (/^(?:access denied|访问被拒绝|访问受限)\s*(?:\n|$)/i.test(normalized)) return true;
  if (/^请稍候[.…。\s]*[\s\S]*(?:验证|安全检查|浏览器|连接)/.test(normalized)) return true;
  return [
    '访问异常',
    '请完成下方验证',
    '拖动左侧滑块',
    'complete the captcha',
    'verify you are human',
    'checking your browser',
    'just a moment',
    'enable javascript and cookies',
  ].some(marker => normalized.includes(marker.toLowerCase()));
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[内容已截断，共 ${text.length} 字符]`;
}

function formatResearchPack(
  query: string,
  searchQuery: string,
  currentDate: string,
  searchOutput: string,
  materials: SourceMaterial[],
  sources: ResearchSource[],
  windowStart?: string,
): string {
  const readable = materials.filter(item => item.text.trim().length > 0);
  const lines: string[] = [
    `# Web Research: ${query}`,
    '',
    '## 调研上下文',
    `- 当前日期: ${currentDate}`,
    ...(windowStart ? [`- 核验窗口: ${windowStart} 至 ${currentDate}（北京时间）；发布时间落在窗口内仍不等于事件发生于窗口内。`] : []),
    `- 实际检索词: ${searchQuery}`,
    '- 新鲜度规则: 仅发布元数据可以确认发布日期；URL/正文中的年份、页脚版权、更新日期均不是发布证明。无日期或旧来源只能作为背景，不得称为最新。',
    '- 发布者规则: 能读取正文或发现日期不等于官方来源。第三方导航站、镜像、百科不得写成厂商官网。',
    '',
    '## 读取状态',
    `- 搜索结果数: ${parseSearchResults(searchOutput).length}`,
    `- 已读取来源: ${readable.length}/${materials.length}`,
    `- 抽取方式: ${materials.map(item => `${hostOf(item.url)}=${item.method}`).join(', ')}`,
    '',
    '## 关键来源',
    '| 来源 | 链接 | 来源日期线索 | 内容状态 | 可验证性 |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const item of materials) {
    const status = item.text ? `${item.text.length} 字符` : item.error || '读取失败';
    const date = inferSourceDateEvidence(item);
    lines.push(`| ${escapeTable(item.title)} | ${item.url} | ${escapeTable(date.label)} | ${escapeTable(status)} | ${escapeTable(describeSourceVerifiability(item))} |`);
  }

  lines.push('', '## 来源材料');
  materials.forEach((item, index) => {
    lines.push('', `### ${index + 1}. ${item.title}`, `- URL: ${item.url}`);
    const date = inferSourceDateEvidence(item);
    lines.push(`- 来源日期线索: ${date.label}${date.evidence ? `（证据: ${date.evidence}）` : ''}`);
    lines.push(`- 可验证性: ${describeSourceVerifiability(item)}`);
    const source = sources.find(candidate => normalizeSourceUrl(candidate.url) === normalizeSourceUrl(item.url));
    if (source) {
      for (const constraint of researchSourceConstraints(source, { researchDate: currentDate, windowStart })) {
        lines.push(`- 使用限制: ${constraint.reason}。${constraint.remediation}`);
      }
    }
    if (item.snippet) lines.push(`- 搜索摘要: ${item.snippet}`);
    if (item.error && !item.text) lines.push(`- 读取失败: ${item.error}`);
    if (item.text) lines.push('', item.text);
    if (item.text) lines.push(formatSourceReferences(item.references, sources));
  });

  lines.push(
    '',
    '## 给 Agent 的使用建议',
    '- 基于上面的来源材料回答用户问题。',
    '- 明确区分事实、推断和不确定信息。',
    '- 最终报告必须写明调研日期、来源日期线索、来源 URL 和可验证性；没有日期线索的来源不得被描述为最新。',
    '- 结论中保留关键来源 URL，避免编造未读取到的信息。',
    '- 优先读取相关正文引用的原始公告或文章，再核对其日期和具体事实；不要为了重复找同一新闻标题而重新搜索。引用链接尚未验证，仍须遵守 URL 和工具权限。',
  );

  return lines.join('\n');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160);
}
