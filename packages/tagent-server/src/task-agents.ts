import { createAgentCard, type AgentCard, type AgentPool, type PersistenceAdapter } from '@tagent/core';
import { isDeepStrictEqual } from 'node:util';
import { validConfiguration, type Configuration, type ResidentAgentStore } from './resident-agents.js';

const KEY = 'task-agents';
type Meta = NonNullable<AgentCard['spawnMeta']>;
interface Entry { configuration: Configuration; parentAgentId: string; meta: Meta }
interface Saved { version: 1; agents: Entry[] }
export class TaskAgentError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503) { super(message); }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 100000): value is string => typeof value === 'string' && value.length <= max;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function validMeta(value: unknown): value is Meta {
  if (!record(value) || !text(value.objective) || !value.objective.trim() || !text(value.createdReason) || !value.createdReason.trim()
    || !nonnegative(value.createdAt) || typeof value.depth !== 'number' || ![1, 2].includes(value.depth)
    || !['queued', 'running', 'completed', 'failed', 'interrupted'].includes(String(value.status))) return false;
  if (['workspaceId', 'sessionId', 'runId', 'taskId', 'parentName', 'inputSummary', 'outputSummary'].some(key => value[key] !== undefined && !text(value[key]))) return false;
  if (value.completedAt !== undefined && !nonnegative(value.completedAt)) return false;
  if (typeof value.completedAt === 'number' && value.completedAt < value.createdAt) return false;
  if (['queued', 'running'].includes(String(value.status)) && (value.completedAt !== undefined || value.result !== undefined)) return false;
  if (['completed', 'failed', 'interrupted'].includes(String(value.status)) && value.completedAt === undefined) return false;
  if (value.result !== undefined) {
    const result = value.result;
    if (!record(result) || !text(result.output, 1000000) || typeof result.success !== 'boolean' || !nonnegative(result.cost)
      || !nonnegative(result.iterations) || !Number.isSafeInteger(result.iterations) || !record(result.tokens)
      || !nonnegative(result.tokens.input) || !nonnegative(result.tokens.output)) return false;
    if (value.status === 'completed' && result.success !== true) return false;
    if (value.status !== 'completed' && result.success) return false;
  }
  return value.status !== 'completed' || value.result !== undefined;
}
function entryOf(agent: AgentCard): Entry {
  if (agent.type !== 'task_spawned' || !agent.parentAgentId || !validConfiguration(agent) || !validMeta(agent.spawnMeta)) throw new TaskAgentError('任务子 Agent 配置或运行记录无效。', 400);
  const { id, name, description, icon, capabilities, constraints } = agent;
  const card = structuredClone(agent.card);
  delete card.scoreProfile.benchmarkScore; delete card.scoreProfile.benchmarkMetadata;
  const meta = structuredClone(agent.spawnMeta);
  // Promotion is derived from the committed resident record, not a second non-atomic write.
  delete meta.promotedAgentId; delete meta.promotedAt;
  return { configuration: { id, name, description, icon, capabilities: structuredClone(capabilities), constraints: structuredClone(constraints), card },
    parentAgentId: agent.parentAgentId, meta };
}

export class TaskAgentStore {
  private entries = new Map<string, Entry>();
  private queue = Promise.resolve();
  private constructor(private persistence: PersistenceAdapter, private pool: AgentPool, private residents: ResidentAgentStore) {}

