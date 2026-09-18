import type { MCPRegistry, SkillsRegistry, DiscoveryDomain, DiscoveryProviderState, DiscoveryProviderStatus, DiscoverySearchResult, DiscoverySearchResponse } from '@tagent/core';
import { publicFetch as fetch, redactMCPConfig, assertPublicUrl } from '@tagent/core';
import { githubClient, GitHubRequestError } from './github-client.js';

type ProviderResult = { candidates: DiscoverySearchResult[]; cache?: DiscoveryProviderStatus['cache']; checkedAt?: number };

type SearchContext = {
  domain: DiscoveryDomain;
  query: string;
  skillsRegistry: SkillsRegistry;
  mcpRegistry: MCPRegistry;
};

const githubToken = () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

type CuratedSource = DiscoverySearchResult & {
  domains: DiscoveryDomain[];
  keywords: string[];
};

const CURATED_SOURCES: CuratedSource[] = [
  {
    source: 'curated',
    providerId: 'curated',
    name: 'Jesseovo/last30days-skill-cn',
    description: '中文近 30 天信息检索 Skill，可作为 TAgent 调研新鲜度策略的导入参考。',
    url: 'https://github.com/Jesseovo/last30days-skill-cn',
    category: 'research',
    riskLevel: 'low',
    evidence: 'curated-source',
    domains: ['skill'],
    keywords: ['last30days', '近 30 天', '最新', '新闻', '调研', 'research', 'agent', 'search'],
  },
  {
    source: 'curated',
    providerId: 'curated',
    name: 'mvanhorn/last30days-skill',
    description: '近 30 天英文检索 Skill，可用于对照 TAgent 的最新信息识别与来源日期要求。',
    url: 'https://github.com/mvanhorn/last30days-skill',
    category: 'research',
    riskLevel: 'low',
    evidence: 'curated-source',
    domains: ['skill'],
    keywords: ['last30days', 'latest', 'recent', 'research', 'agent', 'search', '近 30 天'],
  },
  {
    source: 'curated',
    providerId: 'curated',
    name: 'Panniantong/Agent-Reach',
    description: 'Agent 搜索与触达方案参考，适合作为浏览/搜索增强 Skill 的设计来源。',
    url: 'https://github.com/Panniantong/Agent-Reach',
    category: 'browser-research',
    riskLevel: 'medium',
    evidence: 'curated-source',
    domains: ['skill'],
    keywords: ['agent reach', 'agent', 'search', 'browser', 'research', '调研', '搜索'],
  },
  {
    source: 'curated',
    providerId: 'curated',
    name: 'openclaw/openclaw',
    description: '浏览器 Agent 工作流参考。TAgent 只把它作为设计参考，不直接执行外部脚本。',
    url: 'https://github.com/openclaw/openclaw',
    category: 'browser-agent',
    riskLevel: 'medium',
    evidence: 'curated-source',
    domains: ['skill'],
    keywords: ['openclaw', 'browser', 'agent', 'playwright', 'search', '浏览器'],
  },
  {
    source: 'curated',
    providerId: 'curated',
    name: 'NousResearch/hermes-agent',
    description: 'Hermes Agent 浏览器/工具使用参考。适合进入导入预览后抽取 SOP，不会静默安装。',
    url: 'https://github.com/NousResearch/hermes-agent',
    category: 'browser-agent',
    riskLevel: 'medium',
    evidence: 'curated-source',
    domains: ['skill'],
    keywords: ['hermes', 'browser', 'agent', 'tool use', 'search', 'playwright'],
  },
  {
    source: 'curated',
    providerId: 'curated',
    name: 'D4Vinci/Scrapling',
    description: '网页抓取工具参考，可作为爬虫型 Skill 或 MCP 候选来源进入预览。',
    url: 'https://github.com/D4Vinci/Scrapling',
    category: 'crawler',
    riskLevel: 'medium',
    evidence: 'curated-source',
    domains: ['skill', 'mcp'],
    keywords: ['scrapling', 'crawler', 'scrape', 'web', 'browser', '爬虫', '抓取'],
  },
  {
    source: 'curated',
    providerId: 'curated',
    name: 'modelcontextprotocol/servers',
    description: 'MCP 官方参考服务器仓库，适合查找 filesystem、github、postgres 等 MCP Server。',
    url: 'https://github.com/modelcontextprotocol/servers',
    category: 'mcp-reference',
    riskLevel: 'low',
    evidence: 'curated-source',
    domains: ['mcp'],
    keywords: ['mcp', 'modelcontextprotocol', 'server', 'servers', 'filesystem', 'github', 'postgres', 'sqlite'],
  },
  {
    source: 'curated',
    providerId: 'curated',
    name: '@modelcontextprotocol/server-filesystem',
    description: '官方 Filesystem MCP npm 包候选。这里只填入导入源，不生成 npx 命令、不执行安装。',
    url: 'https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem',
    packageName: '@modelcontextprotocol/server-filesystem',
    category: 'mcp-server',
    riskLevel: 'medium',
    evidence: 'curated-source',
    domains: ['mcp'],
    keywords: ['mcp', 'filesystem', 'file system', 'files', '文件', '目录'],
  },
  {
    source: 'curated',
    providerId: 'curated',
    name: 'MCP Registry',
    description: 'MCP 官方 Registry。网络可用时可直接搜索；网络受限时可粘贴具体 server URL 进入预览。',
    url: 'https://registry.modelcontextprotocol.io/',
    category: 'mcp-registry',
    riskLevel: 'low',
    evidence: 'curated-source',
    domains: ['mcp'],
    keywords: ['mcp', 'registry', 'server', 'servers', 'official', '官方'],
  },
];

