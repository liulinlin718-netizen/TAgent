import { Hono } from 'hono';
import { BENCHMARK_DIMENSIONS, estimateAgentBenchmarkProfile, fingerprintAgentConfiguration, getBenchmarkSuites,
  profileFromBenchmarkRun, runAgentBenchmark, reviewAgentRunEvidence } from '@tagent/core';
import type { AgentCard, AgentPool, BenchmarkRun, PersistenceAdapter, AgentRunEvidenceInput } from '@tagent/core';
import type { Store } from './store.js';
import type { OfficeBenchmarkManager } from './office-benchmarks.js';

const KEY = 'benchmarks';
const MAX_RUNS = 200;
export class BenchmarkError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503) { super(message); }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 10000;
const strings = (value: unknown) => Array.isArray(value) && value.length <= 3000 && value.every(text);
const numeric = (value: unknown, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
const dimensions = (value: unknown) => object(value) && BENCHMARK_DIMENSIONS.every(({ id }) => numeric(value[id], 100));
function validRun(value: unknown): value is BenchmarkRun {
  if (!object(value) || !text(value.runId) || !/^bench-[a-zA-Z0-9-]+$/.test(value.runId)
    || !text(value.agentId) || !text(value.agentName) || !text(value.suiteId) || !text(value.suiteVersion)
    || !['static_capability', 'trace_aware'].includes(String(value.mode)) || value.status !== 'completed'
    || !numeric(value.startedAt) || !numeric(value.completedAt) || Number(value.completedAt) < Number(value.startedAt)
    || !numeric(value.totalScore, 100) || !numeric(value.passRate, 1) || value.estimatedCost !== 0
    || !numeric(value.sampleCount, 1000) || !Number.isInteger(value.sampleCount) || !dimensions(value.dimensionScores)
    || !strings(value.weakDimensions) || !strings(value.recommendations) || !numeric(value.configurationRevision)
    || !Number.isInteger(value.configurationRevision) || !text(value.configurationFingerprint) || !/^[a-f0-9]{64}$/.test(value.configurationFingerprint)
    || !Array.isArray(value.results) || value.results.length !== value.sampleCount) return false;
  if (value.results.some(result => !object(result) || !text(result.taskId) || !text(result.title) || !text(result.type)
    || !numeric(result.score, 100) || typeof result.passed !== 'boolean' || !strings(result.findings)
    || !strings(result.missingCapabilities) || !strings(result.traceSummary) || !object(result.dimensionScores) || !object(result.dimensionWeights)
    || Object.values(result.dimensionScores).some(score => !numeric(score, 100)) || Object.values(result.dimensionWeights).some(weight => !numeric(weight, 1)))) return false;
  if (value.mode === 'static_capability') return value.evidenceReview === undefined;
  const review = value.evidenceReview;
  return object(review) && review.agentId === value.agentId && strings(review.taskIds) && object(review.source)
    && ['runId', 'sessionId', 'workspaceId', 'title', 'completedAt'].every(key => text(review.source && (review.source as Record<string, unknown>)[key]))
    && Number.isFinite(Date.parse(String(review.source.completedAt))) && Array.isArray(review.checks) && review.checks.length === 7
    && review.checks.every(check => object(check) && text(check.id) && text(check.label) && text(check.detail)
      && BENCHMARK_DIMENSIONS.some(dimension => dimension.id === check.dimension)
      && ['passed', 'failed', 'unobserved'].includes(String(check.status)) && strings(check.eventIds));
}

export class BenchmarkStore {
  private records: BenchmarkRun[] = [];
  private queue = Promise.resolve();
  private constructor(private readonly persistence: PersistenceAdapter) {}
  static async open(persistence: PersistenceAdapter) {
    const store = new BenchmarkStore(persistence);
    const saved = await persistence.load<unknown>(KEY, null);
    if (saved !== null) {
      if (!object(saved) || saved.version !== 1 || !Array.isArray(saved.runs) || saved.runs.length > MAX_RUNS
        || !saved.runs.every(validRun) || new Set(saved.runs.map(run => run.runId)).size !== saved.runs.length) {
        throw new Error('Benchmark 存储无效，未覆盖原记录；请检查 benchmarks 数据。');
      }
      store.records = structuredClone(saved.runs);
    }
    return store;
  }
  list(agentId: string) { return structuredClone(this.records.filter(run => run.agentId === agentId).slice(-20).reverse()); }
  get(runId: string) { return structuredClone(this.records.find(run => run.runId === runId)); }
  save(run: BenchmarkRun): Promise<BenchmarkRun> {
    const snapshot = structuredClone(run);
    if (!validRun(snapshot)) return Promise.reject(new BenchmarkError('评测记录无效，未保存。', 400));
    const operation = this.queue.then(async () => {
      if (this.records.some(record => record.runId === snapshot.runId)) throw new BenchmarkError('评测记录已存在，不能覆盖。', 409);
      const next = [...this.records, snapshot].slice(-MAX_RUNS);
      try { await this.persistence.save(KEY, { version: 1, runs: next }); }
      catch { throw new BenchmarkError('评测结果保存失败，原记录未改变，请检查存储后重试。', 503); }
      this.records = next;
      return structuredClone(snapshot);
    });
    this.queue = operation.then(() => {}, () => {});
    return operation;
  }
  state(agent: AgentCard) {
    const latestRun = this.list(agent.id)[0];
    const stale = !!latestRun && (latestRun.configurationFingerprint !== fingerprintAgentConfiguration(agent)
      || latestRun.suiteVersion !== getBenchmarkSuites()[0]!.version);
    return { profile: latestRun && !stale ? profileFromBenchmarkRun(latestRun) : estimateAgentBenchmarkProfile(agent),
      latestRun, stale, estimatedCost: 0, mode: latestRun?.mode || 'static_capability' };
  }
}

export function createBenchmarkRoutes(records: BenchmarkStore, pool: AgentPool, store: Store, live?: OfficeBenchmarkManager) {
  const app = new Hono();
  app.onError((error, c) => error instanceof BenchmarkError ? c.json({ error: error.message }, error.status)
    : c.json({ error: '评测请求未能完成，未自动运行模型或工具。' }, 500));
  const agent = (id: string) => {
    const value = pool.getAgent(id);
    if (!value || value.type !== 'resident') throw new BenchmarkError('常驻 Agent 不存在，请刷新大厅。', 404);
    return structuredClone(value);
  };
  const state = async (selected: AgentCard) => {
    const config = records.state(selected), measured = await live?.profile(selected.id);
    return { ...config, ...(measured?.profile ? { profile: measured.profile, stale: false } : {}),
      liveStale: measured?.liveStale || false, latestLiveRunId: measured?.latestLiveRunId };
  };
  const evidence = (agentId: string, runId: string): AgentRunEvidenceInput => {
    const receipt = store.findRun(runId);
    if (!receipt) throw new BenchmarkError('来源任务不存在。', 404);
    const { workspaceId, sessionId, message } = receipt;
    if (message.run?.status === 'running') throw new BenchmarkError('来源任务尚未结束，请稍后复核。', 409);
    const events = message.traces || [];
    if (events.some(event => event.type === 'complete' && event.data?.mode === 'research_smoke')) {
      throw new BenchmarkError('Smoke 样例不是实际 Agent 运行，不能作为评测证据。', 400);
    }
    if (!events.some(event => event.type === 'agent_spawn' && event.agentId === agentId && event.agentSnapshot?.id === agentId)
      || events.some(event => event.runId !== runId || event.sessionId !== sessionId) || events.filter(event => event.type === 'complete').length !== 1) {
      throw new BenchmarkError('来源缺少该 Agent 的同任务快照或完整 Trace，不能复核。', 400);
    }
    const input = { events, source: { workspaceId, sessionId, runId, completedAt: message.run!.completedAt || message.timestamp,
      title: store.getSession(workspaceId, sessionId)?.title || '历史任务' } };
    try { reviewAgentRunEvidence(agentId, input); } catch { throw new BenchmarkError('任务 Trace 的实例归属不完整，不能复核。', 400); }
    return input;
  };
  app.get('/benchmarks', c => c.json({ suites: getBenchmarkSuites().map(suite => ({ ...suite,
    taskCount: suite.tasks.filter(task => task.enabledByDefault !== false && !task.experimental).length,
    estimatedCost: 0, mode: 'static_capability' })), historyLimit: MAX_RUNS }));
  app.get('/benchmarks/runs/:runId', c => {
    const run = records.get(c.req.param('runId'));
    if (!run) throw new BenchmarkError('评测记录不存在。', 404);
    return c.json({ run, profile: profileFromBenchmarkRun(run) });
  });
  app.get('/agents/:id/benchmark', async c => c.json(await state(agent(c.req.param('id')))));
  app.get('/agents/:id/benchmark/history', c => c.json({ runs: records.list(agent(c.req.param('id')).id) }));
  app.get('/agents/:id/benchmark/sources', c => {
    const id = agent(c.req.param('id')).id;
    const sources = store.listRuns().filter(receipt => receipt.message.run?.status !== 'running'
      && receipt.message.traces?.some(event => event.type === 'agent_spawn' && event.agentId === id && event.agentSnapshot?.id === id))
      .slice(-50).reverse().flatMap(receipt => { try { return [evidence(id, receipt.message.run!.id).source]; } catch { return []; } });
    return c.json({ sources });
  });
  app.post('/agents/:id/benchmark/run', async c => {
    const selected = agent(c.req.param('id'));
    const raw = await c.req.text();
    let body: unknown;
    try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { throw new BenchmarkError('评测请求格式不正确。', 400); }
    if (!object(body) || Object.keys(body).some(key => key !== 'sourceRunId')
      || (body.sourceRunId !== undefined && (typeof body.sourceRunId !== 'string' || !/^run-[a-zA-Z0-9-]{1,160}$/.test(body.sourceRunId)))) {
      throw new BenchmarkError('只接受已保存任务的 sourceRunId，不接受客户端 Trace、输出或分数。', 400);
    }
    const input = body.sourceRunId ? evidence(selected.id, String(body.sourceRunId)) : undefined;
    const run = await records.save(runAgentBenchmark(selected, undefined, input));
    return c.json({ run, ...await state(agent(selected.id)) }, 201);
  });
  return app;
}
