import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createWebSearchTool, resolveResearchSearchProvider } from '@tagent/core';
import type { PersistenceAdapter, ResearchSearchProvider, ResearchSearchSelection, SearchSettingsView, SearchProbeDiagnostic, SearchProbeResult } from '@tagent/core';

const CONFIRMATION_VERSION = 'research-search-2026-09-11-v1';
const TEST_QUERY = 'AI agent research';
const STORAGE_KEY = 'research-search';

interface SavedSearchSettings {
  version: 1;
  provider: ResearchSearchProvider;
  revision: number;
  confirmedAt: string;
  confirmationVersion: string;
}

class SearchSettingsError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 429 | 503) { super(message); }
}

const isProvider = (value: unknown): value is ResearchSearchProvider => value === 'auto' || value === 'parallel';

export class SearchSettingsStore {
  private saved: SavedSearchSettings | null = null;
  private queue = Promise.resolve();
  private readonly environmentProvider?: string;
  private readonly optionalProviders: string[];

  private constructor(private readonly persistence: PersistenceAdapter, env: Record<string, string | undefined>) {
    this.environmentProvider = env.TAGENT_SEARCH_PROVIDER?.trim() || undefined;
    this.optionalProviders = [env.TAVILY_API_KEY ? 'api.tavily.com' : '', env.JINA_API_KEY ? 's.jina.ai' : ''].filter(Boolean);
  }

  static async open(persistence: PersistenceAdapter, env: Record<string, string | undefined> = process.env): Promise<SearchSettingsStore> {
    const store = new SearchSettingsStore(persistence, env);
    const value = await persistence.load<unknown>(STORAGE_KEY, null);
    if (value !== null) {
      const saved = value as SavedSearchSettings;
      if (!saved || saved.version !== 1 || !isProvider(saved.provider) || !Number.isSafeInteger(saved.revision) || saved.revision < 1
        || typeof saved.confirmedAt !== 'string' || !Number.isFinite(Date.parse(saved.confirmedAt)) || saved.confirmationVersion !== CONFIRMATION_VERSION) {
        throw new Error('调研搜索配置无效，未覆盖已保存配置；请检查 research-search 存储记录。');
      }
      store.saved = saved;
    }
    return store;
  }

  get provider(): ResearchSearchSelection {
    return this.environmentProvider ? resolveResearchSearchProvider(this.environmentProvider) : this.saved?.provider || 'auto';
  }

  view(): SearchSettingsView {
    return {
      provider: this.provider, origin: this.environmentProvider ? 'environment' : this.saved ? 'saved' : 'default',
      locked: !!this.environmentProvider, revision: this.saved?.revision || 0, updatedAt: this.saved?.confirmedAt,
      confirmationVersion: CONFIRMATION_VERSION, testQuery: TEST_QUERY,
      options: [
        { id: 'auto', name: '现有搜索源', recipients: ['www.bing.com', 'search.bus-hit.me', 'searx.be', 'search.ononoki.org', 'search.sapti.me', 'api.github.com（仓库查询）', ...this.optionalProviders],
          disclosure: '关键词会发送到上述搜索服务，可能使用浏览器搜索及其页面资源；已配置的搜索 API 也会参与。不会启用 Parallel。来源网页读取和独立浏览器仍按已授权工具权限连接相应站点，此选项不是全局联网限制。',
          costNotice: '不调用语言模型；已配置的第三方搜索 API 可能消耗其额度或产生费用。公共搜索源不保证可用。' },
        { id: 'parallel', name: 'Parallel', recipients: ['search.parallel.ai'],
          disclosure: '向 Parallel 发送检索目标、关键词和随机或散列的会话关联 ID。关键词可能来自任务描述；不会附带完整会话、文件或模型 API Key。此搜索适配器失败时不自动换源。来源网页读取和独立浏览器仍按已授权工具权限连接相应站点，此选项不是全局联网限制。',
          costNotice: '使用无需 Key 的免费接口，适合轻量使用，可能限流；不自动升级付费，不代表生产服务承诺。',
          documentationUrl: 'https://docs.parallel.ai/integrations/mcp/search-mcp' },
      ],
    };
  }

