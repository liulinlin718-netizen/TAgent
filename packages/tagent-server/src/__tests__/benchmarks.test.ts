import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentPool, FilePersistence, MemoryPersistence, runAgentBenchmark } from '@tagent/core';
import type { PersistenceAdapter } from '@tagent/core';
import { BenchmarkStore, createBenchmarkRoutes } from '../benchmarks.js';
import { Store } from '../store.js';
import { snapshotAgentForWorkflow } from '../workflow-snapshot.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { const rel = relative(tmpdir(), root); if (rel && !rel.startsWith('..') && !isAbsolute(rel)) await rm(root, { recursive: true, force: true }); } });
async function setup(persistence: PersistenceAdapter = new MemoryPersistence()) {
  const pool = new AgentPool(), records = await BenchmarkStore.open(persistence), store = await Store.open(persistence);
  const app = createBenchmarkRoutes(records, pool, store);
  const card = () => structuredClone(pool.getAgent('research-agent')!);
  const post = (body?: unknown) => app.request('/agents/research-agent/benchmark/run', { method: 'POST', headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { pool, records, store, app, card, post, persistence };
}
async function savedRun(context: Awaited<ReturnType<typeof setup>>, options: { smoke?: boolean; running?: boolean; otherAgent?: boolean } = {}) {
  const ws = context.store.listWorkspaces()[0] || await context.store.createWorkspace('评测工作空间');
  const session = await context.store.createSession(ws.id, '中文 来源 🚀');
  const runId = `run-${crypto.randomUUID()}`;
  await context.store.beginRun(ws.id, session!.id, runId, '用户任务');
  if (options.running) return runId;
  const card = options.otherAgent ? context.pool.getAgent('document-agent')! : context.card();
  const trace = (type: string, data: Record<string, unknown> = {}) => ({ type, eventId: `${runId}-${type}`, runId,
    sessionId: session!.id, taskId: 'task-1', agentId: card.id, summary: type, timestamp: Date.now(), data });
  await context.store.finishRun(ws.id, session!.id, runId, {
    ...context.store.findRun(runId)!.message, timestamp: new Date().toISOString(), content: '完整任务输出',
    run: { id: runId, status: 'finished', startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
    traces: [{ ...trace('agent_spawn', { objective: '整理材料' }), agentSnapshot: snapshotAgentForWorkflow(card, 'research') },
      trace('agent_complete', { success: true, outputSummary: '已整理的摘要' }), trace('complete', { success: true, mode: options.smoke ? 'research_smoke' : 'normal' })],
  });
  return runId;
}

describe('benchmark persistence and trusted source routes', () => {
  it('does not write on reads or label a manual config check as an actual task benchmark', async () => {
    const context = await setup(), save = vi.spyOn(context.persistence, 'save');
    const before = structuredClone(context.pool.getAgent('research-agent'));
    await context.app.request('/agents/research-agent/benchmark'); expect(save).not.toHaveBeenCalled();
    const response = await context.post(); expect(response.status).toBe(201);
    const body = await response.json(); expect(body.profile.source).toBe('estimated'); expect(body.run.mode).toBe('static_capability');
    expect(context.pool.getAgent('research-agent')).toEqual(before);
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('restores UTF-8 results through the real file adapter and exposes immutable copies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tagent-benchmark-')); roots.push(root);
    const persistence = new FilePersistence(root), context = await setup(persistence);
    const original = context.card(); original.name = '研究核对 🚀';
    const run = await context.records.save(runAgentBenchmark(original));
    const restored = await BenchmarkStore.open(new FilePersistence(root));
    expect(restored.get(run.runId)).toEqual(run);
    restored.get(run.runId)!.results[0]!.score = 0;
    expect(restored.get(run.runId)).toEqual(run);
    expect(JSON.parse(await readFile(join(root, '.tagent/data/benchmarks.json'), 'utf8')).runs).toHaveLength(1);
  });
  it('publishes only after save, preserves old records on failure and recovers its write queue', async () => {
    const context = await setup(), old = await context.records.save(runAgentBenchmark(context.card()));
    const write = vi.spyOn(context.persistence, 'save');
    let reject!: (reason: Error) => void;
    write.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const pending = context.records.save(runAgentBenchmark(context.card()));
    const assertion = expect(pending).rejects.toMatchObject({ status: 503 });
    await vi.waitFor(() => expect(reject).toBeDefined());
    expect(context.records.list(old.agentId)).toEqual([old]); reject(new Error('private file path')); await assertion;
    expect(context.records.list(old.agentId)).toEqual([old]);
    await context.records.save(runAgentBenchmark(context.card())); expect(context.records.list(old.agentId)).toHaveLength(2);
  });
  it('serializes concurrent writes and marks changed cards stale without deleting history', async () => {
    const context = await setup(); await Promise.all(Array.from({ length: 12 }, () => context.records.save(runAgentBenchmark(context.card()))));
    expect((await BenchmarkStore.open(context.persistence)).list('research-agent')).toHaveLength(12);
    const card = context.card(); card.card.soul += ' 新边界'; expect(context.records.state(card).stale).toBe(true);
    expect(context.records.state(card).profile.runId).toBeUndefined(); expect(context.records.state(card).latestRun).toBeDefined();
  });
  it.each([null, [], { events: [] }, { output: 'verified https://example.com' }, { totalScore: 100 }, { sourceRunId: '../secret' }])('rejects forged assessment input %j', async input => {
    const context = await setup(); const response = await context.post(input);
    expect(response.status).toBe(400); expect(context.records.list('research-agent')).toEqual([]);
  });
  it('uses only same-agent stored run traces and exposes source IDs plus historical checks', async () => {
    const context = await setup(), runId = await savedRun(context);
    const response = await context.post({ sourceRunId: runId }); expect(response.status).toBe(201);
    const result = await response.json(); expect(result.run.evidenceReview.source.runId).toBe(runId);
    expect(result.profile.source).toBe('estimated');
    const sources = await (await context.app.request('/agents/research-agent/benchmark/sources')).json();
    expect(sources.sources.map((source: { runId: string }) => source.runId)).toEqual([runId]);
    expect((await context.app.request(`/benchmarks/runs/${result.run.runId}`)).status).toBe(200);
    const restored = await BenchmarkStore.open(context.persistence); expect(restored.get(result.run.runId)).toEqual(result.run);
  });
  it.each([{ smoke: true }, { running: true }, { otherAgent: true }])('rejects unsuitable stored source %j', async options => {
    const context = await setup(), sourceRunId = await savedRun(context, options);
    const response = await context.post({ sourceRunId }); expect([400, 409]).toContain(response.status);
    expect(context.records.list('research-agent')).toEqual([]);
  });
  it('fails closed on damaged stored records without overwriting them', async () => {
    const persistence = new MemoryPersistence(); await persistence.save('benchmarks', { version: 1, runs: [{ totalScore: 999 }] });
    const save = vi.spyOn(persistence, 'save');
    await expect(BenchmarkStore.open(persistence)).rejects.toThrow('未覆盖'); expect(save).not.toHaveBeenCalled();
  });
});
