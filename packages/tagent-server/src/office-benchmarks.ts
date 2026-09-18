import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Hono } from 'hono';
import { BENCHMARK_DIMENSIONS, executeOfficeBenchmark, getOfficeBenchmarkTasks, OfficeBenchmarkCheckpointError,
  previewOfficeBenchmark } from '@tagent/core';
import type { AgentBenchmarkProfile, AgentCard, OfficeBenchmarkConsent, OfficeBenchmarkExecution, OfficeBenchmarkHistoryEntry,
  OfficeBenchmarkPreview, OfficeBenchmarkView, PersistenceAdapter, Skill } from '@tagent/core';
import type { LLMProvider } from '@tagent/ai';

const KEY = 'office-benchmarks', HISTORY_LIMIT = 50, CONSENT_TTL = 5 * 60_000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
const string = (value: unknown, max = 65536): value is string => typeof value === 'string' && value.length <= max;
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const strings = (value: unknown) => Array.isArray(value) && value.length <= 1000 && value.every(item => string(item));
export class OfficeBenchmarkError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503) { super(message); }
}
function validPreview(p: unknown): p is OfficeBenchmarkPreview {
  return object(p) && ['suiteId', 'suiteVersion', 'agentId', 'model', 'provider'].every(key => string(p[key], 300))
    && ['suiteFingerprint', 'configurationFingerprint', 'skillsFingerprint'].every(key => hash(p[key]))
    && p.taskCount === 8 && p.maxModelCalls === 32 && p.maxInputBytesPerCall === 65536 && p.maxOutputTokensPerCall === 1024
    && p.costStopThreshold === 0.5 && p.timeoutMs === 180000 && (p.estimatedCost === null || number(p.estimatedCost))
    && p.networkTools === false && p.externalCommands === false && p.toolEnvironment === 'fixture_read_url'
    && (p.endpoint === undefined || string(p.endpoint, 2000)) && strings(p.sends) && strings(p.excludes) && strings(p.missingSkillIds);
}
function validRun(run: unknown): run is OfficeBenchmarkExecution {
  if (!object(run) || !string(run.id) || !/^benchlive-[a-f0-9-]{36}$/.test(run.id) || run.mode !== 'controlled_office'
    || !validPreview(run.preview) || !['running', 'completed', 'failed', 'interrupted'].includes(String(run.status))
    || !number(run.startedAt) || (run.status !== 'running' && (!number(run.completedAt) || Number(run.completedAt) < Number(run.startedAt)))
    || !number(run.modelCalls, 32) || !Number.isInteger(run.modelCalls) || !object(run.usage)
    || !['input', 'output', 'knownCost', 'unsettledRequests'].every(key => number(run.usage && (run.usage as Record<string, unknown>)[key]))
    || typeof run.usage.pricingKnown !== 'boolean' || !Array.isArray(run.results) || run.results.length !== 8
    || !Array.isArray(run.events) || run.events.length > 2000 || (run.error !== undefined && !string(run.error))) return false;
  if (new Set(run.results.map(result => result?.taskId)).size !== 8 || run.results.some(result => !object(result)
    || !string(result.taskId, 200) || !string(result.title, 1000) || !string(result.output)
    || !['pending', 'running', 'completed', 'failed'].includes(String(result.status)) || !number(result.calls, 4) || !Number.isInteger(result.calls)
    || !strings(result.reads) || !Array.isArray(result.requests) || result.requests.length > 128
    || result.requests.some(request => !object(request) || !string(request.name, 1000) || typeof request.allowed !== 'boolean')
    || (result.error !== undefined && !string(result.error))
    || (result.grade !== undefined && (!object(result.grade) || result.grade.taskId !== result.taskId || !number(result.grade.score, 100)
      || typeof result.grade.passed !== 'boolean' || !Array.isArray(result.grade.checks) || !result.grade.checks.length || result.grade.checks.length > 100
      || result.grade.checks.some(check => !object(check) || !string(check.id) || !string(check.label) || !string(check.reason)
        || !BENCHMARK_DIMENSIONS.some(dim => dim.id === check.dimension) || !number(check.weight, 100) || typeof check.passed !== 'boolean'))))) return false;
  if (new Set(run.events.map(event => event?.eventId)).size !== run.events.length || run.events.some(event => !object(event)
    || !string(event.eventId, 200) || !string(event.type, 100) || !string(event.summary) || !number(event.timestamp)
    || event.runId !== run.id || event.sessionId !== run.id || event.agentId !== (run.preview as OfficeBenchmarkPreview).agentId)) return false;
  if (run.status === 'completed') return run.results.every(result => result.status === 'completed' && result.grade)
    && object(run.score) && number(run.score.totalScore, 100) && number(run.score.passRate, 1) && object(run.score.dimensionScores)
    && BENCHMARK_DIMENSIONS.every(dim => number((run.score as { dimensionScores: Record<string, unknown> }).dimensionScores[dim.id], 100))
    && run.events.filter(event => event.type === 'complete').length === 1;
  return run.score === undefined && (run.status === 'running' || run.events.filter(event => event.type === 'complete').length === 1);
}
function interrupt(input: OfficeBenchmarkExecution, reason: string): OfficeBenchmarkExecution {
  const run = structuredClone(input);
  run.status = 'interrupted'; run.error = reason; run.completedAt = Math.max(run.startedAt, Date.now()); delete run.score;
  for (const task of run.results) if (task.status === 'running') { task.status = 'failed'; task.error = reason; }
  run.events = run.events.filter(event => event.type !== 'complete');
  run.events.push({ eventId: `evt-${randomUUID()}`, type: 'complete', sessionId: run.id, runId: run.id,
    agentId: run.preview.agentId, summary: reason, timestamp: run.completedAt, data: { success: false, mode: 'controlled_office' } });
  return run;
}

