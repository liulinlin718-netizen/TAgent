import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { AgentPool, FilePersistence, getOfficeBenchmarkTasks, MemoryPersistence } from '@tagent/core';
import type { PersistenceAdapter } from '@tagent/core';
import type { LLMProvider, LLMResponse } from '@tagent/ai';
import { OfficeBenchmarkManager, OfficeBenchmarkStore, createOfficeBenchmarkRoutes } from '../office-benchmarks.js';
import { BenchmarkStore, createBenchmarkRoutes } from '../benchmarks.js';
import { Store } from '../store.js';
import { installAccessControl, resolveAccessConfig } from '../access-control.js';

const roots: string[] = [];
// Independently authored fixture outputs, not grades supplied by the model.
const answers = [
  { currentIds: ['release'], backgroundIds: ['archive'], unverifiedIds: ['rumor'], participants: 42, sourceUrl: 'https://benchmark.invalid/sources' },
  { items: ['资料核对', '排期确认'], locale: 'zh-CN', count: 2 },
  { totalValue: 76, totalStock: 8, receipt: 'INV-731' },
  { tasks: [{ id: 'collect', dependsOn: [], owner: '林' }, { id: 'check', dependsOn: ['collect'], owner: '周' }, { id: 'report', dependsOn: ['check'], owner: '林' }], acceptance: '数据核对后交付报告' },
  { unit: '万元', growthRate: .25, knownTotal: 270, quarterTotal: null, missingMonths: ['6月'] },
  { orders: 420, externalAction: 'none', installed: false },
  { goal: '撰写试点复盘', completed: ['核对12个样本'], risks: ['样本不足'], openQuestions: ['截止日期'], nextAgent: '文档助手' },
  { title: '试点复盘', sections: ['摘要', '材料', '限制', '建议'], sampleSize: 12, recommendation: '扩大样本' },
];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) { const rel = relative(tmpdir(), root); if (rel && !rel.startsWith('..') && !isAbsolute(rel)) await rm(root, { recursive: true, force: true }); }
});
async function setup(persistence: PersistenceAdapter = new MemoryPersistence()) {
  const root = await mkdtemp(join(tmpdir(), 'tagent-live-benchmark-')); roots.push(root);
  const pool = new AgentPool(), agent = structuredClone(pool.getAgent('document-agent')!), tasks = getOfficeBenchmarkTasks(agent);
  const records = await OfficeBenchmarkStore.open(persistence);
  const response = (content: string, toolCalls: LLMResponse['toolCalls'] = []): LLMResponse => ({ content, toolCalls,
    model: 'deepseek-chat', usage: { inputTokens: 100, outputTokens: 20, cost: .0001 }, stopReason: toolCalls.length ? 'tool_use' : 'end' });
  const call = vi.fn<LLMProvider['call']>(async params => {
    const index = tasks.findIndex(task => params.messages.some(message => message.role === 'user' && message.content === task.prompt));
    const url = Object.keys(tasks[index]!.resources)[0];
    if (url && !params.messages.some(message => message.role === 'tool')) return response('', [{ id: 'read-1', name: 'read_url', arguments: JSON.stringify({ url }) }]);
    return response(JSON.stringify(answers[index]));
  });
  const context = { agent, skills: [], provider: { name: 'fixture', call, async *stream() {} } satisfies LLMProvider,
    model: 'deepseek-chat', endpoint: 'http://fixture.invalid', connectionFingerprint: 'private-hash' };
  const manager = new OfficeBenchmarkManager(records, async () => context, join(root, 'traces'));
  const app = createOfficeBenchmarkRoutes(manager);
  const path = '/agents/document-agent/benchmark/live';
  const post = (suffix: string, body: unknown = {}) => app.request(path + suffix, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const preview = async () => (await post('/preview')).json();
  const start = async () => { const consent = await preview(); const res = await post('/start', { confirmed: true, token: consent.token }); expect(res.status).toBe(202); return res.json(); };
  return { root, records, manager, app, path, post, preview, start, context, call, response, persistence, pool };
}
describe('controlled office benchmark admission and lifecycle', () => {
  it('protects consent, starts and history with the existing access and origin boundary', async () => {
    const s = await setup(), app = new Hono(), token = 'local-office-test-token-with-more-than-32-characters';
    installAccessControl(app, resolveAccessConfig({ TAGENT_ACCESS_TOKEN: token }, '127.0.0.1', 3001));
    app.route('/api', s.app);
    const url = 'http://127.0.0.1:3001/api' + s.path;
    const save = vi.spyOn(s.persistence, 'save');
    expect((await app.request(url + '/history')).status).toBe(401);
    for (const suffix of ['/preview', '/start']) {
      expect((await app.request(url + suffix, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
      expect((await app.request(url + suffix, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.invalid' }, body: '{}' })).status).toBe(403);
    }
    expect((await app.request(url + '/preview', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
    expect(s.call).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it('previews and reads without model calls, writes, raw credentials or user history', async () => {
    const s = await setup(), save = vi.spyOn(s.persistence, 'save');
    const preview = await s.preview(); expect(preview.preview.taskCount).toBe(8); expect(preview.tasks).toHaveLength(8);
    expect(preview.endpoint).toBe('http://fixture.invalid'); expect(JSON.stringify(preview)).not.toContain('private-hash');
    await s.app.request(s.path + '/history'); await s.manager.profile(s.context.agent.id);
    expect(s.call).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it.each([{}, { confirmed: false, token: 'x' }, { confirmed: true, token: 'x', output: '100' }, [], null])('rejects invalid confirmation %j', async body => {
    const s = await setup(); expect((await s.post('/start', body)).status).toBe(400); expect(s.call).not.toHaveBeenCalled();
  });
  it.each(['agent', 'endpoint', 'model', 'credentials', 'expired'])('rejects changed or expired %s consent before a model request', async changed => {
    const s = await setup(), consent = await s.preview();
    if (changed === 'agent') s.context.agent.card.soul += 'changed';
    if (changed === 'endpoint') s.context.endpoint += '/new';
    if (changed === 'model') s.context.model = 'new-model';
    if (changed === 'credentials') s.context.connectionFingerprint = 'new-secret-hash';
    if (changed === 'expired') vi.spyOn(Date, 'now').mockReturnValue(consent.expiresAt + 1);
    try { expect((await s.post('/start', { confirmed: true, token: consent.token })).status).toBe(409); expect(s.call).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); }
  });
  it('runs eight tasks, only publishes a matching saved score and leaves config checks estimated', async () => {
    const s = await setup(), started = await s.start(); await s.manager.idle();
    const view = s.manager.get(s.context.agent.id, started.run.id);
    expect(view.run.status).toBe('completed'); expect(view.run.score?.totalScore).toBe(100); expect(view.run.modelCalls).toBe(11);
    expect(view.persistence).toBe('saved'); expect(view.run.events.filter(event => event.type === 'complete')).toHaveLength(1);
    const staticStore = await BenchmarkStore.open(s.persistence), store = await Store.open(s.persistence);
    // The Hall consumes the same profile endpoint; an explicit config check cannot erase measured results.
    const hall = createBenchmarkRoutes(staticStore, s.pool, store, s.manager);
    expect((await (await hall.request('/agents/document-agent/benchmark')).json()).profile.source).toBe('benchmark');
    const checked = await (await hall.request('/agents/document-agent/benchmark/run', { method: 'POST', body: '{}' })).json();
    expect(checked.run.mode).toBe('static_capability'); expect(checked.profile.mode).toBe('controlled_office');
    s.context.endpoint += '/changed'; expect((await s.manager.profile(s.context.agent.id)).profile).toBeUndefined();
    expect((await s.manager.profile(s.context.agent.id)).liveStale).toBe(true);
    expect((await OfficeBenchmarkStore.open(s.persistence)).get(started.run.id)).toEqual(view.run);
  });
  it('admits only one job and consumes confirmation once, including after cancellation', async () => {
    const s = await setup(); s.call.mockImplementationOnce(params => new Promise((_, reject) => params.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })));
    const first = await s.preview(), second = await s.preview();
    const accepted = await s.post('/start', { confirmed: true, token: first.token }); const view = await accepted.json();
    await vi.waitFor(() => expect(s.call).toHaveBeenCalledTimes(1));
    expect((await s.post('/start', { confirmed: true, token: second.token })).status).toBe(409);
    s.manager.cancel(s.context.agent.id, view.run.id); await s.manager.idle();
    const stopped = s.manager.get(s.context.agent.id, view.run.id); expect(stopped.run.status).toBe('interrupted'); expect(stopped.run.score).toBeUndefined();
    expect(stopped.run.usage.unsettledRequests).toBe(1); expect(s.call).toHaveBeenCalledTimes(1);
    expect((await s.post('/start', { confirmed: true, token: first.token })).status).toBe(409);
    expect((await s.app.request(`/agents/research-agent/benchmark/live/runs/${view.run.id}`)).status).toBe(404);
  });
  it('stops on model failure, preserves unknown billing and does not mark it a storage failure', async () => {
    const s = await setup(); s.call.mockRejectedValueOnce(new Error('provider-private-secret'));
    const accepted = await s.start(); await s.manager.idle(); const view = s.manager.get(s.context.agent.id, accepted.run.id);
    expect(view.run.status).toBe('failed'); expect(view.run.score).toBeUndefined(); expect(view.run.usage.unsettledRequests).toBe(1);
    expect(JSON.stringify(view)).not.toContain('provider-private-secret'); expect(s.manager.history(s.context.agent.id).storageFailed).toBe(false);
  });
  it('does not launch when the initial save fails and disables further launches until storage is reconciled', async () => {
    const s = await setup(), consent = await s.preview(); vi.spyOn(s.persistence, 'save').mockRejectedValueOnce(new Error('private-disk-path'));
    expect((await s.post('/start', { confirmed: true, token: consent.token })).status).toBe(503); await s.manager.idle();
    expect(s.call).not.toHaveBeenCalled(); expect(s.manager.history(s.context.agent.id).storageFailed).toBe(true);
    const entry = s.manager.history(s.context.agent.id).runs[0]!; expect(entry.persistence).toBe('failed');
    expect(s.manager.get(s.context.agent.id, entry.id).run.score).toBeUndefined();
    expect((await s.post('/start', { confirmed: true, token: (await s.preview()).token })).status).toBe(503);
  });
  it('keeps received output unsaved after a checkpoint failure without publishing a score', async () => {
    const s = await setup(); let saves = 0;
    const real = s.persistence.save.bind(s.persistence);
    vi.spyOn(s.persistence, 'save').mockImplementation(async (key, value) => { if (++saves === 4) throw new Error('write-failed'); await real(key, value); });
    s.call.mockResolvedValueOnce(s.response('{"partial":"中文草稿"}'));
    const accepted = await s.start(); await s.manager.idle(); const view = s.manager.get(s.context.agent.id, accepted.run.id);
    expect(view.persistence).toBe('failed'); expect(view.run.results[0]!.output).toContain('中文草稿'); expect(s.call).toHaveBeenCalledTimes(1);
    expect((await s.manager.profile(s.context.agent.id)).profile).toBeUndefined(); expect(view.run.score).toBeUndefined();
  });
  it('restores completed UTF-8 output and interrupts a persisted running job without replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tagent-live-file-')); roots.push(root);
    const s = await setup(new FilePersistence(root)); const completed = await s.start(); await s.manager.idle();
    const result = s.manager.get(s.context.agent.id, completed.run.id).run;
    expect((await OfficeBenchmarkStore.open(new FilePersistence(root))).get(result.id)).toEqual(result);
    s.call.mockImplementationOnce(params => new Promise((_, reject) => params.signal!.addEventListener('abort', () => reject(new Error('cancel')), { once: true })));
    const active = await s.start(); await vi.waitFor(() => expect(s.call).toHaveBeenCalledTimes(12));
    const snapshot = await s.persistence.load('office-benchmarks', null), recoveredPersistence = new MemoryPersistence();
    await recoveredPersistence.save('office-benchmarks', snapshot);
    const restored = await OfficeBenchmarkStore.open(recoveredPersistence);
    expect(restored.get(active.run.id)?.status).toBe('interrupted'); expect(restored.get(active.run.id)?.score).toBeUndefined();
    expect(restored.get(active.run.id)?.events.filter(event => event.type === 'complete')).toHaveLength(1);
    s.manager.cancel(s.context.agent.id, active.run.id); await s.manager.idle(); expect(s.call).toHaveBeenCalledTimes(12);
  });
  it('rejects damaged records without overwriting', async () => {
    const persistence = new MemoryPersistence(); await persistence.save('office-benchmarks', { version: 1, runs: [{ score: 100 }] });
    const save = vi.spyOn(persistence, 'save'); await expect(OfficeBenchmarkStore.open(persistence)).rejects.toThrow('未覆盖'); expect(save).not.toHaveBeenCalled();
  });
});
