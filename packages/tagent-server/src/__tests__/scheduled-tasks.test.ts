import { describe, expect, it, vi } from 'vitest';
import { MemoryPersistence } from '@tagent/core';
import { Store } from '../store.js';
import { ScheduledTaskManager, createScheduleRoutes } from '../scheduled-tasks.js';

async function fixture() {
  const persistence = new MemoryPersistence(), store = await Store.open(persistence);
  const manager = await ScheduledTaskManager.open(persistence, store), workspaceId = store.listWorkspaces()[0]!.id;
  const now = Date.parse('2026-09-17T00:00:00Z');
  const input = { name: '每日报告', workspaceId, taskMessage: '研究公开资料，等待用户发送。',
    nextRun: now + 60000, intervalMs: 60000, enabled: true, execution: 'confirm_each_run', confirmed: true };
  return { persistence, store, manager, workspaceId, now, input };
}

describe('durable, user-confirmed recurring task preparation', () => {
  it('rejects automatic execution and missing confirmation without storing a job', async () => {
    const f = await fixture();
    expect(() => f.manager.save({ ...f.input, confirmed: false }, undefined, f.now)).toThrow('确认');
    expect(() => f.manager.save({ ...f.input, execution: 'automatic' }, undefined, f.now)).toThrow('确认');
    expect(f.manager.list().jobs).toEqual([]);
  });
  it('coalesces missed periods and survives restart without creating or running a session', async () => {
    const f = await fixture(); await f.manager.save(f.input, undefined, f.now);
    await f.manager.tick(f.now + 60000 * 100);
    await f.manager.tick(f.now + 60000 * 110);
    expect(f.manager.list().occurrences).toHaveLength(1); expect(f.store.listSessions(f.workspaceId)).toEqual([]);
    const reopened = await ScheduledTaskManager.open(f.persistence, f.store);
    expect(reopened.list().occurrences[0]!.status).toBe('pending');
    expect(reopened.list().jobs[0]!.nextRun).toBeGreaterThan(f.now + 60000 * 110);
  });
  it('prepares one empty session only after confirmation and preserves original task content', async () => {
    const f = await fixture(); await f.manager.save(f.input, undefined, f.now); await f.manager.tick(f.input.nextRun);
    const id = f.manager.list().occurrences[0]!.id, routes = createScheduleRoutes(f.manager);
    expect((await routes.request(`/cron/occurrences/${id}/prepare`, { method: 'POST', body: '{}' })).status).toBe(400);
    const first = await f.manager.prepare(id), second = await f.manager.prepare(id);
    expect(first.session.id).toBe(second.session.id); expect(first.session.messages).toEqual([]);
    expect(first.taskMessage).toBe(f.input.taskMessage); expect(first.willExecute).toBe(false);
  });
  it('recovers a partially saved preparation without duplicating its session', async () => {
    const f = await fixture(); await f.manager.save(f.input, undefined, f.now); await f.manager.tick(f.input.nextRun);
    const id = f.manager.list().occurrences[0]!.id, original = f.persistence.save.bind(f.persistence);
    const spy = vi.spyOn(f.persistence, 'save').mockImplementation(async (key, data) => {
      if (key === 'scheduled-tasks') throw new Error('disk full'); await original(key, data);
    });
    await expect(f.manager.prepare(id)).rejects.toThrow('disk full'); expect(f.store.listSessions(f.workspaceId)).toHaveLength(1);
    spy.mockRestore(); await f.manager.prepare(id); expect(f.store.listSessions(f.workspaceId)).toHaveLength(1);
  });
  it('cancels stale pending work on edits, rejects stale revisions and prevents preparation after deletion', async () => {
    const f = await fixture(), job = await f.manager.save(f.input, undefined, f.now);
    await f.manager.tick(f.input.nextRun); const occurrence = f.manager.list().occurrences[0]!;
    await expect(f.manager.save({ ...f.input, revision: job.revision, nextRun: f.now + 300000 }, job.id, f.now)).rejects.toThrow('变化');
    await f.manager.remove(job.id); await expect(f.manager.prepare(occurrence.id)).rejects.toThrow('取消');
    expect(f.store.listSessions(f.workspaceId)).toEqual([]);
  });
  it('does not publish a due occurrence when persistence fails', async () => {
    const f = await fixture(); await f.manager.save(f.input, undefined, f.now);
    vi.spyOn(f.persistence, 'save').mockRejectedValueOnce(new Error('disk full'));
    await expect(f.manager.tick(f.input.nextRun)).rejects.toThrow('disk full'); expect(f.manager.list().occurrences).toEqual([]);
  });
  it('reuses a confirmed create request even when its text needed trimming', async () => {
    const f = await fixture(), input = { ...f.input, name: ' 每日报告 ', taskMessage: ' 公开资料 ',
      requestId: '00000000-0000-4000-8000-000000000001' };
    const first = await f.manager.save(input, undefined, f.now);
    const retry = await f.manager.save(input, undefined, f.now);
    expect(retry.id).toBe(first.id); expect(retry.name).toBe('每日报告'); expect(f.manager.list().jobs).toHaveLength(1);
  });
});