export class OfficeBenchmarkStore {
  private records: OfficeBenchmarkExecution[] = [];
  private queue = Promise.resolve();
  private constructor(private readonly persistence: PersistenceAdapter) {}
  static async open(persistence: PersistenceAdapter) {
    const store = new OfficeBenchmarkStore(persistence), saved = await persistence.load<unknown>(KEY, null);
    if (saved !== null) {
      if (!object(saved) || saved.version !== 1 || !Array.isArray(saved.runs) || saved.runs.length > HISTORY_LIMIT
        || !saved.runs.every(validRun) || new Set(saved.runs.map(run => run.id)).size !== saved.runs.length) {
        throw new Error('办公评测存储无效，未覆盖原记录；请检查 office-benchmarks 数据。');
      }
      store.records = structuredClone(saved.runs);
      for (const run of store.records.filter(item => item.status === 'running')) {
        await store.save(interrupt(run, '服务重启，评测已中断；保留已保存材料与用量，不自动重跑。'));
      }
    }
    return store;
  }
  list(agentId: string) { return structuredClone(this.records.filter(run => run.preview.agentId === agentId).slice(-20).reverse()); }
  get(id: string) { return structuredClone(this.records.find(run => run.id === id)); }
  save(input: OfficeBenchmarkExecution): Promise<void> {
    const run = structuredClone(input);
    if (!validRun(run)) return Promise.reject(new OfficeBenchmarkError('办公评测记录无效，未保存。', 400));
    const operation = this.queue.then(async () => {
      const old = this.records.find(item => item.id === run.id);
      if (old && old.status !== 'running') throw new OfficeBenchmarkError('已结束的评测记录不能覆盖。', 409);
      const next = this.records.filter(item => item.id !== run.id);
      if (next.length >= HISTORY_LIMIT) {
        const removable = next.findIndex(item => item.status !== 'running');
        if (removable < 0) throw new OfficeBenchmarkError('评测记录容量已满。', 503);
        next.splice(removable, 1);
      }
      next.push(run);
      try { await this.persistence.save(KEY, { version: 1, runs: next }); }
      catch { throw new OfficeBenchmarkError('评测保存失败，未发布新成绩。', 503); }
      this.records = next;
    });
    this.queue = operation.then(() => {}, () => {});
    return operation;
  }
}