  static async open(persistence: PersistenceAdapter, pool: AgentPool, residents: ResidentAgentStore): Promise<TaskAgentStore> {
    const store = new TaskAgentStore(persistence, pool, residents);
    const value = await persistence.load<unknown>(KEY, null);
    if (value !== null) {
      const invalid = () => new Error('任务 Agent 历史损坏，未覆盖原文件或发布不完整记录。');
      if (!record(value) || value.version !== 1 || !Array.isArray(value.agents)) throw invalid();
      for (const entry of value.agents) {
        if (!record(entry) || !validConfiguration(entry.configuration) || !validMeta(entry.meta)
          || !text(entry.parentAgentId, 160) || !entry.parentAgentId || entry.parentAgentId === entry.configuration.id
          || pool.getAgent(entry.configuration.id) || store.entries.has(entry.configuration.id)) throw invalid();
        store.entries.set(entry.configuration.id, structuredClone(entry) as unknown as Entry);
      }
      for (const entry of store.entries.values()) {
        const parent = store.entries.get(entry.parentAgentId);
        if ((entry.meta.depth === 2 && !parent) || (entry.meta.depth === 1 && parent)
          || (parent && (parent.meta.depth !== entry.meta.depth! - 1 || parent.meta.workspaceId !== entry.meta.workspaceId
            || parent.meta.sessionId !== entry.meta.sessionId || parent.meta.runId !== entry.meta.runId))) throw invalid();
      }
    }
    let interrupted = false;
    for (const entry of store.entries.values()) if (entry.meta.status === 'running') {
      entry.meta.status = 'interrupted'; entry.meta.completedAt = Date.now(); interrupted = true;
    }
    if (interrupted) await persistence.save(KEY, { version: 1, agents: [...store.entries.values()] } satisfies Saved);
    for (const entry of store.entries.values()) pool.publishTaskAgent(store.cardFor(entry));
    // A parent may sort after its child in a stored snapshot.
    for (const entry of store.entries.values()) {
      const parent = pool.getAgent(entry.parentAgentId);
      if (parent && !parent.childAgentIds.includes(entry.configuration.id)) parent.childAgentIds.push(entry.configuration.id);
    }
    return store;
  }

  private cardFor(entry: Entry): AgentCard {
    const result = entry.meta.result, running = entry.meta.status === 'running';
    return createAgentCard({ ...structuredClone(entry.configuration), type: 'task_spawned', parentAgentId: entry.parentAgentId,
      spawnMeta: { ...structuredClone(entry.meta), promotedAgentId: this.residents.promotedAgentFor(entry.configuration.id) },
      state: { business: running ? 'busy' : 'idle', runtime: running || entry.meta.status === 'queued' ? 'running' : 'stopped', humanInteraction: 'idle', orchestration: 'none' },
      stats: { tasksCompleted: result?.success ? 1 : 0, totalCost: result?.cost || 0, avgIterations: result?.iterations || 0 } });
  }

  save(agent: AgentCard): Promise<AgentCard> {
    const entry = entryOf(agent);
    const id = entry.configuration.id;
    const operation = this.queue.then(async () => {
      const previous = this.entries.get(id);
      if (previous && (!isDeepStrictEqual(previous.configuration, entry.configuration) || previous.parentAgentId !== entry.parentAgentId
        || ['workspaceId', 'sessionId', 'runId', 'taskId', 'objective', 'createdReason', 'createdAt', 'depth'].some(key => previous.meta[key as keyof Meta] !== entry.meta[key as keyof Meta]))) {
        throw new TaskAgentError('不能修改任务子 Agent 的来源或执行配置；请复制到大厅后编辑。', 409);
      }
      if (previous && ['completed', 'failed', 'interrupted'].includes(previous.meta.status!) && !isDeepStrictEqual(previous, entry)) throw new TaskAgentError('已结束的任务记录不能重开或覆盖。', 409);
      if (previous?.meta.status === 'running' && entry.meta.status === 'queued') throw new TaskAgentError('执行中的任务不能退回未执行状态。', 409);
      if (!previous && this.pool.getAgent(id)) throw new TaskAgentError('任务 Agent 标识已存在。', 409);
      const parent = this.pool.getAgent(entry.parentAgentId);
      if (!previous && (!parent || (entry.meta.depth === 2 && (parent.type !== 'task_spawned'
        || parent.spawnMeta?.depth !== 1 || parent.spawnMeta?.workspaceId !== entry.meta.workspaceId
        || parent.spawnMeta?.sessionId !== entry.meta.sessionId || parent.spawnMeta?.runId !== entry.meta.runId))
        || (entry.meta.depth === 1 && parent.type !== 'resident'))) throw new TaskAgentError('父 Agent 或来源任务不匹配。', 409);
      const next = new Map(this.entries).set(id, entry);
      try { await this.persistence.save(KEY, { version: 1, agents: [...next.values()] } satisfies Saved); }
      catch { throw new TaskAgentError('任务 Agent 历史保存失败，未发布新的状态；请检查存储。', 503); }
      this.entries = next;
      return structuredClone(this.pool.publishTaskAgent(this.cardFor(entry)));
    });
    this.queue = operation.then(() => {}, () => {});
    return operation;
  }
}
