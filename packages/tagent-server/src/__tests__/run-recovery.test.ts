import { describe, expect, it, vi } from 'vitest';
import { MemoryPersistence, type OfficeDeliveryResult, type ResearchSource } from '@tagent/core';
import type { LLMProvider } from '@tagent/ai';
import { ActiveRunError, Store, type ChatMessage, type TraceEvent } from '../store.js';
import { recoverInterruptedRuns, RunJournal } from '../run-journal.js';

const runId = 'run-recovery-test';
const text = '中文任务 🚀 / Docker? 保留原文';
async function setup() {
  const persistence = new MemoryPersistence();
  const store = await Store.open(persistence);
  const workspaceId = store.listWorkspaces()[0]!.id;
  const sessionId = (await store.createSession(workspaceId))!.id;
  const traces: TraceEvent[] = [];
  const failure = vi.fn();
  const journal = new RunJournal(persistence, runId, workspaceId, sessionId, traces, failure);
  return { persistence, store, workspaceId, sessionId, traces, failure, journal };
}

function model(): LLMProvider {
  return { name: 'fixture', call: vi.fn(async () => ({ content: '未核验草稿', toolCalls: [], model: 'fixture',
    stopReason: 'end' as const, usage: { cost: 0.12, inputTokens: 200, outputTokens: 30 } })),
  async *stream() {} };
}

function officeProgress(revision = false): OfficeDeliveryResult {
  const pending = { requestId: 'request-fixture-review', status: 'pending' as const, inputCharacters: 1200, maxOutputTokens: 4096, unsettledRequests: 1 };
  return { output: '已保存的办公原稿', review: { version: 1, model: 'fixture', checkedAt: '2026-09-13T00:00:00Z',
    status: revision ? 'needs_revision' : 'unverified', materialCount: 1, checks: revision ? [{ id: 'math', method: 'programmatic', status: 'failed', label: '计算', reason: '总额错误' }] : [],
    issues: [], coverage: { expectedBlocks: 1, checkedBlocks: revision ? 1 : 0 },
    receipt: revision ? { ...pending, status: 'received', rawOutput: '已收到第一次核对', unsettledRequests: 0 } : pending,
    ...(revision ? { revisionAttempt: { ...pending, requestId: 'request-fixture-revision', maxOutputTokens: 6144 } } : {}) } };
}

function finalMessage(store: Store, sessionId: string): ChatMessage {
  const receipt = store.findRun(runId)!.message;
  return { ...receipt, content: '## 完整交付物\n\n中文 ✅', cost: 0.12, tokens: { input: 200, output: 30 },
    run: { ...receipt.run!, status: 'finished', completedAt: new Date().toISOString() },
    traces: [{ eventId: 'final', type: 'complete', runId, sessionId, timestamp: Date.now(),
      summary: '完成', status: 'complete', data: { success: true } }] };
}