export function findCuratedDiscoverySource(raw: string, domain?: DiscoveryDomain): DiscoverySearchResult | null {
  const query = normalizeSearchText(raw);
  const directUrl = raw.trim();
  const found = CURATED_SOURCES.find(source => {
    if (domain && !source.domains.includes(domain)) return false;
    const sourceUrl = source.url || '';
    const directMatch = sourceUrl === directUrl || normalizeSearchText(sourceUrl).includes(query);
    const nameMatch = normalizeSearchText(source.name) === query || normalizeSearchText(source.name).includes(query);
    return directMatch || nameMatch;
  });
  if (!found) return null;
  const { domains: _domains, keywords: _keywords, ...candidate } = found;
  return candidate;
}

const PROVIDERS: Omit<DiscoveryProviderStatus, 'state' | 'lastCheckedAt' | 'lastError'>[] = [
  {
    id: 'local',
    name: 'Local registry',
    kind: 'local',
    domains: ['skill', 'mcp'],
    requiresNetwork: false,
    supportsImportPreview: true,
    note: 'Searches locally saved TAgent Skills and MCP servers.',
  },
  {
    id: 'curated',
    name: 'Curated sources',
    kind: 'curated',
    domains: ['skill', 'mcp'],
    requiresNetwork: false,
    supportsImportPreview: true,
    note: 'Known public sources for agent research skills, browser/search utilities, and official MCP references. Results are still preview-only.',
  },
  {
    id: 'github-repo',
    name: 'GitHub repositories',
    kind: 'github-repo',
    domains: ['skill', 'mcp'],
    requiresNetwork: true,
    supportsImportPreview: true,
    targetUrl: 'https://api.github.com/search/repositories',
    note: 'Finds public repositories. GitHub rate limits unauthenticated requests.',
  },
  {
    id: 'github-code',
    name: 'GitHub code',
    kind: 'github-code',
    domains: ['skill', 'mcp'],
    requiresNetwork: true,
    supportsImportPreview: true,
    targetUrl: 'https://api.github.com/search/code',
    note: 'Searches SKILL.md, skill.json, mcp.json, and package.json when GITHUB_TOKEN or GH_TOKEN is configured.',
  },
  {
    id: 'npm',
    name: 'npm registry',
    kind: 'npm',
    domains: ['mcp'],
    requiresNetwork: true,
    supportsImportPreview: true,
    targetUrl: 'https://registry.npmjs.org/-/v1/search',
    note: 'Finds MCP server packages. Search results are preview-only.',
  },
  {
    id: 'mcp-registry',
    name: 'MCP Registry',
    kind: 'mcp-registry',
    domains: ['mcp'],
    requiresNetwork: true,
    supportsImportPreview: true,
    targetUrl: 'https://registry.modelcontextprotocol.io/',
    note: 'Official MCP server discovery registry.',
  },
  {
    id: 'mcp-reference',
    name: 'modelcontextprotocol/servers',
    kind: 'mcp-reference',
    domains: ['mcp'],
    requiresNetwork: true,
    supportsImportPreview: true,
    targetUrl: 'https://github.com/modelcontextprotocol/servers',
    note: 'Official reference server repository.',
  },
  {
    id: 'url',
    name: 'Direct URL / package',
    kind: 'url',
    domains: ['skill', 'mcp'],
    requiresNetwork: false,
    supportsImportPreview: true,
    note: 'Accepts pasted GitHub URLs, ordinary URLs, and npm package names for import preview.',
  },
];

