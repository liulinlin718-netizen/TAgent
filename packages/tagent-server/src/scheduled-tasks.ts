import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { PersistenceAdapter, ScheduledTask, ScheduledOccurrence } from '@tagent/core';
import type { Store } from './store.js';

interface ScheduleState { jobs: ScheduledTask[]; occurrences: ScheduledOccurrence[] }
const MIN_INTERVAL = 60000, MAX_INTERVAL = 366 * 86400000;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= limit;
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const interval = (value: unknown): value is number => timestamp(value) && value >= MIN_INTERVAL && value <= MAX_INTERVAL;
const fail = (message: string, status: 400 | 404 | 409 = 400): never => {
  throw new HTTPException(status, { message, res: new Response(JSON.stringify({ error: message }), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  }) });
};

export class ScheduledTaskManager {
  private state: ScheduleState = { jobs: [], occurrences: [] };
  private pending: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  lastError: string | undefined;
  private constructor(private persistence: PersistenceAdapter, private store: Store) {}

  static async open(persistence: PersistenceAdapter, store: Store) {
    const manager = new ScheduledTaskManager(persistence, store);
    const saved = await persistence.load<ScheduleState>('scheduled-tasks', { jobs: [], occurrences: [] });
    if (!saved || !Array.isArray(saved.jobs) || !Array.isArray(saved.occurrences) || saved.jobs.length > 50 || saved.occurrences.length > 200
      || new Set(saved.jobs.map(item => item?.id)).size !== saved.jobs.length
      || new Set(saved.occurrences.map(item => item?.id)).size !== saved.occurrences.length
      || saved.jobs.some(job => !job || !text(job.id, 160) || !text(job.name, 100) || !text(job.taskMessage, 6000)
        || !text(job.workspaceId, 160) || !interval(job.intervalMs) || !timestamp(job.nextRun) || typeof job.enabled !== 'boolean'
        || job.execution !== 'confirm_each_run' || !Number.isSafeInteger(job.revision) || job.revision < 1)
      || saved.occurrences.some(item => !item || !text(item.id, 160) || !text(item.jobId, 160) || !text(item.workspaceId, 160)
        || !text(item.name, 100) || !text(item.taskMessage, 6000) || !timestamp(item.dueAt) || !timestamp(item.createdAt)
        || !['pending', 'prepared', 'dismissed'].includes(item.status)
        || (item.sessionId !== undefined && !text(item.sessionId, 160)))) throw new Error('周期任务存储无效；未覆盖旧记录。');
    manager.state = saved;
    return manager;
  }

