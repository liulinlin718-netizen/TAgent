import { createAgentCard } from '@tagent/core';
import type { AgentCard, AgentPool, PersistenceAdapter } from '@tagent/core';

const STORAGE_KEY = 'resident-agents';
export type Configuration = Pick<AgentCard, 'id' | 'name' | 'description' | 'icon' | 'capabilities' | 'constraints' | 'card'>;
interface SavedAgent {
  configuration: Configuration;
  revision: number;
  source?: { taskAgentId: string; parentAgentId: string | null; sessionId?: string; runId?: string };
}
interface SavedAgents { version: 1; agents: SavedAgent[] }

export class ResidentAgentError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503) { super(message); }
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 100000;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 500 && value.every(text);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const fields = (value: unknown, keys: string[]) => record(value) && keys.every(key => strings(value[key]));
const scores = ['research', 'writing', 'data', 'planning', 'communication', 'presentation', 'governance', 'tooling'];

export function validConfiguration(value: unknown): value is Configuration {
  if (!record(value) || !text(value.id) || !/^[a-zA-Z0-9_-]{1,160}$/.test(value.id)
    || !text(value.name) || !value.name.trim() || !text(value.description) || !value.description.trim() || !text(value.icon)) return false;
  const { capabilities, constraints, card } = value;
  if (!fields(capabilities, ['skills', 'tools', 'mcpServers']) || !record(constraints)
    || !number(constraints.maxFissionDepth) || !Number.isInteger(constraints.maxFissionDepth) || constraints.maxFissionDepth > 3
    || !number(constraints.maxCostPerTask) || !strings(constraints.allowedTools) || !strings(constraints.allowedDomains)
    || !['suggest', 'auto_edit', 'full_auto'].includes(String(constraints.approvalMode))) return false;
  if (!record(card) || card.version !== 'v2' || !text(card.soul) || !text(card.fallbackStrategy)
    || !fields(card, ['responsibilities', 'boundaries', 'mcpPreferences', 'qualityChecks', 'exampleTasks', 'outputStandards'])
    || !fields(card.capabilityGraph, ['domains', 'primarySkills', 'toolAffordances', 'mcpAffordances', 'handoffTargets'])
    || !record(card.scoreProfile) || !scores.every(key => number((card.scoreProfile as Record<string, unknown>)[key]) && Number((card.scoreProfile as Record<string, unknown>)[key]) <= 100)) return false;
  const runtime = card.runtimeProfile;
  return record(runtime) && ['reactive', 'plan_execute', 'reflect_repair'].includes(String(runtime.planner))
    && ['tool_first', 'browser_enabled', 'document_generator', 'analysis_first'].includes(String(runtime.executor))
    && fields(runtime, ['verifier', 'toolPolicy', 'memoryPolicy', 'handoffPolicy', 'fallbackPolicy', 'artifactSchemas', 'stages'])
    && (runtime.stages as string[]).every(stage => ['understand', 'plan', 'execute', 'verify', 'synthesize', 'handoff'].includes(stage));
}

// Persist configuration, not live task state, copied tool secrets or unevidenced benchmark claims.
function configurationOf(agent: AgentCard): Configuration {
  if (agent.type !== 'resident' || !validConfiguration(agent)) {
    throw new ResidentAgentError('Agent 配置无效：请检查名称、角色、能力列表、预算和治理约束；任务子 Agent 请使用保存到大厅。', 400);
  }
  const { capabilities, constraints, card } = agent;
  const { research, writing, data, planning, communication, presentation, governance, tooling } = card.scoreProfile;
  return structuredClone({ id: agent.id, name: agent.name, description: agent.description, icon: agent.icon,
    capabilities: { skills: capabilities.skills, tools: capabilities.tools, mcpServers: capabilities.mcpServers },
    constraints: { maxFissionDepth: constraints.maxFissionDepth, maxCostPerTask: constraints.maxCostPerTask,
      allowedTools: constraints.allowedTools, approvalMode: constraints.approvalMode, allowedDomains: constraints.allowedDomains },
    card: { version: 'v2', soul: card.soul, responsibilities: card.responsibilities, boundaries: card.boundaries,
      mcpPreferences: card.mcpPreferences, qualityChecks: card.qualityChecks, fallbackStrategy: card.fallbackStrategy,
      exampleTasks: card.exampleTasks, outputStandards: card.outputStandards,
      scoreProfile: { research, writing, data, planning, communication, presentation, governance, tooling },
      capabilityGraph: { domains: card.capabilityGraph.domains, primarySkills: card.capabilityGraph.primarySkills,
        toolAffordances: card.capabilityGraph.toolAffordances, mcpAffordances: card.capabilityGraph.mcpAffordances,
        handoffTargets: card.capabilityGraph.handoffTargets },
      runtimeProfile: { planner: card.runtimeProfile.planner, executor: card.runtimeProfile.executor,
        verifier: card.runtimeProfile.verifier, toolPolicy: card.runtimeProfile.toolPolicy, memoryPolicy: card.runtimeProfile.memoryPolicy,
        handoffPolicy: card.runtimeProfile.handoffPolicy, fallbackPolicy: card.runtimeProfile.fallbackPolicy,
        artifactSchemas: card.runtimeProfile.artifactSchemas, stages: card.runtimeProfile.stages },
    },
  });
}

