import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDiscoveryProviders, runDiscoverySearch } from '../discovery.js';
import { githubClient } from '../github-client.js';
import type { SkillsRegistry, MCPRegistry } from '@tagent/core';

const skillsRegistry = {
  async getSkills() {
    return [{
      id: 'local-skill',
      name: 'Local research skill',
      description: 'Research with source verification.',
      category: 'research',
      trigger: 'research',
      body: 'Use verified sources.',
      createdAt: 1,
      package: {
        manifest: {
          name: 'Local research skill',
          category: 'research',
          version: '1.0.0',
          triggers: ['research'],
          applicableAgents: ['research-agent'],
          riskLevel: 'low',
          tags: ['research'],
        },
        instructions: 'Use verified sources.',
        documents: [],
        inputs: [],
        outputs: [],
        tools: [],
        examples: [],
        tests: [],
        riskNotes: [],
      },
    }];
  },
} as unknown as SkillsRegistry;

const mcpRegistry = {
  async getServers() {
    return [{
      id: 'local-mcp',
      name: 'Local filesystem',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: {},
    }];
  },
} as unknown as MCPRegistry;

beforeEach(() => { vi.stubEnv('GITHUB_TOKEN', ''); vi.stubEnv('GH_TOKEN', ''); });
afterEach(() => {
  githubClient.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('discovery search', () => {
  it.each([
    ['skill', 'https://github.com/demo/skills/tree/main/a'],
    ['mcp', 'https://example.com/mcp.json?token=fixture-private'],
    ['mcp', 'npm:filesystem-mcp@1.2.3'],
    ['mcp', '@modelcontextprotocol/server-filesystem@1.2.3'],
  ] as const)('does not send direct %s sources to keyword search providers: %s', async (domain, query) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await runDiscoverySearch({ domain, query, skillsRegistry, mcpRegistry });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.candidates.some(item => item.providerId === 'url')).toBe(true);
    expect(result.providers['github-repo']).toBe('disabled');
    expect(result.note).toContain('尚未读取');
  });

  it('rejects private direct URLs without forwarding them as search terms', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await runDiscoverySearch({ domain: 'mcp', query: 'http://127.0.0.1/private', skillsRegistry, mcpRegistry });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.providers.url).toBe('failed');
    expect(result.candidates).toEqual([]);
  });

  it('reuses repository search within a run and across repeated searches', async () => {
    const fetcher = vi.fn(async (_input: URL | string) => jsonResponse({ items: [], objects: [], servers: [] }));
    vi.stubGlobal('fetch', fetcher);
    const first = await runDiscoverySearch({ domain: 'mcp', query: 'filesystem', skillsRegistry, mcpRegistry });
    const second = await runDiscoverySearch({ domain: 'mcp', query: 'filesystem', skillsRegistry, mcpRegistry });
    expect(first.providerStatuses.find(item => item.id === 'github-repo')?.cache).toBe('network');
    expect(first.providers.url).toBe('disabled');
    expect(second.providerStatuses.find(item => item.id === 'github-repo')).toMatchObject({ cache: 'memory', lastCheckedAt: first.providerStatuses.find(item => item.id === 'github-repo')?.lastCheckedAt });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('api.github.com'))).toHaveLength(1);
  });

  it('shares a failed repository read without retrying it for the reference provider', async () => {
    const fetcher = vi.fn(async (_input: URL | string) => { throw new Error('offline'); });
    vi.stubGlobal('fetch', fetcher);
    await runDiscoverySearch({ domain: 'mcp', query: 'filesystem', skillsRegistry, mcpRegistry });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('api.github.com'))).toHaveLength(1);
  });
  it('keeps a fast npm result when a slow GitHub request is cancelled', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((input: URL | string, init?: RequestInit): Promise<Response> => {
      if (!String(input).includes('api.github.com')) return Promise.resolve(jsonResponse({
        objects: [{ package: { name: 'filesystem-mcp-server', description: 'Filesystem MCP server' } }], servers: [],
      }));
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const pending = runDiscoverySearch({ domain: 'mcp', query: 'filesystem', skillsRegistry, mcpRegistry,
      signal: controller.signal });
    await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes('registry.npmjs.org'))).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    const result = await pending;
    expect(result.candidates.some(candidate => candidate.providerId === 'npm')).toBe(true);
    expect(result.providers['github-repo']).toBe('failed');
    expect(result.candidates.every(candidate => !('command' in candidate))).toBe(true);
  });

  it('returns a real reset time and keeps other providers usable during GitHub limits', async () => {
    const reset = Math.ceil(Date.now() / 1000) + 120;
    const fetcher = vi.fn(async (input: URL | string) => String(input).includes('api.github.com')
      ? new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } })
      : jsonResponse({ objects: [{ package: { name: 'filesystem-mcp-server', description: 'Filesystem MCP server', version: '1.0.0' } }], servers: [] }));
    vi.stubGlobal('fetch', fetcher);
    const result = await runDiscoverySearch({ domain: 'mcp', query: 'filesystem', skillsRegistry, mcpRegistry });
    expect(result.providerStatuses.find(item => item.id === 'github-repo')).toMatchObject({ state: 'failed', errorCode: 'rate_limit', retryAt: reset * 1000 });
    expect(result.providers.npm).toBe('ok');
    expect(result.candidates.some(item => item.providerId === 'npm')).toBe(true);
    await runDiscoverySearch({ domain: 'skill', query: 'research', skillsRegistry, mcpRegistry });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('api.github.com'))).toHaveLength(1);
  });

  it('ranks matching MCP servers above libraries without rejecting servers built with an SDK', async () => {
    const packages = [
      { name: '@modelcontextprotocol/sdk', description: 'TypeScript SDK with filesystem examples' },
      { name: 'unrelated-mcp-server', description: 'Email tools' },
      { name: 'filesystem-library', description: 'SDK for filesystem clients' },
      { name: 'filesystem-mcp-server', description: 'Filesystem MCP server built with the official SDK', version: '2.0.0' },
      { name: 'file-tools', description: 'MCP server for filesystem operations' },
    ];
    const fetcher = vi.fn(async (_input: URL | string) => jsonResponse({ items: [], servers: [], objects: packages.map(pkg => ({ package: pkg })) }));
    vi.stubGlobal('fetch', fetcher);
    const result = await runDiscoverySearch({ domain: 'mcp', query: 'filesystem', skillsRegistry, mcpRegistry });
    expect(result.candidates.filter(item => item.providerId === 'npm').map(item => item.name)).toEqual(['filesystem-mcp-server', 'file-tools']);
    const npmUrl = new URL(String(fetcher.mock.calls.find(([url]) => String(url).includes('registry.npmjs.org'))![0]));
    expect(npmUrl.searchParams.get('text')).toBe('filesystem keywords:mcp,model-context-protocol');
    expect(npmUrl.searchParams.get('popularity')).toBe('0');
    for (const item of result.candidates) expect(item).not.toHaveProperty('command');
  });

  it('does not let GitHub results crowd the official registry out of a full result list', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'fixture-token');
    const fetcher = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.includes('api.github.com')) return jsonResponse({ items: Array.from({ length: 8 }, (_, i) => ({ full_name: `demo/filesystem-${i}`, html_url: `https://github.com/demo/filesystem-${i}${url.includes('/code') ? '/blob/main/mcp.json' : ''}` })) });
      if (url.includes('registry.npmjs.org')) return jsonResponse({ objects: Array.from({ length: 8 }, (_, i) => ({ package: { name: `filesystem-mcp-server-${i}` } })) });
      return jsonResponse({ servers: Array.from({ length: 8 }, (_, i) => ({ server: { name: `io.fixture/filesystem-${i}`, version: '1.0.0' } })) });
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await runDiscoverySearch({ domain: 'mcp', query: 'filesystem', skillsRegistry, mcpRegistry });
    expect(result.candidates).toHaveLength(24);
    expect(result.candidates.some(item => item.providerId === 'mcp-registry')).toBe(true);
    expect(result.candidates.some(item => item.providerId === 'npm')).toBe(true);
  });

  it('does not label malformed GitHub JSON as a successful empty search', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'unexpected format' })));
    const result = await runDiscoverySearch({ domain: 'skill', query: 'research', skillsRegistry, mcpRegistry });
    expect(result.providerStatuses.find(item => item.id === 'github-repo')).toMatchObject({ state: 'failed', errorCode: 'invalid_response' });
  });

  it('stops advertising code search as enabled when its credential is removed', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'fixture-token');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [] })));
    await runDiscoverySearch({ domain: 'skill', query: 'research', skillsRegistry, mcpRegistry });
    vi.stubEnv('GITHUB_TOKEN', '');
    expect(getDiscoveryProviders('skill').find(item => item.id === 'github-code')?.state).toBe('disabled');
  });

  it('reads v0.1 registry envelopes and preserves the exact server version for import', async () => {
    const fetcher = vi.fn(async (input: URL | string) => String(input).includes('registry.modelcontextprotocol.io')
      ? jsonResponse({ servers: [{ server: { name: 'io.fixture/files', description: 'File tools', version: '2.1.0', repository: { url: 'https://github.com/demo/files' } }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', updatedAt: '2026-09-12' } } }] })
      : jsonResponse({ items: [], objects: [] }));
    vi.stubGlobal('fetch', fetcher);
    const result = await runDiscoverySearch({ domain: 'mcp', query: 'files', skillsRegistry, mcpRegistry });
    expect(result.providers['mcp-registry']).toBe('ok');
    const candidate = result.candidates.find(item => item.providerId === 'mcp-registry');
    expect(candidate).toMatchObject({ name: 'io.fixture/files', version: '2.1.0', url: 'https://registry.modelcontextprotocol.io/v0.1/servers/io.fixture%2Ffiles/versions/2.1.0' });
    expect(candidate).not.toHaveProperty('command');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('version=latest'))).toBe(true);
  });

  it('uses GitHub credentials configured after module initialization', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'test-request-time-token');
    const fetcher = vi.fn(async (_input: URL | string, _options?: RequestInit) => jsonResponse({ items: [] }));
    vi.stubGlobal('fetch', fetcher);
    const result = await runDiscoverySearch({ domain: 'skill', query: 'research', skillsRegistry, mcpRegistry });
    expect(result.providers['github-code']).toBe('ok');
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('api.github.com')).every(([, options]) => new Headers(options?.headers).get('authorization') === 'Bearer test-request-time-token')).toBe(true);
  });
  it('does not expose stored MCP URL credentials through local search results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const result = await runDiscoverySearch({ domain: 'mcp', query: 'Private service', skillsRegistry,
      mcpRegistry: { async getServers() { return [{ id: 'private-config', name: 'Private service', type: 'http', url: 'https://mcp.example/mcp?api_key=private-stored-key', headers: { Authorization: 'Bearer private-header' } }]; } } as unknown as MCPRegistry });
    const local = result.candidates.find(candidate => candidate.id === 'private-config');
    expect(local?.url).toBe('https://mcp.example/mcp');
    expect(JSON.stringify(result)).not.toContain('private-stored-key');
    expect(JSON.stringify(result)).not.toContain('private-header');
  });
  it('returns local and real remote skill candidates without drafts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.includes('api.github.com/search/repositories')) {
        return jsonResponse({
          items: [{
            full_name: 'example/agent-skill',
            description: 'Reusable skill package',
            html_url: 'https://github.com/example/agent-skill',
            stargazers_count: 42,
            updated_at: '2026-06-20T00:00:00Z',
          }],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const result = await runDiscoverySearch({
      domain: 'skill',
      query: 'research',
      skillsRegistry,
      mcpRegistry,
    });

    expect(result.providers.local).toBe('ok');
    expect(result.providers['github-repo']).toBe('ok');
    expect(result.candidates.some(candidate => candidate.source === 'local')).toBe(true);
    expect(result.candidates.some(candidate => candidate.providerId === 'github-repo')).toBe(true);
    for (const candidate of result.candidates as unknown as Array<Record<string, unknown>>) {
      expect(candidate).not.toHaveProperty('draft');
      expect(candidate).not.toHaveProperty('package');
      expect(candidate).not.toHaveProperty('body');
      expect(candidate).not.toHaveProperty('commandPreview');
      expect(candidate).not.toHaveProperty('env');
    }
  });

  it('reports provider failures without fabricating MCP templates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network blocked');
    }));

    const result = await runDiscoverySearch({
      domain: 'mcp',
      query: 'filesystem',
      skillsRegistry,
      mcpRegistry,
    });

    expect(result.providers.local).toBe('ok');
    expect(result.providers['github-repo']).toBe('failed');
    expect(result.providers.npm).toBe('failed');
    expect(result.providers['mcp-reference']).toBe('failed');
    expect(result.providers['mcp-registry']).toBe('failed');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.candidates.some(candidate => candidate.source === 'local')).toBe(true);
    expect(result.candidates.some(candidate => candidate.name === 'filesystem-mcp-server')).toBe(false);
    expect(result.candidates.some(candidate => candidate.packageName === 'filesystem')).toBe(false);
  });

  it('treats pasted URL and explicit npm package as preview sources only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [] })));

    const skillUrlResult = await runDiscoverySearch({
      domain: 'skill',
      query: 'https://github.com/example/skill-pack',
      skillsRegistry,
      mcpRegistry,
    });
    expect(skillUrlResult.candidates.some(candidate => candidate.providerId === 'url' && candidate.url)).toBe(true);

    const mcpNpmResult = await runDiscoverySearch({
      domain: 'mcp',
      query: 'npm:@modelcontextprotocol/server-filesystem',
      skillsRegistry,
      mcpRegistry,
    });
    const direct = mcpNpmResult.candidates.find(candidate => candidate.providerId === 'url');
    expect(direct?.packageName).toBe('@modelcontextprotocol/server-filesystem');
    expect(direct as unknown as Record<string, unknown>).not.toHaveProperty('commandPreview');
    expect(direct as unknown as Record<string, unknown>).not.toHaveProperty('env');
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}
