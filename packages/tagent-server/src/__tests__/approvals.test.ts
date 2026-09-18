import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, ToolApprovalView } from '@tagent/core';
import { ApprovalRegistry } from '../approvals.js';
import { previewToolArguments } from '../tool-arguments.js';
const scope = { runId: 'run-a', sessionId: 'session-a', workspaceId: 'workspace-a', agentId: 'research-agent', taskId: 'task-a' };
async function setup(toolArgs: Record<string, unknown> = { url: 'https://example.com/page' }) {
  const registry = new ApprovalRegistry(), controller = new AbortController(), records: ToolApprovalView[] = [], resolve = vi.fn();
  const request: ApprovalRequest = { requestId: 'approval-test', toolName: 'read_url', mode: 'suggest', createdAt: Date.now(), expiresAt: Date.now() + 120000, toolArgs, resolve };
  const publish = vi.fn(async view => { records.push(structuredClone(view)); });
  await registry.register(scope, request, controller.signal, publish);
  return { registry, controller, request, resolve, publish, records };
}
afterEach(() => vi.useRealTimers());
describe('approval registry and audit-before-execution', () => {
  it('exposes same-run previews and resolves only after the decision is saved', async () => {
    const s = await setup(); expect(s.registry.list(scope.runId, scope.sessionId)).toHaveLength(1); expect(s.resolve).not.toHaveBeenCalled();
    expect(s.registry.list('run-b', scope.sessionId)).toEqual([]);
    let commit!: () => void; s.publish.mockImplementationOnce(() => new Promise(done => { commit = done; }));
    const decision = s.registry.decide(s.request.requestId, { approved: true, ...scope });
    await vi.waitFor(() => expect(commit).toBeDefined()); expect(s.resolve).not.toHaveBeenCalled();
    await expect(s.registry.decide(s.request.requestId, { approved: true, ...scope })).rejects.toMatchObject({ status: 409 });
    commit(); expect((await decision).status).toBe('approved'); expect(s.resolve).toHaveBeenCalledExactlyOnceWith(true);
    expect(s.registry.list(scope.runId, scope.sessionId)).toEqual([]);
    await expect(s.registry.decide(s.request.requestId, { approved: true, ...scope })).rejects.toMatchObject({ status: 404 });
  });
  it('rejects cross-task responses, missing context and truncated approvals', async () => {
    const s = await setup({ command: 'x'.repeat(18000) });
    await expect(s.registry.decide(s.request.requestId, { approved: true, runId: 'run-other', sessionId: scope.sessionId })).rejects.toMatchObject({ status: 409 });
    await expect(s.registry.decide(s.request.requestId, { approved: true })).rejects.toMatchObject({ status: 400 });
    await expect(s.registry.decide(s.request.requestId, { approved: true, ...scope })).rejects.toMatchObject({ status: 400 });
    await s.registry.decide(s.request.requestId, { approved: false, ...scope }); expect(s.resolve).toHaveBeenCalledWith(false);
  });
  it('never resolves true after cancellation or timeout', async () => {
    vi.useFakeTimers(); const s = await setup(); await vi.advanceTimersByTimeAsync(120000);
    expect(s.records.at(-1)?.status).toBe('expired'); expect(s.resolve).toHaveBeenCalledWith(false);
    const other = await setup(); other.controller.abort(); await other.registry.finishRun(scope.runId);
    expect(other.records.at(-1)?.status).toBe('cancelled'); expect(other.resolve).toHaveBeenCalledWith(false);
  });
  it.each(['cancelled', 'expired'])('records %s if permission is revoked during its durable write', async status => {
    vi.useFakeTimers(); const s = await setup();
    let commit!: () => void;
    s.publish.mockImplementationOnce(() => new Promise(done => { commit = done; }));
    if (status === 'expired') vi.setSystemTime(s.request.expiresAt - 100);
    const decision = s.registry.decide(s.request.requestId, { approved: true, ...scope });
    if (status === 'cancelled') s.controller.abort();
    else await vi.advanceTimersByTimeAsync(101);
    commit();
    expect((await decision).status).toBe(status);
    expect(s.records.at(-1)?.status).toBe(status);
    expect(s.resolve).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('fails closed on initial or decision persistence failure', async () => {
    const s = await setup(); s.publish.mockRejectedValueOnce(new Error('disk secret'));
    await expect(s.registry.decide(s.request.requestId, { approved: true, ...scope })).rejects.toMatchObject({ status: 503 });
    expect(s.resolve).toHaveBeenCalledWith(false);
    const registry = new ApprovalRegistry(), resolve = vi.fn();
    await expect(registry.register(scope, { ...s.request, resolve }, new AbortController().signal, async () => { throw new Error('disk'); })).rejects.toMatchObject({ status: 503 });
    expect(resolve).toHaveBeenCalledWith(false); expect(registry.list(scope.runId, scope.sessionId)).toEqual([]);
  });
  it('times out stalled decision writes and never grants execution', async () => {
    vi.useFakeTimers(); const s = await setup(); s.publish.mockImplementationOnce(() => new Promise(() => {}));
    const decision = s.registry.decide(s.request.requestId, { approved: true, ...scope });
    const assertion = expect(decision).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(10000); await assertion; expect(s.resolve).toHaveBeenCalledWith(false);
  });
  it('redacts structured credentials, URL secrets and bounded parameter text', () => {
    const safe = previewToolArguments({ api_key: 'secret-a', nested: { password: 'secret-b' }, env: { VALUE: 'secret-c' },
      url: 'https://user:pass@example.com/path?api_key=secret-d', text: 'Bearer secret-e', command: 'run --token=secret-f --password "secret-g"', accessToken: 'secret-h' });
    expect(safe.redacted).toBe(true); expect(safe.truncated).toBe(false);
    expect(safe.preview).not.toMatch(/secret-[abcdefgh]|user:pass/);
    expect(previewToolArguments({ args: '中文'.repeat(10000) }).truncated).toBe(true);
  });
});
