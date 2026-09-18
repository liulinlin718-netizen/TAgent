import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { FilePersistence, MemoryPersistence } from '@tagent/core';
import type { SearchProbeDiagnostic } from '@tagent/core';
import { createSearchSettingsRoutes, SearchSettingsStore } from '../search-settings.js';
import type { SearchProbe } from '../search-settings.js';
import { installAccessControl, resolveAccessConfig } from '../access-control.js';
import { loadServerEnvironment, modelConfigurationStatus } from '../config.js';

const base = 'http://127.0.0.1:3001/api/research-search';
const diagnostics: SearchProbeDiagnostic[] = [{ source: 'Parallel Search', status: 'ok', parsedCount: 3, relevantCount: 2 }];
const input = (store: SearchSettingsStore, saving = true) => ({ provider: 'parallel', confirmed: true,
  confirmationVersion: store.view().confirmationVersion, ...(saving ? { expectedRevision: store.view().revision } : {}) });
const request = (app: Hono, route: string, method: string, body?: unknown) => app.request(`${base}${route}`, {
  method, headers: { 'Content-Type': 'application/json', 'X-Tagent-Request': '1' }, ...(body ? { body: JSON.stringify(body) } : {}),
});
async function setup() {
  const persistence = new MemoryPersistence();
  const save = vi.spyOn(persistence, 'save');
  const store = await SearchSettingsStore.open(persistence, {});
  const probe = vi.fn<SearchProbe>(async () => diagnostics);
  let clock = 100000;
  const app = new Hono().route('/api/research-search', createSearchSettingsRoutes(store, probe, () => clock));
  return { persistence, save, store, probe, app, advance: () => { clock += 30001; } };
}