const lastProviderStatus = new Map<string, DiscoveryProviderStatus>();

export function getDiscoveryProviders(domain?: DiscoveryDomain): DiscoveryProviderStatus[] {
  return PROVIDERS
    .filter(provider => !domain || provider.domains.includes(domain))
    .map(provider => ({
      ...provider,
      ...lastProviderStatus.get(provider.id),
      state: provider.id === 'github-code' && !githubToken() ? 'disabled' : lastProviderStatus.get(provider.id)?.state || 'unknown',
    }));
}

export function getDiscoveryHealth(): DiscoveryProviderStatus[] {
  return getDiscoveryProviders();
}

export async function runDiscoverySearch(context: SearchContext): Promise<DiscoverySearchResponse> {
  const query = context.query.trim();
  if (!query || query.length > 500) throw new Error('搜索词须为1至500个字符。');
  const direct = /^https?:\/\//i.test(query) || (context.domain === 'mcp' && Boolean(directNpmPackageName(query)));
  const providers = getDiscoveryProviders(context.domain);
  const statusById: Record<string, DiscoveryProviderState> = {};
  const statuses: DiscoveryProviderStatus[] = [];
  const errors: string[] = [];
  const candidates: DiscoverySearchResult[] = [];
  let repositorySearch: Promise<ProviderResult> | undefined;
  const repositories = () => repositorySearch ||= searchGithubRepositories(context.domain, query);

  async function collect(providerId: string, search: () => Promise<DiscoverySearchResult[] | ProviderResult>) {
    const provider = providers.find(item => item.id === providerId);
    if (!provider) return;
    if (provider.id === 'url' && !direct) {
      const status = updateStatus(provider, 'disabled', '未输入直接来源。');
      statuses.push(status);
      statusById[provider.id] = status.state;
      return;
    }
    if ((provider.requiresNetwork && direct) || (provider.id === 'github-code' && !githubToken())) {
      const status = updateStatus(provider, 'disabled', direct ? '已识别直接来源，未发起关键词搜索；导入时再验证。' : 'Set GITHUB_TOKEN or GH_TOKEN to enable GitHub code search.');
      statuses.push(status);
      statusById[provider.id] = status.state;
      return;
    }
    try {
      const results = await search();
      const result = Array.isArray(results) ? { candidates: results } : results;
      candidates.push(...result.candidates);
      const status = updateStatus(provider, 'ok', undefined, { cache: result.cache, lastCheckedAt: result.checkedAt });
      statuses.push(status);
      statusById[provider.id] = status.state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${provider.name}: ${message}`);
      const status = updateStatus(provider, 'failed', message, error instanceof GitHubRequestError ? { retryAt: error.retryAt, errorCode: error.code } : {});
      statuses.push(status);
      statusById[provider.id] = status.state;
    }
  }

  await collect('local', () => searchLocal(context));
  await collect('url', () => searchDirectCandidate(context.domain, query));
  await collect('curated', () => searchCuratedSources(context.domain, query));
  await collect('github-repo', repositories);
  await collect('github-code', () => searchGithubCode(context.domain, query));

  if (context.domain === 'mcp') {
    await collect('npm', () => searchNpmPackages(query));
    await collect('mcp-registry', () => searchMcpRegistry(query));
    await collect('mcp-reference', async () => {
      const result = await repositories();
      return { ...result, candidates: result.candidates.filter(item => item.url === 'https://github.com/modelcontextprotocol/servers')
        .map(item => ({ ...item, source: 'mcp-reference', providerId: 'mcp-reference' })) };
    });
  }

  const deduped = dedupeCandidates(candidates);
  return {
    query,
    domain: context.domain,
    candidates: deduped,
    errors,
    providers: statusById,
    providerStatuses: providers.map(provider => {
      const found = statuses.find(status => status.id === provider.id) || lastProviderStatus.get(provider.id);
      return found || provider;
    }),
    note: direct ? '已识别来源，内容尚未读取。请进入导入预览。' : '已找到的结果仅为候选，尚未验证能否导入或运行。',
  };
}

function updateStatus(
  provider: DiscoveryProviderStatus,
  state: DiscoveryProviderState,
  lastError?: string,
  details: Partial<Pick<DiscoveryProviderStatus, 'cache' | 'retryAt' | 'errorCode' | 'lastCheckedAt'>> = {},
): DiscoveryProviderStatus {
  const next: DiscoveryProviderStatus = {
    ...provider,
    state,
    lastCheckedAt: details.lastCheckedAt || Date.now(),
    lastError,
    cache: details.cache,
    retryAt: details.retryAt,
    errorCode: details.errorCode,
  };
  lastProviderStatus.set(provider.id, next);
  return next;
}

async function searchLocal(context: SearchContext): Promise<DiscoverySearchResult[]> {
  const keyword = context.query.toLowerCase();
  if (context.domain === 'skill') {
    const skills = await context.skillsRegistry.getSkills();
    return skills
      .filter(skill => [
        skill.name,
        skill.description,
        skill.category,
        skill.trigger || '',
        skill.package?.manifest.tags.join(' ') || '',
      ].join(' ').toLowerCase().includes(keyword))
      .map(skill => ({
        source: 'local',
        providerId: 'local',
        name: skill.name,
        description: skill.description,
        category: skill.category,
        id: skill.id,
        riskLevel: skill.package?.manifest.riskLevel || 'low',
      }));
  }

  const servers = (await context.mcpRegistry.getServers()).map(redactMCPConfig);
  return servers
    .filter(server => [server.name, server.type, server.url || '', server.command || '', (server.args || []).join(' ')]
      .join(' ')
      .toLowerCase()
      .includes(keyword))
    .map(server => {
      const url = server.url ? new URL(server.url) : undefined;
      if (url) url.search = '';
      return { source: 'local', providerId: 'local', id: server.id, name: server.name,
        description: `${server.type} MCP Server`, type: server.type, url: url?.toString() };
    });
}

async function searchDirectCandidate(domain: DiscoveryDomain, query: string): Promise<DiscoverySearchResult[]> {
  const isUrl = /^https?:\/\//i.test(query);
  const npmPackage = directNpmPackageName(query);
  const isNpm = domain === 'mcp' && Boolean(npmPackage);
  if (!isUrl && !isNpm) return [];
  if (isUrl) assertPublicUrl(query);

  if (domain === 'skill') {
    return [{
      source: 'url',
      providerId: 'url',
      name: isUrl ? labelFromUrl(query) : query,
      description: 'Pasted source. Open import preview to inspect content and risk before saving.',
      url: isUrl ? query : undefined,
      evidence: 'direct-input',
    }];
  }

  return [{
    source: isNpm ? 'npm-direct' : 'url',
    providerId: 'url',
    name: isNpm ? npmPackage! : labelFromUrl(query),
    description: isNpm
      ? 'Pasted npm package name. Import preview will show the npx command without executing it.'
      : 'Pasted MCP source URL. Import preview will inspect config and risk before saving.',
    url: isUrl ? query : undefined,
    packageName: isNpm ? npmPackage || undefined : undefined,
    evidence: 'direct-input',
  }];
}

async function searchCuratedSources(domain: DiscoveryDomain, query: string): Promise<DiscoverySearchResult[]> {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];
  return CURATED_SOURCES
    .filter(source => source.domains.includes(domain))
    .filter(source => {
      const haystack = normalizeSearchText([
        source.name,
        source.description || '',
        source.category || '',
        source.packageName || '',
        source.keywords.join(' '),
      ].join(' '));
      return source.keywords.some(keyword => normalized.includes(normalizeSearchText(keyword)))
        || normalized.split(/\s+/).filter(Boolean).some(token => token.length >= 3 && haystack.includes(token))
        || haystack.includes(normalized);
    })
    .slice(0, 8)
    .map(({ domains: _domains, keywords: _keywords, ...source }) => source);
}

async function searchGithubRepositories(domain: DiscoveryDomain, query: string): Promise<ProviderResult> {
  const url = new URL('https://api.github.com/search/repositories');
  url.searchParams.set('q', `${query} ${domain === 'skill' ? 'skill' : 'mcp'} in:name,description,readme`);
  url.searchParams.set('per_page', '12');
  const result = await githubClient.get<{ items?: Array<Record<string, unknown>> }>(url.pathname + url.search, { signal: AbortSignal.timeout(12000) });
  if (!Array.isArray(result.data?.items)) throw new GitHubRequestError('GitHub 搜索返回格式无效。', 'invalid_response');
  return { cache: result.cache, checkedAt: result.fetchedAt, candidates: result.data.items.slice(0, 8).map(item => ({
    source: 'github', providerId: 'github-repo', name: String(item.full_name || item.name || ''),
    description: String(item.description || ''), url: String(item.html_url || ''),
    stars: Number(item.stargazers_count || 0), updatedAt: String(item.updated_at || ''),
  })) };
}

async function searchGithubCode(domain: DiscoveryDomain, query: string): Promise<ProviderResult> {
  const filenames = domain === 'skill' ? ['SKILL.md', 'skill.json', 'skills.json'] : ['server.json', 'mcp.json', 'package.json'];
  const candidates: DiscoverySearchResult[] = [];
  const caches: DiscoveryProviderStatus['cache'][] = [];
  const checked: number[] = [];
  for (const filename of filenames) {
    const url = new URL('https://api.github.com/search/code');
    // REST filename qualifiers are separate queries; these reads share the bounded GitHub queue/cache.
    url.searchParams.set('q', `${query} filename:${filename}`);
    url.searchParams.set('per_page', '4');
    const result = await githubClient.get<{ items?: Array<Record<string, unknown> & { repository?: Record<string, unknown> }> }>(url.pathname + url.search, { signal: AbortSignal.timeout(12000) });
    if (!Array.isArray(result.data?.items)) throw new GitHubRequestError('GitHub 代码搜索返回格式无效。', 'invalid_response');
    caches.push(result.cache); checked.push(result.fetchedAt);
    candidates.push(...result.data.items.map(item => ({
      source: 'github-code', providerId: 'github-code',
      name: `${String(item.repository?.full_name || '')}/${String(item.path || item.name || '')}`,
      description: String(item.repository?.description || ''), url: String(item.html_url || ''),
      updatedAt: String(item.repository?.updated_at || ''),
    })));
  }
  return { candidates, cache: caches.includes('network') ? 'network' : caches.includes('revalidated') ? 'revalidated' : 'memory', checkedAt: Math.min(...checked) };
}

async function searchNpmPackages(query: string): Promise<DiscoverySearchResult[]> {
  const url = new URL('https://registry.npmjs.org/-/v1/search');
  url.searchParams.set('text', `${query} keywords:mcp,model-context-protocol`);
  url.searchParams.set('size', '32');
  url.searchParams.set('popularity', '0');
  url.searchParams.set('quality', '0.5');
  url.searchParams.set('maintenance', '0.5');
  const response = await fetchWithTimeout(url, { headers: { 'User-Agent': 'TAgent Discovery/0.3' } });
  if (!response.ok) throw new Error(`npm HTTP ${response.status}`);
  const data = await response.json() as { objects?: Array<{ package?: Record<string, unknown> }> };
  if (!Array.isArray(data.objects)) throw new Error('npm 返回格式无效。');
  const terms = normalizeSearchText(query).split(/[^\p{L}\p{N}]+/u).filter(word => word && !['mcp', 'server', 'servers', 'modelcontextprotocol', 'model', 'context', 'protocol'].includes(word));
  return data.objects.map(item => {
    const pkg = item.package || {};
    const name = String(pkg.name || ''), description = String(pkg.description || '');
    const label = normalizeSearchText(name), detail = normalizeSearchText(description);
    const matched = terms.filter(term => label.includes(term) || detail.includes(term));
    const library = /(^|[-/])(sdk|client|core|types|adapter|middleware|handler)$/.test(name)
      || /^(?:(?:a|an|the|official|typescript|javascript|node\.js|python|mcp|model context protocol)\s+)*(?:SDK|client library|middleware|type definitions|schema library)\b/i.test(description);
    const score = matched.reduce((sum, term) => sum + (label.includes(term) ? 8 : 2), 0) + (/mcp.*server|server.*mcp/i.test(name) ? 3 : 0);
    return { pkg, name, description, matched: matched.length, library, score };
  }).filter(item => item.name && !item.library && (!terms.length || item.matched >= Math.ceil(terms.length / 2)))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 8).map(({ pkg, name, description }) => ({
      source: 'npm', providerId: 'npm', name, description,
      url: `https://www.npmjs.com/package/${name}`, packageName: name,
      version: String(pkg.version || ''), updatedAt: String(pkg.date || ''),
      evidence: 'registry-search-metadata; executable checked only during import',
    }));
}