export interface OfficeBenchmarkContext {
  agent: AgentCard; skills: Skill[]; provider: LLMProvider; model: string;
  endpoint: string; connectionFingerprint: string;
}
type Admission = { token: string; expiresAt: number; preview: OfficeBenchmarkPreview; connectionFingerprint: string };
export class OfficeBenchmarkManager {
  private consents = new Map<string, Admission>();
  private active?: { agentId: string; id?: string; controller: AbortController; job?: Promise<void> };
  private failed = new Map<string, OfficeBenchmarkView>();
  private storageFailed = false;
  constructor(readonly records: OfficeBenchmarkStore, private readonly context: (id: string) => Promise<OfficeBenchmarkContext>,
    private readonly traceDirectory: string) {}
  private async prepare(id: string) {
    const context = await this.context(id);
    try { return { context, preview: previewOfficeBenchmark(context.agent, context.skills, context.model, context.provider.name, context.endpoint) }; }
    catch { throw new OfficeBenchmarkError('Agent 或 Skill 配置不适用于当前评测，请检查任务预算与上下文大小。', 400); }
  }
  async preview(id: string): Promise<OfficeBenchmarkConsent> {
    const { context, preview } = await this.prepare(id);
    for (const [token, value] of this.consents) if (value.expiresAt <= Date.now()) this.consents.delete(token);
    if (this.consents.size >= 50) this.consents.delete(this.consents.keys().next().value!);
    const admission = { token: randomUUID(), expiresAt: Date.now() + CONSENT_TTL, preview, connectionFingerprint: context.connectionFingerprint };
    this.consents.set(admission.token, structuredClone(admission));
    return { token: admission.token, expiresAt: admission.expiresAt, endpoint: context.endpoint, preview,
      tasks: getOfficeBenchmarkTasks(context.agent).map(({ id, title }) => ({ id, title })) };
  }
  async start(id: string, token: string): Promise<OfficeBenchmarkView> {
    if (this.storageFailed) throw new OfficeBenchmarkError('评测存储发生故障，已暂停新增评测；请检查存储并重启后核对记录。', 503);
    if (this.active) throw new OfficeBenchmarkError('已有评测正在运行或收尾，请等待结束或停止它。', 409);
    const consent = this.consents.get(token);
    if (!consent || consent.preview.agentId !== id || consent.expiresAt <= Date.now()) {
      throw new OfficeBenchmarkError('确认已过期或已使用，请重新查看评测范围。', 409);
    }
    // Reserve admission before any await; a token cannot start parallel jobs.
    this.consents.delete(token);
    const active: NonNullable<OfficeBenchmarkManager['active']> = { agentId: id, controller: new AbortController() };
    this.active = active;
    try {
      const { context, preview } = await this.prepare(id);
      if (!isDeepStrictEqual(preview, consent.preview) || context.connectionFingerprint !== consent.connectionFingerprint) {
        throw new OfficeBenchmarkError('Agent、Skill、模型或连接配置已改变，请重新预览确认。', 409);
      }
      let ready!: (view: OfficeBenchmarkView) => void, fail!: (error: OfficeBenchmarkError) => void;
      const accepted = new Promise<OfficeBenchmarkView>((resolve, reject) => { ready = resolve; fail = reject; });
      active.job = executeOfficeBenchmark({ ...context, traceDirectory: this.traceDirectory, signal: active.controller.signal,
        confirmation: { confirmed: true, preview }, checkpoint: async run => {
          await this.records.save(run);
          if (!active.id) { active.id = run.id; ready({ run, persistence: 'saved', cancelRequested: false }); }
        },
      }).then(() => {}, error => {
        this.storageFailed = true;
        if (error instanceof OfficeBenchmarkCheckpointError) {
          const run = interrupt(error.unsaved, '评测保存失败或超时，已停止后续调用；以下为本进程保留的未保存结果，请勿直接刷新。');
          this.failed.set(run.id, { run, persistence: 'failed', cancelRequested: active.controller.signal.aborted });
        }
        fail(new OfficeBenchmarkError('评测未能安全启动或保存，请刷新记录核对；不会自动重试模型。', 503));
      }).finally(() => { if (this.active === active) this.active = undefined; });
      return await accepted;
    } catch (error) { if (!active.job && this.active === active) this.active = undefined; throw error; }
  }
  get(agentId: string, id: string): OfficeBenchmarkView {
    const view = this.failed.get(id) || (() => { const run = this.records.get(id);
      return run ? { run, persistence: 'saved' as const, cancelRequested: this.active?.id === id && this.active.controller.signal.aborted } : undefined; })();
    if (!view || view.run.preview.agentId !== agentId) throw new OfficeBenchmarkError('该 Agent 的评测记录不存在。', 404);
    return structuredClone(view);
  }
  history(agentId: string): { runs: OfficeBenchmarkHistoryEntry[]; activeId?: string; storageFailed: boolean } {
    const ids = new Set([...this.records.list(agentId).map(run => run.id), ...[...this.failed.values()].filter(view => view.run.preview.agentId === agentId).map(view => view.run.id)]);
    const runs = [...ids].map(id => this.get(agentId, id)).sort((a, b) => b.run.startedAt - a.run.startedAt).slice(0, 20).map(({ run, persistence }) => ({
      id: run.id, status: run.status, startedAt: run.startedAt, ...(run.completedAt ? { completedAt: run.completedAt } : {}),
      model: run.preview.model, modelCalls: run.modelCalls, ...(run.score ? { totalScore: run.score.totalScore } : {}), persistence,
    }));
    return { runs, ...(this.active?.agentId === agentId && this.active.id ? { activeId: this.active.id } : {}), storageFailed: this.storageFailed };
  }
  cancel(agentId: string, id: string) {
    this.get(agentId, id);
    if (this.active?.id === id) this.active.controller.abort(new Error('User cancelled office benchmark'));
    return this.get(agentId, id);
  }
  async idle() { await this.active?.job; }
  async profile(agentId: string): Promise<{ profile?: AgentBenchmarkProfile; liveStale: boolean; latestLiveRunId?: string }> {
    const run = this.records.list(agentId).find(item => item.status === 'completed' && item.score && !this.failed.has(item.id));
    if (!run?.score) return { liveStale: false };
    const base = { liveStale: true, latestLiveRunId: run.id };
    let current: OfficeBenchmarkPreview;
    try { current = (await this.prepare(agentId)).preview; } catch { return base; }
    if (!isDeepStrictEqual(current, run.preview)) return base;
    const weak = BENCHMARK_DIMENSIONS.filter(dim => run.score!.dimensionScores[dim.id] < 70);
    return { ...base, liveStale: false, profile: { source: 'benchmark', mode: 'controlled_office', suiteId: run.preview.suiteId,
      suiteVersion: run.preview.suiteVersion, ...run.score, sampleCount: run.results.length, runId: run.id,
      lastRunAt: run.completedAt!, weakDimensions: weak.map(dim => dim.id),
      recommendations: weak.length ? weak.map(dim => `核对「${dim.label}」失败用例，完善对应 Skill 的步骤和约束后再评测。`) : ['固定材料题已通过；仍需验收真实联网和办公交付质量。'] } };
  }
}

