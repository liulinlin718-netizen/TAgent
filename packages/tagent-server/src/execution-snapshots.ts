import { Hono } from 'hono';
import type { ExecutionSnapshot, PersistenceAdapter, SnapshotSummary } from '@tagent/core';
import type { Store } from './store.js';

const KEY = 'execution-snapshots';
const MAX_BYTES = 8 * 1024 * 1024;
const snapshotBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
const safeId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);

function validSnapshot(value: unknown): value is ExecutionSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as ExecutionSnapshot;
  return [snapshot.id, snapshot.workspaceId, snapshot.sessionId, snapshot.runId, snapshot.agentId].every(safeId)
    && (snapshot.taskId === undefined || safeId(snapshot.taskId))
    && Number.isInteger(snapshot.iteration) && snapshot.iteration > 0
    && typeof snapshot.timestamp === 'string' && Number.isFinite(Date.parse(snapshot.timestamp))
    && Array.isArray(snapshot.messages) && snapshot.messages.length <= 300
    && snapshot.messages.every(message => message && ['system', 'user', 'assistant', 'tool'].includes(message.role)
      && typeof message.content === 'string' && (!message.toolCalls || (Array.isArray(message.toolCalls)
        && message.toolCalls.every(call => call && typeof call.id === 'string' && typeof call.name === 'string' && typeof call.arguments === 'string'))))
    && snapshotBytes(snapshot) <= 512 * 1024;
}

export class ExecutionSnapshotStore {
  private items: ExecutionSnapshot[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private constructor(private persistence: PersistenceAdapter, private store: Store) {}

  static async open(persistence: PersistenceAdapter, store: Store) {
    const snapshots = new ExecutionSnapshotStore(persistence, store);
    const data = await persistence.load<unknown>(KEY, []);
    if (!Array.isArray(data) || data.length > 200 || !data.every(validSnapshot) || snapshotBytes(data) > MAX_BYTES)
      throw new Error('执行快照存储无效；未覆盖旧记录。');
    snapshots.items = data.filter(item => snapshots.owned(item));
    return snapshots;
  }

  private owned(snapshot: ExecutionSnapshot) {
    const source = this.store.findRun(snapshot.runId);
    return !!source && source.workspaceId === snapshot.workspaceId && source.sessionId === snapshot.sessionId;
  }

  save(snapshot: ExecutionSnapshot): Promise<void> {
    const copy = structuredClone(snapshot);
    const operation = this.pending.then(async () => {
      if (!validSnapshot(copy) || !this.owned(copy)) throw new Error('快照过大或来源不一致。');
      const next = [...this.items.filter(item => item.id !== copy.id && this.owned(item)), copy];
      while (next.length > 200 || snapshotBytes(next) > MAX_BYTES) next.shift();
      await this.persistence.save(KEY, next);
      this.items = next;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  list(workspaceId: string, sessionId: string, runId?: string): SnapshotSummary[] {
    return this.items.filter(item => item.workspaceId === workspaceId && item.sessionId === sessionId
      && (!runId || item.runId === runId) && this.owned(item)).map(({ messages, ...item }) => ({ ...item, messageCount: messages.length }));
  }

  get(id: string) {
    const snapshot = this.items.find(item => item.id === id);
    return snapshot && this.owned(snapshot) ? structuredClone(snapshot) : undefined;
  }
}

export function createExecutionSnapshotRoutes(snapshots: ExecutionSnapshotStore, store: Store) {
  const app = new Hono();
  app.get('/workspaces/:wsId/sessions/:sessId/snapshots', c => {
    if (!store.hasSession(c.req.param('wsId'), c.req.param('sessId'))) return c.json({ error: '会话不存在。' }, 404);
    return c.json({ snapshots: snapshots.list(c.req.param('wsId'), c.req.param('sessId'), c.req.query('runId')),
      retention: '全局最多保留200个快照、8MB；超过上限移除最早记录。' });
  });
  app.get('/snapshots/:id', c => {
    const snapshot = snapshots.get(c.req.param('id'));
    if (!snapshot) return c.json({ error: '快照不存在或已超出保留范围。' }, 404);
    // System instructions and raw call arguments are not part of the browsing surface.
    return c.json({ ...snapshot, messages: snapshot.messages.filter(message => message.role !== 'system')
      .map(message => ({ role: message.role, content: message.content, tools: message.toolCalls?.map(call => call.name) })) });
  });
  app.post('/snapshots/:id/fork', async c => {
    const body = await c.req.json().catch(() => null);
    if (!body || body.confirmed !== true) return c.json({ error: '请先确认从此快照创建分支。' }, 400);
    const snapshot = snapshots.get(c.req.param('id'));
    if (!snapshot) return c.json({ error: '快照不存在或已超出保留范围。' }, 404);
    const session = await store.forkExecutionSnapshot(snapshot);
    return c.json({ session, fromSnapshot: snapshot.id, willExecute: false }, 201);
  });
  return app;
}