async function searchMcpRegistry(query: string): Promise<DiscoverySearchResult[]> {
  const url = new URL('https://registry.modelcontextprotocol.io/v0.1/servers');
  url.searchParams.set('search', query);
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', '8');
  const response = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'TAgent Discovery/0.2', Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`MCP Registry HTTP ${response.status}`);
  const data = await response.json() as { servers?: Array<{ server?: Record<string, unknown>; _meta?: Record<string, { status?: unknown; updatedAt?: unknown }> }> };
  if (!Array.isArray(data.servers)) throw new Error('MCP Registry 返回格式无效。');
  return data.servers.slice(0, 8).flatMap(item => {
    const server = item.server;
    const official = item._meta?.['io.modelcontextprotocol.registry/official'];
    if (!server || typeof server.name !== 'string' || !server.name || typeof server.version !== 'string' || !server.version
        || (official?.status && official.status !== 'active')) return [];
    return [{
      source: 'mcp-registry',
      providerId: 'mcp-registry',
      name: server.name,
      description: typeof server.description === 'string' ? server.description : '',
      url: `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version)}`,
      version: server.version,
      updatedAt: typeof official?.updatedAt === 'string' ? official.updatedAt : '',
    }];
  });
}

async function fetchWithTimeout(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(8000),
  });
}