  validateRequest(value: unknown, saving: boolean): { provider: ResearchSearchProvider; expectedRevision?: number } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SearchSettingsError('请求格式不正确。', 400);
    const input = value as Record<string, unknown>;
    const allowed = ['provider', 'confirmed', 'confirmationVersion', ...(saving ? ['expectedRevision'] : [])];
    if (Object.keys(input).some(key => !allowed.includes(key)) || !isProvider(input.provider)) throw new SearchSettingsError('请选择受支持的搜索来源，不能提交自定义命令、地址或查询。', 400);
    if (input.confirmed !== true || input.confirmationVersion !== CONFIRMATION_VERSION) throw new SearchSettingsError('请先阅读当前外发范围并明确确认。', 400);
    if (saving && (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)) throw new SearchSettingsError('配置版本缺失，请刷新后重试。', 400);
    if (this.environmentProvider && (saving || input.provider !== this.provider)) throw new SearchSettingsError('搜索来源由部署环境固定，不能在页面覆盖；请联系部署管理员。', 409);
    return { provider: input.provider, expectedRevision: saving ? Number(input.expectedRevision) : undefined };
  }

  async save(value: unknown): Promise<SearchSettingsView> {
    const input = this.validateRequest(value, true);
    const operation = this.queue.then(async () => {
      if (input.expectedRevision !== (this.saved?.revision || 0)) throw new SearchSettingsError('配置已被其他页面修改，请刷新后重新确认。', 409);
      const next: SavedSearchSettings = { version: 1, provider: input.provider, revision: input.expectedRevision! + 1,
        confirmedAt: new Date().toISOString(), confirmationVersion: CONFIRMATION_VERSION };
      try { await this.persistence.save(STORAGE_KEY, next); }
      catch { throw new SearchSettingsError('搜索配置保存失败，原配置仍然有效；请检查存储后重试。', 503); }
      this.saved = next;
      return this.view();
    });
    this.queue = operation.then(() => {}, () => {});
    return operation;
  }
}

export type SearchProbe = (provider: ResearchSearchProvider, sessionId: string) => Promise<SearchProbeDiagnostic[]>;
const probeSearch: SearchProbe = async (searchProvider, searchSessionId) => {
  let result: SearchProbeDiagnostic[] = [];
  await createWebSearchTool({ topic: TEST_QUERY, searchProvider, searchSessionId, onDiagnostics: value => { result = value; } })
    .execute({ query: TEST_QUERY, maxResults: 2 });
  return result;
};

export function createSearchSettingsRoutes(store: SearchSettingsStore, probe: SearchProbe = probeSearch, now = Date.now) {
  const routes = new Hono();
  const probeSessionId = randomUUID();
  let testing = false;
  let lastTestAt = -Infinity;
  routes.get('/settings', c => c.json(store.view()));
  routes.put('/settings', async c => {
    try { return c.json(await store.save(await c.req.json())); }
    catch (error) { return c.json({ error: error instanceof SearchSettingsError ? error.message : '请求格式不正确。' }, error instanceof SearchSettingsError ? error.status : 400); }
  });
  routes.post('/test', async c => {
    let provider: ResearchSearchProvider;
    try { ({ provider } = store.validateRequest(await c.req.json(), false)); }
    catch (error) { return c.json({ error: error instanceof SearchSettingsError ? error.message : '请求格式不正确。' }, error instanceof SearchSettingsError ? error.status : 400); }
    if (testing) return c.json({ error: '已有搜索测试正在进行，请等待完成。' }, 409);
    if (now() - lastTestAt < 30000) return c.json({ error: '测试过于频繁，请30秒后重试。' }, 429);
    testing = true;
    const started = now();
    lastTestAt = started;
    try {
      const diagnostics = await probe(provider, probeSessionId);
      const status = diagnostics.some(item => item.relevantCount > 0 && item.status === 'ok') ? 'available'
        : diagnostics.length && diagnostics.some(item => item.status !== 'failed') ? 'empty' : 'failed';
      const result: SearchProbeResult = { provider, status, checkedAt: new Date(now()).toISOString(), elapsedMs: now() - started,
        query: TEST_QUERY, diagnostics };
      return c.json(result);
    } catch {
      const result: SearchProbeResult = { provider, status: 'failed', checkedAt: new Date(now()).toISOString(), elapsedMs: now() - started,
        query: TEST_QUERY, diagnostics: [{ source: provider, status: 'failed', parsedCount: 0, relevantCount: 0, error: '搜索测试失败，请检查网络、代理或服务限流；未切换来源。' }] };
      return c.json(result);
    } finally { testing = false; }
  });
  return routes;
}