  private commit<T>(change: (draft: ScheduleState) => T | Promise<T>): Promise<T> {
    const operation = this.pending.then(async () => {
      const draft = structuredClone(this.state), result = await change(draft);
      await this.persistence.save('scheduled-tasks', draft);
      this.state = draft;
      return structuredClone(result);
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  list() { return { ...structuredClone(this.state), error: this.lastError,
    execution: 'confirm_each_run', willExecute: false,
    note: '到期只生成待办。打开任务后仍需手动发送；离线期间错过的周期只保留一次，不自动补跑。' }; }

  save(input: unknown, id?: string, now = Date.now()) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('周期任务格式不正确。');
    const body = input as Record<string, unknown>;
    if (body.confirmed !== true || (body.execution !== undefined && body.execution !== 'confirm_each_run')) fail('保存需用户确认；当前只支持每次确认后执行。');
    if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.requestId))) fail('保存请求标识无效。');
    if (!text(body.name, 100) || !text(body.taskMessage, 6000) || !text(body.workspaceId, 160)
      || !interval(body.intervalMs) || typeof body.enabled !== 'boolean' || !timestamp(body.nextRun)
      || body.nextRun <= now || body.nextRun > now + MAX_INTERVAL) fail('请填写名称、任务、工作空间、未来开始时间及1分钟至366天的周期。');
    if (!this.store.getWorkspace(body.workspaceId as string)) fail('目标工作空间不存在。', 404);
    const value: Record<string, unknown> = { ...structuredClone(body), name: (body.name as string).trim(), taskMessage: (body.taskMessage as string).trim() };
    const newId = `schedule-${body.requestId || randomUUID()}`;
    return this.commit(draft => {
      if (!id) {
        const committed = draft.jobs.find(job => job.id === newId);
        if (committed) {
          if (['name', 'taskMessage', 'workspaceId', 'intervalMs', 'enabled'].some(key => committed[key as keyof ScheduledTask] !== value[key]))
            fail('这次保存已经提交，请刷新列表后编辑原任务。', 409);
          return committed;
        }
      }
      const previous = draft.jobs.find(job => job.id === id);
      if (id && !previous) fail('周期任务不存在。', 404);
      if (previous && value.revision !== previous.revision) fail('任务已变化，请刷新后再保存。', 409);
      if (!id && draft.jobs.length >= 50) fail('最多保存50个周期任务。', 409);
      const job: ScheduledTask = { id: id || newId, name: (value.name as string).trim(),
        taskMessage: (value.taskMessage as string).trim(), workspaceId: value.workspaceId as string,
        intervalMs: value.intervalMs as number, nextRun: value.nextRun as number, enabled: value.enabled as boolean,
        execution: 'confirm_each_run', revision: (previous?.revision || 0) + 1, ...(previous?.lastRun ? { lastRun: previous.lastRun } : {}) };
      draft.jobs = [...draft.jobs.filter(item => item.id !== job.id), job];
      // Changing a schedule must not leave stale pending instructions eligible for preparation.
      for (const item of draft.occurrences) if (item.jobId === job.id && item.status === 'pending') item.status = 'dismissed';
      return job;
    });
  }

  remove(id: string) {
    return this.commit(draft => {
      if (!draft.jobs.some(job => job.id === id)) fail('周期任务不存在。', 404);
      draft.jobs = draft.jobs.filter(job => job.id !== id);
      for (const item of draft.occurrences) if (item.jobId === id && item.status === 'pending') item.status = 'dismissed';
      return { ok: true };
    });
  }

  async tick(now = Date.now()): Promise<void> {
    if (!this.state.jobs.some(job => job.enabled && job.nextRun <= now)) return;
    await this.commit(draft => {
      for (const job of draft.jobs) {
        if (!job.enabled || job.nextRun > now) continue;
        if (!this.store.getWorkspace(job.workspaceId)) { job.enabled = false; job.revision++; continue; }
        const dueAt = job.nextRun;
        if (!draft.occurrences.some(item => item.jobId === job.id && item.status === 'pending')) {
          draft.occurrences.push({ id: `due-${job.id}-${dueAt}`, jobId: job.id, workspaceId: job.workspaceId,
            name: job.name, taskMessage: job.taskMessage, dueAt, createdAt: now, status: 'pending' });
        }
        job.lastRun = now;
        job.nextRun += (Math.floor((now - dueAt) / job.intervalMs) + 1) * job.intervalMs;
        job.revision++;
      }
      while (draft.occurrences.length > 200) {
        const index = draft.occurrences.findIndex(item => item.status !== 'pending');
        if (index < 0) break;
        draft.occurrences.splice(index, 1);
      }
    });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      void this.tick().then(() => { this.lastError = undefined; })
        .catch(() => { this.lastError = '周期任务状态保存失败，未执行模型或工具。'; })
        .finally(() => { this.ticking = false; });
    }, 15000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  prepare(id: string) {
    return this.commit(async draft => {
      const item = draft.occurrences.find(value => value.id === id);
      if (!item || item.status === 'dismissed') fail('待办不存在或已取消。', 404);
      const session = await this.store.prepareScheduledSession(item!);
      item!.status = 'prepared'; item!.sessionId = session.id;
      return { session, taskMessage: item!.taskMessage, willExecute: false };
    });
  }

  dismiss(id: string) {
    return this.commit(draft => {
      const item = draft.occurrences.find(value => value.id === id);
      if (!item) fail('待办不存在。', 404);
      if (item!.status === 'prepared') fail('已准备的任务请在对话中处理。', 409);
      item!.status = 'dismissed';
      return { ok: true };
    });
  }
}

export function createScheduleRoutes(manager: ScheduledTaskManager) {
  const app = new Hono();
  app.get('/cron', c => c.json(manager.list()));
  app.post('/cron', async c => c.json(await manager.save(await c.req.json().catch(() => null)), 201));
  app.put('/cron/:id', async c => c.json(await manager.save(await c.req.json().catch(() => null), c.req.param('id'))));
  app.delete('/cron/:id', async c => c.json(await manager.remove(c.req.param('id'))));
  app.post('/cron/occurrences/:id/prepare', async c => {
    const body = await c.req.json().catch(() => null);
    if (body?.confirmed !== true) return c.json({ error: '请先确认准备任务；此操作不会执行模型。' }, 400);
    return c.json(await manager.prepare(c.req.param('id')));
  });
  app.post('/cron/occurrences/:id/dismiss', async c => c.json(await manager.dismiss(c.req.param('id'))));
  return app;
}