describe('research search settings and consent', () => {
  it('lets a fresh template install confirm and retain a provider without locking the management page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tagent-template-settings-'));
    try {
      await mkdir(join(root, 'packages/tagent-server'), { recursive: true });
      await writeFile(join(root, 'packages/tagent-server/.env'), await readFile(new URL('../../.env.example', import.meta.url)));
      const env: Record<string, string | undefined> = {};
      loadServerEnvironment(root, env);
      expect(modelConfigurationStatus(env).status).toBe('unconfigured');
      expect(env.DATABASE_URL).toBeUndefined();
      const store = await SearchSettingsStore.open(new FilePersistence(root), env);
      const probe = vi.fn<SearchProbe>(async () => diagnostics);
      const app = new Hono().route('/api/research-search', createSearchSettingsRoutes(store, probe));
      expect(await (await request(app, '/settings', 'GET')).json())
        .toMatchObject({ provider: 'auto', origin: 'default', locked: false, revision: 0 });
      expect((await request(app, '/settings', 'PUT', { ...input(store), confirmed: false })).status).toBe(400);
      expect(await (await request(app, '/settings', 'PUT', input(store))).json())
        .toMatchObject({ provider: 'parallel', origin: 'saved', locked: false, revision: 1 });
      const restartedEnv: Record<string, string | undefined> = {};
      loadServerEnvironment(root, restartedEnv);
      const restarted = await SearchSettingsStore.open(new FilePersistence(root), restartedEnv);
      expect(restarted.view()).toMatchObject({ provider: 'parallel', origin: 'saved', locked: false, revision: 1 });
      expect(probe).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('loads defaults without writes or outbound tests, and reveals no environment secrets', async () => {
    const { app, store, probe, save } = await setup();
    const response = await request(app, '/settings', 'GET');
    expect(await response.json()).toMatchObject({ provider: 'auto', origin: 'default', locked: false, revision: 0 });
    expect(probe).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    const configured = await SearchSettingsStore.open(new MemoryPersistence(), { TAVILY_API_KEY: 'private-tavily', JINA_API_KEY: 'private-jina' });
    expect(JSON.stringify(configured.view())).not.toContain('private-');
    expect(configured.view().options[0].recipients).toContain('api.tavily.com');
    expect(store.provider).toBe('auto');
  });
  it.each([{ confirmed: false }, { confirmed: 'true' }, { confirmationVersion: 'old' }, { provider: 'unknown' },
    { command: 'install-package' }, { url: 'https://private.example' }, { query: 'private session content' }])('rejects unconfirmed, stale or unexpected inputs without side effects: %j', async change => {
    const { app, store, save, probe } = await setup();
    expect((await request(app, '/settings', 'PUT', { ...input(store), ...change })).status).toBe(400);
    expect((await request(app, '/test', 'POST', { ...input(store, false), ...change })).status).toBe(400);
    expect(store.provider).toBe('auto');
    expect(save).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });
  it('persists only explicitly confirmed settings and restores them through the real file adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tagent-search-settings-'));
    try {
      const store = await SearchSettingsStore.open(new FilePersistence(root), {});
      await store.save(input(store));
      const restored = await SearchSettingsStore.open(new FilePersistence(root), {});
      expect(restored.view()).toMatchObject({ provider: 'parallel', origin: 'saved', revision: 1 });
      expect(restored.view().updatedAt).toBe(store.view().updatedAt);
      await restored.save({ ...input(restored), provider: 'auto' });
      expect((await SearchSettingsStore.open(new FilePersistence(root), {})).provider).toBe('auto');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains the committed provider after a write failure and serializes stale concurrent updates', async () => {
    const { store, save } = await setup();
    save.mockRejectedValueOnce(new Error('disk failure secret path'));
    await expect(store.save(input(store))).rejects.toThrow('原配置仍然有效');
    expect(store.provider).toBe('auto');
    expect(store.view().revision).toBe(0);
    const sameRevision = input(store);
    const results = await Promise.allSettled([store.save(sameRevision), store.save({ ...sameRevision, provider: 'auto' })]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(store.provider).toBe('parallel');
    expect(store.view().revision).toBe(1);
    expect(save).toHaveBeenCalledTimes(2);
  });
  it.each(['auto', 'parallel', 'https://user:secret@unexpected.example'])('respects explicit deployment configuration without exposing it: %s', async value => {
    const persistence = new MemoryPersistence();
    const original = await SearchSettingsStore.open(persistence, {});
    await original.save(input(original));
    const store = await SearchSettingsStore.open(persistence, { TAGENT_SEARCH_PROVIDER: value });
    expect(store.view()).toMatchObject({ origin: 'environment', locked: true, provider: value === 'auto' || value === 'parallel' ? value : 'invalid' });
    expect(JSON.stringify(store.view())).not.toContain('secret');
    await expect(store.save(input(store))).rejects.toThrow('部署环境固定');
    expect(() => store.validateRequest({ ...input(store, false), provider: store.provider === 'parallel' ? 'auto' : 'parallel' }, false)).toThrow('部署环境固定');
  });
  it('refuses damaged saved configuration rather than replacing it with default consent', async () => {
    const persistence = new MemoryPersistence();
    await persistence.save('research-search', { provider: 'parallel' });
    const save = vi.spyOn(persistence, 'save');
    await expect(SearchSettingsStore.open(persistence, {})).rejects.toThrow('未覆盖已保存配置');
    expect(save).not.toHaveBeenCalled();
  });
  it('tests only on explicit request and never saves or activates the tested provider', async () => {
    const { app, store, probe, save, advance } = await setup();
    const response = await request(app, '/test', 'POST', input(store, false));
    expect(await response.json()).toMatchObject({ provider: 'parallel', status: 'available', query: 'AI agent research', diagnostics });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][0]).toBe('parallel');
    expect(store.provider).toBe('auto');
    expect(save).not.toHaveBeenCalled();
    expect((await request(app, '/test', 'POST', input(store, false))).status).toBe(429);
    advance();
    await request(app, '/test', 'POST', input(store, false));
    expect(probe.mock.calls[1][1]).toBe(probe.mock.calls[0][1]);
  });
  it('keeps a running probe bound to its requested provider and rejects a duplicate probe', async () => {
    const { app, store, probe, advance } = await setup();
    let release!: (value: SearchProbeDiagnostic[]) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    probe.mockImplementationOnce(() => { started(); return new Promise(resolve => { release = resolve; }); });
    const pending = request(app, '/test', 'POST', input(store, false));
    await ready;
    advance();
    expect((await request(app, '/test', 'POST', input(store, false))).status).toBe(409);
    await store.save({ ...input(store), provider: 'auto' });
    release(diagnostics);
    expect(await (await pending).json()).toMatchObject({ provider: 'parallel', status: 'available' });
    expect(store.provider).toBe('auto');
  });
  it('distinguishes empty/failed tests and hides raw exception credentials', async () => {
    const { app, store, probe, advance } = await setup();
    probe.mockResolvedValueOnce([{ source: 'Provider', status: 'empty', parsedCount: 2, relevantCount: 0 }]);
    expect(await (await request(app, '/test', 'POST', input(store, false))).json()).toMatchObject({ status: 'empty' });
    advance();
    probe.mockRejectedValueOnce(new Error('Bearer secret https://user:password@example.com'));
    const failed = await (await request(app, '/test', 'POST', input(store, false))).json();
    expect(failed.status).toBe('failed');
    expect(JSON.stringify(failed)).not.toMatch(/secret|password/);
  });
  it('protects settings and tests with the existing login and Origin boundary', async () => {
    const { store, probe, save } = await setup();
    const token = 'test-only-owner-access-token-over-32-characters';
    const app = new Hono();
    installAccessControl(app, resolveAccessConfig({ TAGENT_ACCESS_TOKEN: token }, '127.0.0.1', 3001));
    app.route('/api/research-search', createSearchSettingsRoutes(store, probe));
    expect((await request(app, '/settings', 'GET')).status).toBe(401);
    expect((await request(app, '/settings', 'PUT', input(store))).status).toBe(401);
    expect((await request(app, '/test', 'POST', input(store, false))).status).toBe(401);
    expect((await app.request(`${base}/test`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify(input(store, false)) })).status).toBe(403);
    expect(probe).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
