import { describe, expect, it, vi } from 'vitest';
import { MemoryPersistence } from '@tagent/core';
import type { LLMProvider, LLMResponse } from '@tagent/ai';
import { Store } from '../store.js';
import { createSummaryForkRoutes, recoverSummaryForks, SummaryForkManager, validateSummaryRecord } from '../summary-forks.js';

const reply = (): LLMResponse => ({ model: 'deepseek-chat', stopReason: 'end', toolCalls: [], content: '{"excerpts":[{"messageId":"a","quote":"尚未执行任何操作。"}]}', usage: { inputTokens: 100, outputTokens: 50, cost: .01 } });
async function fixture() {
  const persistence = new MemoryPersistence(), store = await Store.open(persistence), ws = store.listWorkspaces()[0].id;
  const session = (await store.createSession(ws))!.id;
  for (const message of [{ id: 'u', role: 'user' as const, content: '中文🚀：预算1200元，禁止安装。' }, { id: 'a', role: 'assistant' as const, content: '尚未执行任何操作。' }]) await store.addMessage(ws, session, { ...message, timestamp: '2026-09-13' });
  const call = vi.fn<LLMProvider['call']>().mockResolvedValue(reply());
  const manager = new SummaryForkManager(store, () => ({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat', endpoint: 'http://127.0.0.1', connectionFingerprint: 'fixed' }));
  return { persistence, store, ws, session, call, manager };
}
describe('durable summary fork lifecycle', () => {
  it('rejects malformed persisted scalar and nested values with a readable validation error', async () => {
    const f = await fixture(), consent = f.manager.preview(f.ws, f.session, []);
    await f.manager.start(f.ws, f.session, consent.id, consent.token); await f.manager.waitForIdle();
    const saved = f.manager.view(f.ws, f.session, consent.id).record;
    expect(() => validateSummaryRecord(saved)).not.toThrow();
    for (const corrupted of [null, { ...saved, id: 12 }, { ...saved, status: {} }, { ...saved, preview: [] },
      { ...saved, preview: { ...saved.preview, sourceHash: 42 } }, { ...saved, usage: { ...saved.usage, unsettledRequests: '0' } },
      { ...saved, excerpts: [{ ...saved.excerpts![0], role: null }] }]) {
      expect(() => validateSummaryRecord(corrupted)).toThrow(/记录损坏|来源记录无效/);
    }
  });
  it('requires preview/confirmation, preserves selected originals and charges the parent exactly once', async () => {
    const f = await fixture(), save = vi.spyOn(f.persistence, 'save');
    const consent = f.manager.preview(f.ws, f.session, ['u']);
    expect(save).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled();
    await expect(f.manager.start(f.ws, f.session, consent.id, 'bad')).rejects.toThrow('无效');
    const started = await f.manager.start(f.ws, f.session, consent.id, consent.token);
    await f.manager.start(f.ws, f.session, consent.id, consent.token);
    await f.manager.waitForIdle();
    expect(f.call).toHaveBeenCalledTimes(1); expect(f.call.mock.calls[0][0].tools).toBeUndefined();
    const view = f.manager.view(f.ws, f.session, consent.id);
    expect(view).toMatchObject({ persisted: true, record: { status: 'completed', usage: { knownCost: .01, unsettledRequests: 0 } } });
    const child = f.store.getSession(f.ws, started.record.targetSessionId)!;
    expect(child.messages[0].contextKind).toBe('fork_summary'); expect(child.messages[1].id).toBe('u');
    expect(child.totalCost).toBe(0);
    expect(f.store.getSession(f.ws, f.session)?.totalCost).toBe(.01);
    const reopened = await Store.open(f.persistence); expect(await recoverSummaryForks(reopened)).toBe(0);
    expect(reopened.getSession(f.ws, child.id)).toEqual(child);
    await f.manager.start(f.ws, f.session, consent.id, consent.token); expect(f.call).toHaveBeenCalledTimes(1);
  });
  it('saves valid line-heavy excerpts after quote formatting expands their stored size', async () => {
    const f = await fixture();
    const excerpts = [];
    for (let index = 0; index < 4; index++) {
      const message = { id: 'lines-' + index, role: 'assistant' as const, content: String(index) + '\n'.repeat(1499), timestamp: 'now' };
      await f.store.addMessage(f.ws, f.session, message); excerpts.push({ messageId: message.id, quote: message.content });
    }
    f.call.mockResolvedValue({ ...reply(), content: JSON.stringify({ excerpts }) });
    const consent = f.manager.preview(f.ws, f.session, []);
    await f.manager.start(f.ws, f.session, consent.id, consent.token); await f.manager.waitForIdle();
    const result = f.manager.view(f.ws, f.session, consent.id);
    expect(result.record.output!.length).toBeGreaterThan(16000); expect(result.record.status).toBe('completed'); expect(result.persisted).toBe(true);
    const reopened = await Store.open(f.persistence); expect(reopened.listSummaryForks()[0]).toEqual(result.record);
  });
  it('rejects stale previews and simultaneous starts without extra model calls', async () => {
    const f = await fixture(), first = f.manager.preview(f.ws, f.session, []), second = f.manager.preview(f.ws, f.session, []);
    const running = f.manager.start(f.ws, f.session, first.id, first.token);
    await expect(f.manager.start(f.ws, f.session, second.id, second.token)).rejects.toThrow('正在运行');
    await running; await f.manager.waitForIdle();
    const stale = f.manager.preview(f.ws, f.session, []);
    await f.store.addMessage(f.ws, f.session, { id: 'new', role: 'user', content: '新限制', timestamp: 'now' });
    await expect(f.manager.start(f.ws, f.session, stale.id, stale.token)).rejects.toThrow('变化'); expect(f.call).toHaveBeenCalledTimes(1);
  });
  it.each(['empty', 'invalid', 'truncated', 'tool'])('retains charged %s responses without creating a false summary', async mode => {
    const f = await fixture(), response = reply();
    if (mode === 'empty') response.content = '';
    if (mode === 'invalid') response.content = '{"excerpts":[{"messageId":"a","quote":"已成功安装"}]}';
    if (mode === 'truncated') response.stopReason = 'max_tokens';
    if (mode === 'tool') response.toolCalls = [{ id: 'bad', name: 'danger', arguments: '{}' }];
    f.call.mockResolvedValue(response);
    const consent = f.manager.preview(f.ws, f.session, []);
    await f.manager.start(f.ws, f.session, consent.id, consent.token); await f.manager.waitForIdle();
    expect(f.manager.view(f.ws, f.session, consent.id).record).toMatchObject({ status: 'failed', usage: { knownCost: .01 } });
    expect(f.store.listSessions(f.ws)).toHaveLength(1); expect(f.store.getSession(f.ws, f.session)?.totalCost).toBe(.01);
  });
  it.each([{ status: 401, expected: 'authentication' }, { code: 'ECONNRESET', expected: 'connection' }, { code: 'ETIMEDOUT', expected: 'timeout' }])('reports safe model failures %j without exposing credentials', async failure => {
    const f = await fixture(); f.call.mockRejectedValue({ ...failure, message: 'private-key-and-user-prompt' });
    const consent = f.manager.preview(f.ws, f.session, []);
    await f.manager.start(f.ws, f.session, consent.id, consent.token); await f.manager.waitForIdle();
    const result = f.manager.view(f.ws, f.session, consent.id);
    expect(result.record.error).toContain(failure.expected); expect(JSON.stringify(result)).not.toContain('private-key');
    expect(result.record.status).toBe('failed'); expect(result.record.usage.unsettledRequests).toBe(1); expect(f.call).toHaveBeenCalledTimes(1);
  });
  it.each([1, 2])('retries local save after durable step %i fails, without model replay or double billing', async failedStep => {
    const f = await fixture(), save = vi.spyOn(f.persistence, 'save');
    let afterReply = 0;
    f.call.mockImplementation(async () => {
      save.mockRestore(); const original = f.persistence.save.bind(f.persistence);
      vi.spyOn(f.persistence, 'save').mockImplementation(async (key, data) => { if (++afterReply === failedStep) throw new Error('disk full'); return original(key, data); });
      return reply();
    });
    const consent = f.manager.preview(f.ws, f.session, ['u']);
    await f.manager.start(f.ws, f.session, consent.id, consent.token); await f.manager.waitForIdle();
    expect(f.manager.view(f.ws, f.session, consent.id)).toMatchObject({ persisted: false, canRetrySave: true });
    expect(f.store.getSession(f.ws, f.session)?.totalCost).toBe(failedStep === 1 ? 0 : .01);
    await f.manager.retrySave(f.ws, f.session, consent.id);
    expect(f.manager.view(f.ws, f.session, consent.id).record.status).toBe('completed');
    expect(f.store.getSession(f.ws, f.session)?.totalCost).toBe(.01); expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.store.listSessions(f.ws)).toHaveLength(2);
  });
  it('does not call a model before durable admission and blocks normal tasks/deletion while running', async () => {
    const f = await fixture(), consent = f.manager.preview(f.ws, f.session, []);
    vi.spyOn(f.persistence, 'save').mockRejectedValueOnce(new Error('disk full'));
    await expect(f.manager.start(f.ws, f.session, consent.id, consent.token)).rejects.toThrow('disk full'); expect(f.call).not.toHaveBeenCalled();
    const next = f.manager.preview(f.ws, f.session, []);
    f.call.mockImplementation(params => new Promise((_resolve, reject) => params.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    await f.manager.start(f.ws, f.session, next.id, next.token);
    await expect(f.store.beginRun(f.ws, f.session, 'run-conflict', '继续')).rejects.toThrow('运行');
    await expect(f.store.deleteSession(f.ws, f.session)).rejects.toThrow('运行');
    f.manager.cancel(f.ws, f.session, next.id); await f.manager.waitForIdle();
    expect(f.manager.view(f.ws, f.session, next.id).record).toMatchObject({ status: 'interrupted', usage: { unsettledRequests: 1 } });
  });
  it('recovers prepared results by local save only and marks unfinished requests interrupted', async () => {
    const f = await fixture(), complete = vi.spyOn(f.store, 'completeSummaryFork').mockRejectedValueOnce(new Error('disk full'));
    const consent = f.manager.preview(f.ws, f.session, ['u']);
    await f.manager.start(f.ws, f.session, consent.id, consent.token); await f.manager.waitForIdle();
    expect(f.store.listSummaryForks()[0].status).toBe('ready');
    const restarted = await Store.open(f.persistence); expect(await recoverSummaryForks(restarted)).toBe(1); expect(await recoverSummaryForks(restarted)).toBe(0);
    expect(restarted.listSessions(f.ws)).toHaveLength(2); expect(restarted.getSession(f.ws, f.session)?.totalCost).toBe(.01); expect(f.call).toHaveBeenCalledTimes(1);
    complete.mockRestore();
    const record = { ...f.store.listSummaryForks()[0], id: 'sumfork-00000000-0000-0000-0000-000000000000', targetSessionId: 'sess-summary-00000000-0000-0000-0000-000000000000', status: 'running' as const, usage: { input: 0, output: 0, knownCost: 0, pricingKnown: true, unsettledRequests: 1 } };
    await restarted.beginSummaryFork(record);
    const cold = await Store.open(f.persistence); expect(await recoverSummaryForks(cold)).toBe(1); expect(cold.listSummaryForks().at(-1)?.status).toBe('interrupted');
  });
  it('exposes protected-scope routes with explicit consent rather than the old blind summary call', async () => {
    const f = await fixture(), app = createSummaryForkRoutes(f.manager), path = `/workspaces/${f.ws}/sessions/${f.session}`;
    const post = (suffix: string, body: unknown) => app.request(path + suffix, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post('/fork', { forkType: 'fork_summary', confirmed: true })).status).toBe(400);
    const consent = await (await post('/fork/preview', { preservedMessageIds: ['u'] })).json();
    expect((await post('/fork', { forkType: 'fork_summary', confirmed: true, previewId: consent.id, token: consent.token })).status).toBe(202);
    await f.manager.waitForIdle(); expect((await (await app.request(path + '/summary-forks')).json()).operations).toHaveLength(1);
    expect((await app.request(path.replace(f.ws, 'foreign') + '/summary-forks')).status).toBe(404);
  });
});
