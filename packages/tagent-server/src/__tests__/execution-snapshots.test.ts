import { describe, expect, it, vi } from 'vitest';
import { MemoryPersistence, type ExecutionSnapshot } from '@tagent/core';
import { Store } from '../store.js';
import { ExecutionSnapshotStore, createExecutionSnapshotRoutes } from '../execution-snapshots.js';

async function fixture() {
  const persistence = new MemoryPersistence(), store = await Store.open(persistence);
  const workspaceId = store.listWorkspaces()[0]!.id, sessionId = (await store.createSession(workspaceId))!.id;
  await store.beginRun(workspaceId, sessionId, 'run-snapshot', '中文任务：整理已取得材料');
  const snapshots = await ExecutionSnapshotStore.open(persistence, store);
  const snapshot: ExecutionSnapshot = { id: 'snap-fixture', workspaceId, sessionId, runId: 'run-snapshot', agentId: 'research-agent',
    iteration: 2, timestamp: '2026-09-17T10:00:00Z', messages: [
      { role: 'system', content: 'internal-system-prompt' }, { role: 'user', content: '中文任务' },
      { role: 'assistant', content: '尚未综合', toolCalls: [{ id: 'call-1', name: 'web_research', arguments: '{"query":"task"}' }] },
      { role: 'tool', content: '已取得的原文', toolCallId: 'call-1' },
    ] };
  return { persistence, store, snapshots, snapshot, workspaceId, sessionId };
}

describe('durable execution snapshot branches', () => {
  it('persists the actual run scope, omits raw messages from lists and survives reopening', async () => {
    const f = await fixture(); await f.snapshots.save(f.snapshot);
    const reopened = await ExecutionSnapshotStore.open(f.persistence, await Store.open(f.persistence));
    expect(reopened.list(f.workspaceId, f.sessionId)[0]).toMatchObject({ id: 'snap-fixture', messageCount: 4 });
    expect(reopened.list(f.workspaceId, f.sessionId)[0]).not.toHaveProperty('messages');
    expect(reopened.get('snap-fixture')).toEqual(f.snapshot);
  });
  it('requires confirmation and creates one historical-material branch without replay or future messages', async () => {
    const f = await fixture(); await f.snapshots.save(f.snapshot);
    await f.store.addMessage(f.workspaceId, f.sessionId, { id: 'future', role: 'assistant', content: '后续才产生的最终报告', timestamp: '2026-09-17' });
    const routes = createExecutionSnapshotRoutes(f.snapshots, f.store);
    const denied = await routes.request('/snapshots/snap-fixture/fork', { method: 'POST', body: '{}' }); expect(denied.status).toBe(400);
    const first = await routes.request('/snapshots/snap-fixture/fork', { method: 'POST', body: '{"confirmed":true}' });
    const body = await first.json();
    expect(body.willExecute).toBe(false); expect(body.session.parentSessionId).toBe(f.sessionId);
    expect(body.session.messages[0].content).toContain('已取得的原文');
    expect(body.session.messages[0].content).not.toContain('后续才产生');
    expect(body.session.messages[0].content).not.toContain('internal-system-prompt');
    expect(body.session.totalCost).toBe(0);
    const again = await f.store.forkExecutionSnapshot(f.snapshot); expect(again.id).toBe(body.session.id);
    expect(f.store.listSessions(f.workspaceId)).toHaveLength(2);
  });
  it('does not publish failed writes and rejects wrong ownership', async () => {
    const f = await fixture();
    await expect(f.snapshots.save({ ...f.snapshot, sessionId: 'other' })).rejects.toThrow('来源');
    vi.spyOn(f.persistence, 'save').mockRejectedValueOnce(new Error('disk full'));
    await expect(f.snapshots.save(f.snapshot)).rejects.toThrow('disk full'); expect(f.snapshots.get(f.snapshot.id)).toBeUndefined();
  });
  it('does not expose snapshots once their source workspace is removed', async () => {
    const f = await fixture(); await f.snapshots.save(f.snapshot);
    const lookup = vi.spyOn(f.store, 'findRun').mockReturnValue(undefined);
    expect(f.snapshots.get(f.snapshot.id)).toBeUndefined(); expect(f.snapshots.list(f.workspaceId, f.sessionId)).toEqual([]); lookup.mockRestore();
  });
  it('caps retention and rejects oversized snapshots instead of silently truncating a fork', async () => {
    const f = await fixture();
    await expect(f.snapshots.save({ ...f.snapshot, messages: [{ role: 'user', content: 'x'.repeat(530000) }] })).rejects.toThrow('过大');
    for (let index = 0; index < 201; index++) await f.snapshots.save({ ...f.snapshot, id: `snap-${index}` });
    expect(f.snapshots.list(f.workspaceId, f.sessionId)).toHaveLength(200); expect(f.snapshots.get('snap-0')).toBeUndefined();
  });
});