export function createOfficeBenchmarkRoutes(manager: OfficeBenchmarkManager) {
  const app = new Hono();
  app.onError((error, c) => error instanceof OfficeBenchmarkError ? c.json({ error: error.message }, error.status)
    : c.json({ error: '办公评测请求失败，请核对模型配置和已保存记录。' }, 503));
  const body = async (request: { json: () => Promise<unknown> }, keys: string[]) => {
    let value: unknown;
    try { value = await request.json(); } catch { throw new OfficeBenchmarkError('请求必须是 JSON。', 400); }
    if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new OfficeBenchmarkError('不接受客户端输出、分数或执行参数。', 400);
    return value;
  };
  const base = '/agents/:id/benchmark/live';
  app.post(`${base}/preview`, async c => { await body(c.req, []); return c.json(await manager.preview(c.req.param('id'))); });
  app.post(`${base}/start`, async c => {
    const input = await body(c.req, ['confirmed', 'token']);
    if (input.confirmed !== true || !string(input.token, 100)) throw new OfficeBenchmarkError('需要明确确认和有效预览凭证。', 400);
    return c.json(await manager.start(c.req.param('id'), input.token), 202);
  });
  app.get(`${base}/history`, c => c.json(manager.history(c.req.param('id'))));
  app.get(`${base}/runs/:runId`, c => c.json(manager.get(c.req.param('id'), c.req.param('runId'))));
  app.post(`${base}/runs/:runId/cancel`, async c => {
    await body(c.req, []); return c.json(manager.cancel(c.req.param('id'), c.req.param('runId')));
  });
  return app;
}
