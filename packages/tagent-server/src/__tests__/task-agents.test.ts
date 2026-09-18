import { describe, expect, it, vi } from 'vitest';
import { AgentPool, MemoryPersistence, type AgentCard } from '@tagent/core';
import { ResidentAgentStore } from '../resident-agents.js';
import { TaskAgentStore } from '../task-agents.js';

const setup = async (persistence = new MemoryPersistence()) => {
  const pool = new AgentPool();
  pool.getAgent('document-agent')!.constraints.maxFissionDepth = 2;
  const residents = await ResidentAgentStore.open(persistence, pool);
  return { pool, residents, persistence, tasks: await TaskAgentStore.open(persistence, pool, residents) };
};
const prepare = (pool: AgentPool, parent = 'document-agent') => pool.prepareTaskAgent(parent, {
  name: '材料核对 🚀', objective: '核对中文 / % 与来源', createdReason: '独立材料核对', workspaceId: 'ws', sessionId: 's', runId: 'r',
});
const complete = (agent: AgentCard) => ({ ...structuredClone(agent), spawnMeta: { ...agent.spawnMeta!, status: 'completed' as const,
  completedAt: Date.now(), outputSummary: '摘要', result: { output: '完整中文结果 🚀 / %，未删除长报告', success: true,
    cost: 0.002, iterations: 2, tokens: { input: 120, output: 50 } } } });

describe('durable task Agent lifecycle', () => {
  it('does not write defaults or publish prepared agents; persists only after commit', async () => {
    const { tasks, pool, persistence } = await setup();
    const save = vi.spyOn(persistence, 'save');
    const child = prepare(pool);
    expect(pool.getTaskAgents()).toEqual([]);
    let resolve!: () => void;
    save.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    const writing = tasks.save(child);
    await vi.waitFor(() => expect(resolve).toBeDefined());
    expect(pool.getTaskAgents()).toEqual([]);
    resolve(); await writing;
    expect(pool.getAgent(child.id)?.spawnMeta?.status).toBe('queued');
    expect(pool.getResidentAgents()).toHaveLength(6);
  });

  it('leaves no visible state after a failed write and can save again', async () => {
    const { tasks, pool, persistence } = await setup();
    vi.spyOn(persistence, 'save').mockRejectedValueOnce(new Error('private path'));
    const child = prepare(pool);
    await expect(tasks.save(child)).rejects.toMatchObject({ status: 503 });
    expect(pool.getTaskAgents()).toEqual([]);
    expect(await persistence.load('task-agents', null)).toBeNull();
    await tasks.save(child);
    expect(pool.getTaskAgents()).toHaveLength(1);
  });

  it('restores outputs, inherited configuration and parent-child edges without replay', async () => {
    const { tasks, pool, persistence } = await setup();
    const a = await tasks.save(prepare(pool));
    const b = await tasks.save(prepare(pool, a.id));
    const result = complete(a);
    await tasks.save(result);
    expect(pool.getAgent(a.id)?.childAgentIds).toContain(b.id);
    const restarted = await setup(persistence);
    expect(restarted.pool.getAgent(a.id)).toMatchObject({ capabilities: a.capabilities, constraints: a.constraints,
      spawnMeta: result.spawnMeta, childAgentIds: [b.id], state: { runtime: 'stopped' }, stats: { totalCost: 0.002 } });
    expect(restarted.pool.getAgent(b.id)?.parentAgentId).toBe(a.id);
    expect(restarted.pool.getResidentAgents()).toHaveLength(6);
    expect(restarted.pool.findBestAgentForTask('document', '核对材料')?.type).toBe('resident');
  });

  it('marks only running tasks interrupted, once, and never auto-executes queued tasks', async () => {
    const { tasks, pool, persistence } = await setup();
    const running = prepare(pool); running.spawnMeta!.status = 'running';
    await tasks.save(running);
    const queued = await tasks.save(prepare(pool));
    const save = vi.spyOn(persistence, 'save');
    const restarted = await setup(persistence);
    expect(restarted.pool.getAgent(running.id)).toMatchObject({ spawnMeta: { status: 'interrupted' }, state: { runtime: 'stopped' } });
    expect(restarted.pool.getAgent(queued.id)?.spawnMeta?.status).toBe('queued');
    expect(save).toHaveBeenCalledTimes(1);
    await setup(persistence);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('derives promotion from the committed resident copy after restart, not preview', async () => {
    const { tasks, pool, residents, persistence } = await setup();
    const child = await tasks.save(prepare(pool));
    const draft = pool.createResidentFromTaskAgent(child.id);
    expect(residents.promotedAgentFor(child.id)).toBeUndefined();
    expect(draft.state.runtime).toBe('running');
    expect(draft.card.boundaries.join()).not.toContain('这是任务期子 Agent');
    expect(draft.constraints).toEqual(child.constraints);
    await residents.create(draft, child.id);
    const restarted = await setup(persistence);
    expect(restarted.pool.getAgent(child.id)?.spawnMeta?.promotedAgentId).toBe(draft.id);
    expect(restarted.pool.getAgent(child.id)?.type).toBe('task_spawned');
    expect(restarted.pool.getAgent(draft.id)?.type).toBe('resident');
  });

  it.each(['configuration', 'scope', 'terminal', 'rewind'])('rejects %s changes without overwriting history', async mode => {
    const { tasks, pool, persistence } = await setup();
    const child = prepare(pool); child.spawnMeta!.status = 'running';
    await tasks.save(child);
    if (mode === 'terminal') await tasks.save(complete(child));
    const original = await persistence.load('task-agents', null);
    const edited = structuredClone(pool.getAgent(child.id)!);
    if (mode === 'configuration') edited.constraints.allowedTools.push('dangerous');
    if (mode === 'scope') edited.spawnMeta!.runId = 'other-run';
    if (mode === 'terminal') edited.spawnMeta!.result!.output = 'overwrite';
    if (mode === 'rewind') edited.spawnMeta!.status = 'queued';
    await expect(tasks.save(edited)).rejects.toMatchObject({ status: 409 });
    expect(await persistence.load('task-agents', null)).toEqual(original);
  });

  it.each(['depth', 'missing-parent', 'cross-run', 'false-success'])('rejects corrupt %s histories before publication or recovery writes', async kind => {
    const { tasks, pool, persistence } = await setup();
    const a = await tasks.save(prepare(pool));
    await tasks.save(prepare(pool, a.id));
    const saved = await persistence.load<{ version: number; agents: { meta: Record<string, unknown>; parentAgentId: string }[] }>('task-agents', { version: 1, agents: [] });
    if (kind === 'depth') saved.agents[0]!.meta.depth = '1';
    if (kind === 'missing-parent') saved.agents[1]!.parentAgentId = 'missing';
    if (kind === 'cross-run') saved.agents[1]!.meta.runId = 'other-run';
    if (kind === 'false-success') saved.agents[0]!.meta = { ...complete(a).spawnMeta, status: 'failed' };
    await persistence.save('task-agents', saved);
    const save = vi.spyOn(persistence, 'save');
    const newPool = new AgentPool(), residents = await ResidentAgentStore.open(persistence, newPool);
    await expect(TaskAgentStore.open(persistence, newPool, residents)).rejects.toThrow('历史损坏');
    expect(newPool.getTaskAgents()).toEqual([]); expect(save).not.toHaveBeenCalled();
  });
});