describe('run crash recovery', () => {
  it('recovers the original task day in Shanghai after a restart on another day', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-14T16:30:00Z'));
    try {
      const { store, persistence, workspaceId, sessionId, journal } = await setup();
      await store.beginRun(workspaceId, sessionId, runId, '调研今天的AI资讯');
      const source: ResearchSource = { id: 'old', title: 'Old AI Agent news', url: 'https://publisher.example/old', query: 'AI Agent',
        retrievedAt: '2026-09-15', publication: { basis: 'publication_metadata', date: '2026-09-14' },
        readable: true, relevant: true, publisher: 'unverified', excerpt: 'Older material, not today evidence.' };
      journal.setSources([source]); await journal.flush();
      vi.setSystemTime(new Date('2026-09-16T01:00:00Z'));
      const reopened = await Store.open(persistence); await recoverInterruptedRuns(reopened, persistence);
      expect(reopened.getMessages(workspaceId, sessionId).at(-1)?.research?.assessment).toMatchObject({
        researchDate: '2026-09-15', windowStart: '2026-09-15', datedSourceCount: 0, status: 'insufficient_evidence',
      });
    } finally { vi.useRealTimers(); }
  });
  it.each([false, true])('persists an office %s receipt with usage before returning a model response to Core', async revision => {
    const { store, persistence, workspaceId, sessionId, journal } = await setup();
    await store.beginRun(workspaceId, sessionId, runId, text);
    const progress = officeProgress(revision);
    await journal.setOfficeDelivery(progress);
    progress.output = 'mutated outside journal';
    const fixture = model();
    await journal.provider(fixture).call({ model: 'fixture', messages: [], ...(revision ? {} : { purpose: 'verification' as const }) });
    // No Core progress/final callback: simulate a crash at the SDK-return boundary.
    const reopened = await Store.open(persistence);
    await recoverInterruptedRuns(reopened, persistence);
    const recovered = reopened.getMessages(workspaceId, sessionId).at(-1)!;
    expect(recovered.run?.status).toBe('interrupted');
    expect(recovered.deliveryReview?.status).toBe('unverified');
    expect(recovered.deliveryReview?.[revision ? 'revisionAttempt' : 'receipt']).toMatchObject({ status: 'received', rawOutput: '未核验草稿', usage: { cost: .12 }, unsettledRequests: 0 });
    expect(recovered.content).toContain('已保存的办公原稿');
    expect(recovered.content).not.toContain('mutated outside journal');
    expect(recovered.content).not.toContain('未核验草稿');
    expect(recovered.cost).toBe(.12);
    expect(await recoverInterruptedRuns(await Store.open(persistence), persistence)).toBe(0);
    expect((await Store.open(persistence)).getMessages(workspaceId, sessionId).at(-1)).toEqual(recovered);
    expect(fixture.call).toHaveBeenCalledTimes(1);
  });

  it('recovers pending recheck state with both drafts and the previous receipt, never a passing final', async () => {
    const { store, persistence, workspaceId, sessionId, journal } = await setup();
    await store.beginRun(workspaceId, sessionId, runId, text);
    const original = officeProgress(true), current = officeProgress();
    original.review.model = current.review.model = 'deepseek-v4-pro';
    original.review.reasoning = current.review.reasoning = 'low';
    original.review.revisionAttempt = { ...original.review.revisionAttempt!, status: 'received', rawOutput: '修订后的正文', unsettledRequests: 0 };
    current.output = '修订后的正文'; current.review.previous = original;
    await journal.setOfficeDelivery(current);
    const reopened = await Store.open(persistence); await recoverInterruptedRuns(reopened, persistence);
    const answer = reopened.getMessages(workspaceId, sessionId).at(-1)!;
    expect(answer.content).toContain(current.output);
    expect(answer.deliveryReview).toMatchObject({ status: 'unverified', model: 'deepseek-v4-pro', reasoning: 'low',
      receipt: { status: 'pending', unsettledRequests: 1 }, previous: original });
    expect(answer.cost).toBe(0);
    expect(answer.content).toContain('可能仍被计费');
  });

  it('keeps a charged receipt in the in-memory final result even if the receipt checkpoint fails', async () => {
    const { journal, persistence, failure } = await setup();
    await journal.setOfficeDelivery(officeProgress());
    vi.spyOn(persistence, 'save').mockRejectedValueOnce(new Error('disk full'));
    await expect(journal.provider(model()).call({ model: 'fixture', messages: [], purpose: 'verification' })).rejects.toThrow('disk full');
    const failed = officeProgress(); failed.review.receipt!.status = 'request_failed';
    await journal.setOfficeDelivery(failed);
    const result = journal.withKnownUsage({ success: false, output: '任务停止', termination: 'storage_failure', totalCost: 0, totalTokens: { input: 0, output: 0 }, subResults: [] });
    expect(result.deliveryReview?.receipt).toMatchObject({ rawOutput: '未核验草稿', usage: { cost: .12 } });
    expect(result.deliveryReview?.status).toBe('unverified'); expect(result.totalCost).toBe(.12); expect(failure).toHaveBeenCalledTimes(1);
  });

  it('never borrows a completed receipt for a later pending request', async () => {
    const { journal } = await setup();
    await journal.setOfficeDelivery(officeProgress());
    await journal.provider(model()).call({ model: 'fixture', messages: [], purpose: 'verification' });
    const next = officeProgress(); next.review.receipt!.requestId = 'different-request';
    await journal.setOfficeDelivery(next);
    const result = journal.withKnownUsage({ success: false, output: '', termination: 'cancelled', subResults: [], totalCost: 0, totalTokens: { input: 0, output: 0 } });
    expect(result.deliveryReview?.receipt).toEqual(next.review.receipt);
    expect(result.deliveryReview?.receipt?.rawOutput).toBeUndefined();
  });

  it.each(['checks', 'previous', 'receipt', 'coverage', 'reasoning'])('rejects a corrupt office %s checkpoint without replay or overwriting the evidence', async field => {
    const { store, persistence, workspaceId, sessionId, journal } = await setup();
    await store.beginRun(workspaceId, sessionId, runId, text);
    await journal.setOfficeDelivery(officeProgress());
    const key = `checkpoint-${runId}`;
    const checkpoint = await persistence.load<{ officeDelivery: { review: Record<string, unknown> } }>(key, { officeDelivery: { review: {} } });
    checkpoint.officeDelivery.review[field] = field === 'checks' ? [{ status: 'passed' }]
      : field === 'previous' ? { output: 'bad', review: { previous: {} } }
      : field === 'coverage' ? { expectedBlocks: 1, checkedBlocks: 2 } : field === 'reasoning' ? 'unsupported' : { status: 'received', usage: { cost: 'not-a-number' } };
    await persistence.save(key, checkpoint);
    const reopened = await Store.open(persistence); await recoverInterruptedRuns(reopened, persistence);
    const answer = reopened.getMessages(workspaceId, sessionId).at(-1)!;
    expect(answer.deliveryReview).toBeUndefined(); expect(answer.content).toContain('检查点无法读取');
    expect(await persistence.load(key, null)).toEqual(checkpoint);
  });

  it('atomically rejects concurrent admission and refuses to overlap a persisted unfinished run', async () => {
    const { store, persistence, workspaceId, sessionId } = await setup();
    const attempts = await Promise.allSettled([
      store.beginRun(workspaceId, sessionId, runId, text),
      store.beginRun(workspaceId, sessionId, 'run-another-request', 'duplicate task'),
    ]);
    expect(attempts[0].status).toBe('fulfilled');
    expect(attempts[1]).toMatchObject({ status: 'rejected', reason: expect.any(ActiveRunError) });
    const reopened = await Store.open(persistence);
    expect(reopened.getMessages(workspaceId, sessionId)).toHaveLength(2);
    await expect(reopened.beginRun(workspaceId, sessionId, 'run-before-recovery', 'not safe yet')).rejects.toBeInstanceOf(ActiveRunError);
    await recoverInterruptedRuns(reopened, persistence);
    await reopened.beginRun(workspaceId, sessionId, 'run-after-recovery', 'explicit new task');
    expect(reopened.getMessages(workspaceId, sessionId)).toHaveLength(4);
  });

  it.each(['call', 'stream'] as const)('keeps the report draft separate from internal %s verification while saving paid usage', async method => {
    const { store, persistence, workspaceId, sessionId, journal } = await setup();
    await store.beginRun(workspaceId, sessionId, runId, text);
    journal.setDraft('用户的完整报告草稿');
    const internal = '{"areas":["INTERNAL_VERIFICATION_ONLY"]}';
    const fixture: LLMProvider = { name: 'fixture', call: async () => ({ content: internal, toolCalls: [], model: 'fixture', stopReason: 'end',
      usage: { cost: 0.02, inputTokens: 40, outputTokens: 20 } }),
      async *stream() { yield { type: 'text_delta', content: internal }; yield { type: 'usage', usage: { cost: 0.02, inputTokens: 40, outputTokens: 20 } }; yield { type: 'done' }; } };
    const wrapped = journal.provider(fixture), params = { model: 'fixture', messages: [], purpose: 'verification' as const };
    if (method === 'call') await wrapped.call(params);
    else { for await (const event of wrapped.stream(params)) { expect(event).toBeDefined(); } }
    const reopened = await Store.open(persistence);
    await recoverInterruptedRuns(reopened, persistence);
    const recovered = reopened.getMessages(workspaceId, sessionId).at(-1)!;
    expect(recovered.content).toContain('用户的完整报告草稿');
    expect(recovered.content).not.toContain('INTERNAL_VERIFICATION_ONLY');
    expect(recovered.cost).toBe(0.02); expect(recovered.tokens).toEqual({ input: 40, output: 20 });
  });

  it('preserves final office review and the rejected original across commit recovery and a second reload', async () => {
    const { store, persistence, workspaceId, sessionId, journal } = await setup();
    await store.beginRun(workspaceId, sessionId, runId, text);
    const answer = finalMessage(store, sessionId);
    const review = { version: 1 as const, status: 'needs_revision' as const, model: 'fixture', checkedAt: '2026-09-12T00:00:00Z',
      checks: [{ id: 'calculation-0', method: 'programmatic' as const, status: 'failed' as const, label: '算术', reason: '总额错误' }], issues: [], materialCount: 1 };
    answer.deliveryReview = { ...review, previous: { output: '未通过的原始报告', review } };
    answer.traces![0].data.success = false; answer.traces![0].status = 'failed';
    await journal.prepareFinal(answer);
    await recoverInterruptedRuns(await Store.open(persistence), persistence);
    const restored = (await Store.open(persistence)).getMessages(workspaceId, sessionId).at(-1)!;
    expect(restored).toEqual(answer);
    expect(restored.deliveryReview?.previous?.output).toBe('未通过的原始报告');
  });

  it('atomically saves the question and receipt, or neither on failure', async () => {
    const { store, persistence, workspaceId, sessionId } = await setup();
    vi.spyOn(persistence, 'save').mockRejectedValueOnce(new Error('disk full'));
    await expect(store.beginRun(workspaceId, sessionId, runId, text)).rejects.toThrow('disk full');
    expect(store.getMessages(workspaceId, sessionId)).toEqual([]);
    await store.beginRun(workspaceId, sessionId, runId, text);
    expect((await Store.open(persistence)).getMessages(workspaceId, sessionId)).toMatchObject([
      { role: 'user', content: text }, { role: 'assistant', run: { id: runId, status: 'running' } },
    ]);
    await expect(store.beginRun(workspaceId, sessionId, runId, 'duplicate')).rejects.toThrow('exists');
    expect(() => store.beginRun(workspaceId, sessionId, '../outside', text)).toThrow('Invalid run');
  });

  it('recovers a run that crashed immediately after acceptance without fabricating evidence or zero billing', async () => {
    const { store, persistence, workspaceId, sessionId } = await setup();
    await store.beginRun(workspaceId, sessionId, runId, text);
    const reopened = await Store.open(persistence);
    expect(await recoverInterruptedRuns(reopened, persistence)).toBe(1);
    const messages = reopened.getMessages(workspaceId, sessionId);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe(text);
    expect(messages[1]?.content).toContain('尚未保存可用的中间材料');
    expect(messages[1]?.content).toContain('可能仍被计费');
    expect(messages[1]?.run?.status).toBe('interrupted');
    expect(messages[1]?.traces).toHaveLength(1);
    expect(messages[1]?.traces?.[0]?.data).toMatchObject({ termination: 'interrupted', success: false });
    expect(await recoverInterruptedRuns(reopened, persistence)).toBe(0);
  });

  it('retains paid usage, complete child output, source passages and exact trace after recovery', async () => {
    const { store, persistence, workspaceId, sessionId, journal, traces } = await setup();
    await store.beginRun(workspaceId, sessionId, runId, text);
    traces.push({ eventId: 'tool', type: 'agent_tool_result', runId, sessionId,
      timestamp: 123, data: { tool: 'web_research' }, summary: '已获取原文' });
    journal.addArtifact('research-agent', '完整子任务资料\n'.repeat(400), 'research-task');
    const source: ResearchSource = { id: 's1', url: 'https://example.org/source', title: '原文来源', query: '最新',
      retrievedAt: '2026-09-12', publication: { basis: 'publication_metadata', date: '2026-09-01' },
      readable: true, relevant: true, publisher: 'unverified', excerpt: '来源材料待核验', passages: ['完整原文段落'] };
    journal.setSources([source]);
    const provider = model();
    await journal.provider(provider).call({ model: 'fixture', messages: [] });
    const reopened = await Store.open(persistence);
    await recoverInterruptedRuns(reopened, persistence);
    const message = reopened.getMessages(workspaceId, sessionId).at(-1)!;
    expect(message.content).toContain('完整子任务资料\n'.repeat(400));
    expect(message.content).toContain('未核验草稿');
    expect(message.research?.sources).toEqual([source]);
    expect(message.research?.assessment.status).toBe('insufficient_evidence');
    expect(message.cost).toBe(0.12);
    expect(message.tokens).toEqual({ input: 200, output: 30 });
    expect(message.traces?.[0]).toEqual(traces[0]);
    expect(message.traces?.at(-1)?.runId).toBe(runId);
    expect(await persistence.load(`checkpoint-${runId}`, null)).toBeNull();
    await recoverInterruptedRuns(reopened, persistence);
    expect(reopened.getSession(workspaceId, sessionId)?.totalCost).toBe(0.12);
    expect(provider.call).toHaveBeenCalledTimes(1);
  });

  it('replays only a prepared final store commit, preserving message ID, order and cost exactly once', async () => {
    const { store, persistence, workspaceId, sessionId, journal } = await setup();
    await store.beginRun(workspaceId, sessionId, runId, text);
    // Legacy versions allowed overlapping receipts. Recovery must still read them,
    // although new admissions now reject starting a second run in this session.
    const timestamp = new Date().toISOString();
    await store.addMessage(workspaceId, sessionId, { id: 'run-second-user', role: 'user', content: '第二个问题', timestamp });
    await store.addMessage(workspaceId, sessionId, { id: 'run-second-assistant', role: 'assistant', content: '待恢复', timestamp,
      run: { id: 'run-second', status: 'running', startedAt: timestamp } });
    const answer = finalMessage(store, sessionId);
    await journal.prepareFinal(answer);
    const reopened = await Store.open(persistence);
    await recoverInterruptedRuns(reopened, persistence);
    expect(reopened.getMessages(workspaceId, sessionId)[1]).toEqual(answer);
    expect(reopened.getMessages(workspaceId, sessionId)[2]?.content).toBe('第二个问题');
    await reopened.finishRun(workspaceId, sessionId, runId, answer);
    await recoverInterruptedRuns(await Store.open(persistence), persistence);
    expect(reopened.getSession(workspaceId, sessionId)?.totalCost).toBe(0.12);
    expect(reopened.getMessages(workspaceId, sessionId)).toHaveLength(4);
  });

  it('does not alter a completed report when a stale checkpoint remains after final save', async () => {
    const { store, persistence, workspaceId, sessionId, journal } = await setup();
    await store.beginRun(workspaceId, sessionId, runId, text);
    const answer = finalMessage(store, sessionId);
    await journal.prepareFinal(answer);
    await store.finishRun(workspaceId, sessionId, runId, answer);
    const reopened = await Store.open(persistence);
    expect(await recoverInterruptedRuns(reopened, persistence)).toBe(0);
    expect(reopened.getMessages(workspaceId, sessionId).at(-1)).toEqual(answer);
    expect(await persistence.load(`checkpoint-${runId}`, null)).toBeNull();
  });

  it('preserves unreadable or cross-session checkpoints instead of mixing tasks', async () => {
    const { store, persistence, workspaceId, sessionId, journal } = await setup();
    await store.beginRun(workspaceId, sessionId, runId, text);
    await journal.checkpoint();
    const bad = { ...(await persistence.load<Record<string, unknown>>(`checkpoint-${runId}`, {})), sessionId: 'another-session' };
    await persistence.save(`checkpoint-${runId}`, bad);
    await recoverInterruptedRuns(store, persistence);
    expect(store.getMessages(workspaceId, sessionId).at(-1)?.content).toContain('检查点无法读取');
    await recoverInterruptedRuns(await Store.open(persistence), persistence);
    expect(await persistence.load(`checkpoint-${runId}`, null)).toEqual(bad);
  });

  it('leaves pending receipt and checkpoint intact if recovery cannot save', async () => {
    const { store, persistence, workspaceId, sessionId, journal } = await setup();
    await store.beginRun(workspaceId, sessionId, runId, text);
    await journal.checkpoint();
    vi.spyOn(persistence, 'save').mockRejectedValueOnce(new Error('unavailable'));
    await expect(recoverInterruptedRuns(store, persistence)).rejects.toThrow('unavailable');
    expect(store.findRun(runId)?.message.run?.status).toBe('running');
    expect(await persistence.load(`checkpoint-${runId}`, null)).not.toBeNull();
    expect(await recoverInterruptedRuns(store, persistence)).toBe(1);
  });

  it('never treats legacy history or a full fork as an owned unfinished run', async () => {
    const { store, persistence, workspaceId, sessionId } = await setup();
    await store.addMessage(workspaceId, sessionId, { id: 'legacy', role: 'user', content: '历史未回复问题', timestamp: 'old' });
    await store.beginRun(workspaceId, sessionId, runId, text);
    await expect(store.forkSession(workspaceId, sessionId, 'fork_full')).rejects.toBeInstanceOf(ActiveRunError);
    const reopened = await Store.open(persistence);
    expect(await recoverInterruptedRuns(reopened, persistence)).toBe(1);
    const fork = (await reopened.forkSession(workspaceId, sessionId, 'fork_full'))!;
    expect(fork.messages.every(message => !message.run)).toBe(true);
    expect(await recoverInterruptedRuns(reopened, persistence)).toBe(0);
    expect(reopened.getMessages(workspaceId, fork.id)).toEqual(fork.messages);
    expect(reopened.getMessages(workspaceId, sessionId)[0]?.content).toBe('历史未回复问题');
  });

  it('prevents deleting a workspace/session owning an unfinished run', async () => {
    const { store, persistence, workspaceId, sessionId } = await setup();
    await store.beginRun(workspaceId, sessionId, runId, text);
    await expect(store.deleteSession(workspaceId, sessionId)).rejects.toBeInstanceOf(ActiveRunError);
    await expect(store.deleteWorkspace(workspaceId)).rejects.toBeInstanceOf(ActiveRunError);
    await recoverInterruptedRuns(store, persistence);
    expect(await store.deleteSession(workspaceId, sessionId)).toBe(true);
  });

  it('stops on checkpoint failure and forbids another model call, without losing received usage', async () => {
    const { persistence, journal, failure } = await setup();
    const provider = model();
    vi.spyOn(persistence, 'save').mockRejectedValueOnce(new Error('disk full'));
    await expect(journal.provider(provider).call({ model: 'fixture', messages: [] })).rejects.toThrow('disk full');
    await expect(journal.provider(provider).call({ model: 'fixture', messages: [] })).rejects.toThrow('disk full');
    expect(provider.call).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledOnce();
    expect(journal.withKnownUsage({ success: false, output: '', subResults: [], totalCost: 0,
      totalTokens: { input: 0, output: 0 } }).totalCost).toBe(0.12);
  });
});
