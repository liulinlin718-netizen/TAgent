import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentPool, FilePersistence, MemoryPersistence } from '@tagent/core';
import type { AgentCard } from '@tagent/core';
import { ResidentAgentStore } from '../resident-agents.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const setup = async () => {
  const pool = new AgentPool(), persistence = new MemoryPersistence();
  const save = vi.spyOn(persistence, 'save');
  const store = await ResidentAgentStore.open(persistence, pool);
  return { pool, persistence, store, save };
};
const copy = (pool: AgentPool, id = 'custom-agent') => ({ ...structuredClone(pool.getAgent('research-agent')!), id, name: '自定义研究 🚀' });

describe('durable resident Agent configuration', () => {
  it('opens defaults without saving or silently installing anything', async () => {
    const { pool, save } = await setup();
    expect(pool.getResidentAgents()).toHaveLength(6);
    expect(pool.getAgent('research-agent')?.configurationRevision).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('restores full UTF-8 cards and bindings through the file adapter, preserving legacy bindings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tagent-resident-')); roots.push(root);
    await mkdir(join(root, '.tagent'), { recursive: true });
    const legacy = JSON.stringify({ 'research-agent': { id: 'research-agent', skills: ['legacy-skill'], mcpServers: ['legacy-mcp'] } });
    await writeFile(join(root, '.tagent', 'agents.json'), legacy, 'utf8');
    const pool = new AgentPool(); await pool.initialize(root);
    const store = await ResidentAgentStore.open(new FilePersistence(root), pool);
    expect(pool.getAgent('research-agent')?.capabilities.skills).toEqual(['legacy-skill']);
    const custom = copy(pool); custom.card.soul = '来源核验与中文 ✓ / %';
    custom.card.qualityChecks = ['核对日期和口径']; custom.constraints.allowedTools = [];
    await store.create(custom);
    await store.update('research-agent', current => ({ ...current, card: { ...current.card, soul: '保存后的 Soul' } }), 0);
    await store.update('research-agent', current => ({ ...current, capabilities: { ...current.capabilities, skills: ['new-skill'] } }), 1);
    const restored = new AgentPool(); await restored.initialize(root);
    await ResidentAgentStore.open(new FilePersistence(root), restored);
    expect(restored.getAgent('custom-agent')).toMatchObject({ name: custom.name, card: { soul: custom.card.soul, qualityChecks: ['核对日期和口径'] }, constraints: { allowedTools: [] } });
    expect(restored.getAgent('research-agent')).toMatchObject({ configurationRevision: 2, card: { soul: '保存后的 Soul' }, capabilities: { skills: ['new-skill'], mcpServers: ['legacy-mcp'] } });
    expect(await readFile(join(root, '.tagent', 'agents.json'), 'utf8')).toBe(legacy);
    const saved = JSON.parse(await readFile(join(root, '.tagent', 'data', 'resident-agents.json'), 'utf8'));
    expect(saved.agents).toHaveLength(2);
  });

  it('keeps pending and failed writes invisible, and recovers its queue after failure', async () => {
    const { store, pool, save, persistence } = await setup();
    const original = structuredClone(pool.getAgent('research-agent'));
    let reject!: (error: Error) => void;
    save.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const failed = store.update('research-agent', current => ({ ...current, name: '不能发布' }), 0);
    const assertion = expect(failed).rejects.toMatchObject({ status: 503, message: expect.stringContaining('原配置仍然有效') });
    await vi.waitFor(() => expect(reject).toBeDefined());
    expect(pool.getAgent('research-agent')).toEqual(original);
    reject(new Error('private disk path and secret'));
    await assertion;
    expect(pool.getAgent('research-agent')).toEqual(original);
    expect(await persistence.load('resident-agents', null)).toBeNull();
    await store.update('research-agent', current => ({ ...current, name: '可以发布' }), 0);
    expect(pool.getAgent('research-agent')?.name).toBe('可以发布');
  });

  it('serializes different Agents and rejects stale edits instead of losing a binding', async () => {
    const { store, pool, persistence } = await setup();
    const results = await Promise.allSettled([
      store.update('research-agent', current => ({ ...current, capabilities: { ...current.capabilities, skills: ['bound-now'] } }), 0),
      store.update('research-agent', current => ({ ...current, name: '过期表单' }), 0),
      store.create(copy(pool)),
    ]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((results[1] as PromiseRejectedResult).reason.status).toBe(409);
    const restarted = new AgentPool(); await ResidentAgentStore.open(persistence, restarted);
    expect(restarted.getAgent('research-agent')?.capabilities.skills).toEqual(['bound-now']);
    expect(restarted.getAgent('custom-agent')).toBeDefined();
  });

  it('merges legacy partial updates against latest committed config, not a stale request snapshot', async () => {
    const { store, pool } = await setup();
    await Promise.all([
      store.update('research-agent', current => ({ ...current, name: '新名称' })),
      store.update('research-agent', current => ({ ...current, capabilities: { ...current.capabilities, mcpServers: ['bound-mcp'] } })),
    ]);
    expect(pool.getAgent('research-agent')).toMatchObject({ name: '新名称', configurationRevision: 2, capabilities: { mcpServers: ['bound-mcp'] } });
  });

  it('does not persist live state, counters, descendants or benchmark assertions as configuration', async () => {
    const { store, pool, persistence } = await setup();
    const release = pool.beginExecution('research-agent');
    const child = pool.spawnTaskAgent('research-agent', { name: '临时协作', objective: '只读', createdReason: '测试' });
    pool.getAgent('research-agent')!.stats.totalCost = 3;
    const saved = await store.update('research-agent', current => ({ ...current, name: '执行中编辑' }), 0);
    expect(saved.state.business).toBe('busy'); expect(saved.childAgentIds).toContain(child.id);
    release(); expect(pool.getAgent('research-agent')!.state.business).toBe('idle');
    const restarted = new AgentPool(); await ResidentAgentStore.open(persistence, restarted);
    expect(restarted.getAgent('research-agent')).toMatchObject({ state: { business: 'idle', orchestration: 'none' }, stats: { totalCost: 0 }, childAgentIds: [] });
    expect(restarted.getTaskAgents()).toHaveLength(0);
    saved.card.soul = 'mutable response';
    expect(pool.getAgent(saved.id)!.card.soul).not.toBe(saved.card.soul);
    const candidate = copy(pool); candidate.card.scoreProfile.benchmarkScore = { source: 'benchmark', totalScore: 100, dimensions: {} };
    await store.create(candidate);
    expect(JSON.stringify(await persistence.load('resident-agents', null))).not.toContain('benchmarkScore');
  });

  it('copies a task Agent only after explicit save; failed promotion leaves source and resident pool unchanged', async () => {
    const { store, pool, persistence, save } = await setup();
    const child = pool.spawnTaskAgent('research-agent', { name: '任务子 Agent', objective: '测试保存', createdReason: '有独立任务', sessionId: 's', runId: 'r' });
    const before = structuredClone(child);
    const draft = pool.createResidentFromTaskAgent(child.id);
    expect(save).not.toHaveBeenCalled(); expect(pool.getResidentAgents()).toHaveLength(6);
    save.mockRejectedValueOnce(new Error('disk failed'));
    await expect(store.create(draft, child.id)).rejects.toMatchObject({ status: 503 });
    expect(child).toEqual(before); expect(pool.getAgent(draft.id)).toBeUndefined();
    const saved = await store.create(draft, child.id);
    expect(child.type).toBe('task_spawned'); expect(child.spawnMeta?.promotedAgentId).toBe(saved.id);
    expect(saved).toMatchObject({ type: 'resident', parentAgentId: null, childAgentIds: [], state: { business: 'idle' } });
    expect(saved.spawnMeta).toBeUndefined();
    const restarted = new AgentPool(); await ResidentAgentStore.open(persistence, restarted);
    expect(restarted.getAgent(saved.id)?.card.soul).toContain('测试保存');
    expect(restarted.getAgent(child.id)).toBeUndefined();
    expect(await persistence.load('resident-agents', null)).toMatchObject({ agents: [{ source: { taskAgentId: child.id, sessionId: 's', runId: 'r' } }] });
  });

  it('rejects ID collisions, missing targets and direct task conversion', async () => {
    const { store, pool, save } = await setup();
    await expect(store.create(copy(pool, 'research-agent'))).rejects.toMatchObject({ status: 409 });
    await expect(store.update('missing', current => current)).rejects.toMatchObject({ status: 404 });
    const child = pool.spawnTaskAgent('research-agent', { name: '子任务', objective: '只读', createdReason: '测试' });
    await expect(store.update(child.id, current => ({ ...current, type: 'resident' }))).rejects.toMatchObject({ status: 400 });
    await expect(store.create(copy(pool), 'missing-child')).rejects.toMatchObject({ status: 400 });
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    (card: AgentCard) => { card.name = ' '; },
    (card: AgentCard) => { card.id = '../escape'; },
    (card: AgentCard) => { card.capabilities.skills = 'bad' as unknown as string[]; },
    (card: AgentCard) => { card.constraints.allowedTools = null as unknown as string[]; },
    (card: AgentCard) => { card.constraints.maxCostPerTask = -1; },
    (card: AgentCard) => { card.constraints.maxCostPerTask = NaN; },
    (card: AgentCard) => { card.constraints.maxFissionDepth = 2.5; },
    (card: AgentCard) => { card.card.scoreProfile.research = 101; },
    (card: AgentCard) => { card.card.runtimeProfile.stages = ['shell'] as never; },
    (card: AgentCard) => { card.card.qualityChecks = [5] as never; },
  ])('rejects malformed config before any storage or pool change', async mutate => {
    const { store, pool, save } = await setup();
    const card = copy(pool); mutate(card);
    await expect(store.create(card)).rejects.toMatchObject({ status: 400 });
    expect(save).not.toHaveBeenCalled(); expect(pool.getResidentAgents()).toHaveLength(6);
  });

  it('rejects damaged or duplicate storage before publishing any configuration', async () => {
    const { store, pool, persistence } = await setup();
    await store.create(copy(pool));
    const good = await persistence.load<{ version: number; agents: unknown[] }>('resident-agents', { version: 1, agents: [] });
    for (const value of [{ version: 9, agents: [] }, { version: 1, agents: [...good.agents, {}] }, { ...good, agents: [...good.agents, ...good.agents] }]) {
      await persistence.save('resident-agents', value);
      const restarted = new AgentPool(), before = structuredClone(restarted.getAllAgents());
      await expect(ResidentAgentStore.open(persistence, restarted)).rejects.toThrow('未覆盖现有配置');
      expect(restarted.getAllAgents()).toEqual(before);
      expect(await persistence.load('resident-agents', null)).toEqual(value);
    }
  });
});