function dedupeCandidates(candidates: DiscoverySearchResult[]): DiscoverySearchResult[] {
  const order = ['local', 'url', 'mcp-registry', 'github-code', 'npm', 'github-repo', 'mcp-reference', 'curated'];
  const unique = new Map<string, DiscoverySearchResult>();
  for (const candidate of [...candidates].sort((a, b) => order.indexOf(a.providerId) - order.indexOf(b.providerId))) {
    const key = candidate.source === 'local' ? `local:${candidate.id}` : candidate.url?.replace(/\/$/, '') || `${candidate.providerId}:${candidate.packageName || candidate.name}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  const groups = order.map(provider => [...unique.values()].filter(item => item.providerId === provider));
  const results: DiscoverySearchResult[] = [];
  for (let index = 0; index < 24 && results.length < 24; index++) {
    for (const group of groups) if (group[index] && results.length < 24) results.push(group[index]);
  }
  return results;
}

function labelFromUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return url.hostname === 'github.com'
      ? url.pathname.split('/').filter(Boolean).slice(0, 2).join('/') || url.hostname
      : url.hostname;
  } catch {
    return raw;
  }
}

function directNpmPackageName(query: string): string | null {
  const value = query.trim();
  if (value.startsWith('npm:')) {
    const packageName = value.slice(4).trim();
    return /^(@[\w-]+\/)?[\w.-]+(?:@[\w.+-]+)?$/.test(packageName) ? packageName : null;
  }
  if (/^@[\w-]+\/[\w.-]+(?:@[\w.+-]+)?$/.test(value)) return value;
  return null;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ');
}