export class ResidentAgentStore {
  private saved = new Map<string, SavedAgent>();
  private queue = Promise.resolve();
  private constructor(private readonly persistence: PersistenceAdapter, private readonly pool: AgentPool) {}

  promotedAgentFor(taskAgentId: string): string | undefined {
    return [...this.saved.values()].reverse().find(entry => entry.source?.taskAgentId === taskAgentId)?.configuration.id;
  }

  static async open(persistence: PersistenceAdapter, pool: AgentPool): Promise<ResidentAgentStore> {
    const store = new ResidentAgentStore(persistence, pool);
    const saved = await persistence.load<unknown>(STORAGE_KEY, null);
    if (saved !== null) {
      const invalid = () => new Error('常驻 Agent 存储记录无效，未覆盖现有配置；请检查 resident-agents 存储记录。');
      if (!record(saved) || saved.version !== 1 || !Array.isArray(saved.agents)) throw invalid();
      for (const entry of saved.agents) {
        if (!record(entry) || !validConfiguration(entry.configuration) || !number(entry.revision)
          || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || store.saved.has(entry.configuration.id)) throw invalid();
        if (entry.source !== undefined && (!record(entry.source) || !text(entry.source.taskAgentId)
          || (entry.source.parentAgentId !== null && !text(entry.source.parentAgentId))
          || (entry.source.sessionId !== undefined && !text(entry.source.sessionId))
          || (entry.source.runId !== undefined && !text(entry.source.runId)))) throw invalid();
        store.saved.set(entry.configuration.id, structuredClone(entry) as unknown as SavedAgent);
      }
    }
    // Validate the entire file before publishing anything; legacy bindings were loaded by the pool first.
    for (const agent of pool.getResidentAgents()) agent.configurationRevision = 0;
    for (const entry of store.saved.values()) pool.updateAgent(entry.configuration.id,
      createAgentCard({ ...entry.configuration, type: 'resident', configurationRevision: entry.revision }));
    return store;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(work);
    this.queue = operation.then(() => {}, () => {});
    return operation;
  }

  async create(agent: AgentCard, sourceTaskAgentId?: string): Promise<AgentCard> {
    const configuration = configurationOf(agent);
    return this.serialize(async () => {
      if (this.pool.getAgent(configuration.id)) throw new ResidentAgentError('此 Agent 已存在，请刷新核对，不能重复创建或覆盖。', 409);
      const source = sourceTaskAgentId ? this.pool.getAgent(sourceTaskAgentId) : undefined;
      if (sourceTaskAgentId !== undefined && (!source || source.type !== 'task_spawned')) throw new ResidentAgentError('来源子 Agent 不存在，请重新生成草稿。', 400);
      const entry: SavedAgent = { configuration, revision: 1, ...(source ? { source: { taskAgentId: source.id,
        parentAgentId: source.parentAgentId, sessionId: source.spawnMeta?.sessionId, runId: source.spawnMeta?.runId } } : {}) };
      const result = await this.commit(entry);
      if (source?.spawnMeta) {
        source.spawnMeta.promotedAgentId = result.id;
        source.spawnMeta.promotedAt = Date.now();
      }
      return result;
    });
  }

  update(id: string, change: (current: AgentCard) => AgentCard, expectedRevision?: number): Promise<AgentCard> {
    return this.serialize(async () => {
      const current = this.pool.getAgent(id);
      if (!current) throw new ResidentAgentError('Agent 不存在，请刷新列表。', 404);
      if (current.type !== 'resident') throw new ResidentAgentError('任务子 Agent 不能直接改为常驻，请使用保存到大厅。', 400);
      const revision = this.saved.get(id)?.revision || 0;
      if (expectedRevision !== undefined && expectedRevision !== revision) throw new ResidentAgentError('Agent 已被其他操作修改，请刷新列表后重新编辑；当前草稿尚未保存。', 409);
      const configuration = configurationOf(change(structuredClone(current)));
      if (configuration.id !== id) throw new ResidentAgentError('不能修改 Agent 标识。', 400);
      return this.commit({ ...this.saved.get(id), configuration, revision: revision + 1 });
    });
  }

  private async commit(entry: SavedAgent): Promise<AgentCard> {
    const next = new Map(this.saved).set(entry.configuration.id, entry);
    const value: SavedAgents = { version: 1, agents: [...next.values()] };
    try { await this.persistence.save(STORAGE_KEY, value); }
    catch { throw new ResidentAgentError('Agent 保存失败，原配置仍然有效；请检查存储后重试。', 503); }
    this.saved = next;
    const live = this.pool.getAgent(entry.configuration.id);
    const published = createAgentCard({ ...structuredClone(entry.configuration), type: 'resident', configurationRevision: entry.revision,
      ...(live ? { state: live.state, stats: live.stats, childAgentIds: live.childAgentIds } : {}) });
    this.pool.updateAgent(published.id, published);
    return structuredClone(this.pool.getAgent(published.id)!);
  }
}
