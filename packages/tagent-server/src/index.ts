/**
 * @tagent/server — App Server
 *
 * 完整的 API 服务：
 * - Workspace CRUD
 * - Session CRUD（支持3种创建方式 ← plan §3.9）
 * - Agent Run (SSE 流式)
 * - Trace 查询
 *
 * 架构参考：Codex CLI App Server, Hermes-Team 双通道
 */

import * as path from 'path';
import { createHash } from 'node:crypto';

import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import type { WSContext } from 'hono/ws';
import { AnthropicProvider, OpenAIProvider, ProviderRequestError } from '@tagent/ai';
import type { LLMProvider } from '@tagent/ai';
import {
  runOrchestrator,
  AgentPool,
  SkillsRegistry,
  MCPRegistry,
  createPersistence,
  RedisCache,
  createAgentCard,
  createDefaultAgentCardV2,
  searchConfigurationStatus,
} from '@tagent/core';
import type { AgentCard, OrchestratorResult, PersistenceAdapter, ConversationContext } from '@tagent/core';
import { BenchmarkStore, createBenchmarkRoutes } from './benchmarks.js';
import { OfficeBenchmarkError, OfficeBenchmarkManager, OfficeBenchmarkStore, createOfficeBenchmarkRoutes } from './office-benchmarks.js';
import { ActiveRunError, Store } from './store.js';
import { assertRestoreComplete, loadServerEnvironment, modelConfigurationStatus, resolveModelConfig, resolveWorkspaceRoot, resolveTaskLimits } from './config.js';
import type { ChatMessage, TraceEvent } from './store.js';
import { GovernanceStore, type LiveGovernanceRun } from './governance-store.js';
import { ApprovalError, ApprovalRegistry } from './approvals.js';
import { createMCPImportRoutes } from './mcp-import.js';
import { buildResearchSmokePayload } from './research-smoke.js';
import { getDiscoveryHealth, getDiscoveryProviders, runDiscoverySearch } from './discovery.js';
import { previewSkillImport } from './skill-import.js';
import { createMCPManagementRoutes } from './mcp-management.js';
import { installAccessControl, resolveAccessConfig } from './access-control.js';
import { workflowStatus } from './workflow-status.js';
import { createSearchSettingsRoutes, SearchSettingsStore } from './search-settings.js';
import { createWorkflowHandlers } from './workflow-events.js';
import { RunRegistry, RunAdmissionError } from './runs.js';
import { RunJournal, recoverInterruptedRuns } from './run-journal.js';
import { ResidentAgentError, ResidentAgentStore } from './resident-agents.js';
import { TaskAgentError, TaskAgentStore } from './task-agents.js';
import { WorkflowCatalog } from './workflow-catalog.js';
import { WorkflowIndex, WorkflowIndexRecorder, removeWorkflowIndexes } from './workflow-index.js';
import { createWorkflowHistoryRoutes } from './workflow-history.js';
import { createSessionQuoteRoutes } from './session-quotes.js';
import { createSummaryForkRoutes, recoverSummaryForks, SummaryForkManager } from './summary-forks.js';
import { createModelConnectionRoutes, ModelConnectionManager } from './model-connection.js';
import { createTableImportRoutes } from './table-import.js';
import { RequestWindow } from './request-rate.js';
import { ExecutionSnapshotStore, createExecutionSnapshotRoutes } from './execution-snapshots.js';
import { ScheduledTaskManager, createScheduleRoutes } from './scheduled-tasks.js';
import { runtimeOverview } from './runtime-overview.js';


const repositoryRoot = resolveWorkspaceRoot(import.meta.url);
loadServerEnvironment(repositoryRoot);
const PORT = parseInt(process.env.PORT || '3001');
const taskLimits = resolveTaskLimits();
const runs = new RunRegistry(Number(process.env.TAGENT_RUN_TIMEOUT_MS || 600000), taskLimits.maxActiveRuns);
const HOST = process.env.TAGENT_HOST || '127.0.0.1';
const accessConfig = resolveAccessConfig(process.env, HOST, PORT);
const workspaceRoot = resolveWorkspaceRoot(import.meta.url, process.env.TAGENT_WORKSPACE_ROOT);
assertRestoreComplete(workspaceRoot);
const agentPool = new AgentPool();
const skillsRegistry = new SkillsRegistry(workspaceRoot);
const mcpRegistry = new MCPRegistry(workspaceRoot);

// §5.2: Persistence — 根据 DATABASE_URL 自动选择 PostgreSQL 或文件
const persistence: PersistenceAdapter = createPersistence(workspaceRoot);
const store = await Store.open(persistence);
const snapshots = await ExecutionSnapshotStore.open(persistence, store);
const schedules = await ScheduledTaskManager.open(persistence, store);
const liveGovernance = new Map<string, LiveGovernanceRun>();
const workflowCatalog = new WorkflowCatalog(store, () => [...liveGovernance.values()]);
const workflowIndex = new WorkflowIndex(workspaceRoot);
const governanceStore = new GovernanceStore(store, () => [...liveGovernance.values()], workflowCatalog);
const recoveredRuns = await recoverInterruptedRuns(store, persistence);
if (recoveredRuns) console.log(`[Run] Recovered ${recoveredRuns} interrupted runs without replay`);
await recoverSummaryForks(store);
const summaryForks = new SummaryForkManager(store, () => {
  const config = resolveModelConfig();
  return { ...createProvider(config), endpoint: config.baseURL, connectionFingerprint: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
});
const searchSettings = await SearchSettingsStore.open(persistence);
const modelConnection = await ModelConnectionManager.open(persistence, () => {
  const config = resolveModelConfig();
  return { ...createProvider(config), endpoint: config.baseURL, timeoutMs: config.timeoutMs,
    fingerprint: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
});
console.log(`[Persistence] ${process.env.DATABASE_URL ? 'PostgreSQL' : 'File'} adapter`);

// §5.2: Redis Cache — 可选，连接失败不影响服务
let redisCache: RedisCache | null = null;
if (process.env.REDIS_URL) {
  redisCache = new RedisCache(process.env.REDIS_URL);
  redisCache.connect().then(() => {
    console.log('[Redis] Connected');
  }).catch(() => {
    console.warn('[Redis] Connection failed, running without cache');
    redisCache = null;
  });
}

// 初始化 agent 池配置 (加载持久化的 skills 和 tools 绑定)
await agentPool.initialize(workspaceRoot);
const residentAgents = await ResidentAgentStore.open(persistence, agentPool);
const taskAgents = await TaskAgentStore.open(persistence, agentPool, residentAgents);

// D7: WebSocket 双通道 — 活跃的 WS 连接 (sessionId → WSContext)
const wsClients = new Map<string, Set<WSContext>>();
const wsAuthorization = new Map<WSContext, () => boolean>();
const wsMessageWindows = new Map<WSContext, RequestWindow>();
const wsMessageWindow = new RequestWindow(600);
const MAX_WS_CONNECTIONS = 16;
const benchmarkStore = await BenchmarkStore.open(persistence);
const officeBenchmarkStore = await OfficeBenchmarkStore.open(persistence);
const officeBenchmarks = new OfficeBenchmarkManager(officeBenchmarkStore, async id => {
  const skills = await skillsRegistry.getSkills();
  const agent = agentPool.getAgent(id);
  if (!agent || agent.type !== 'resident') throw new OfficeBenchmarkError('常驻 Agent 不存在，请刷新大厅。', 404);
  let config: ReturnType<typeof resolveModelConfig>;
  try { config = resolveModelConfig(); }
  catch { throw new OfficeBenchmarkError('模型配置不可用，请检查服务端 Provider、API Key 和服务地址；未启动评测。', 503); }
  return { agent: structuredClone(agent), skills, ...createProvider(config), endpoint: config.baseURL,
    connectionFingerprint: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
}, path.join(workspaceRoot, '.tagent', 'benchmark-traces'));

// D1: 待审批请求缓存 (requestId → resolve callback)
const approvals = new ApprovalRegistry();

// ─── Config ──────────────────────────────────────────


function createProvider(config = resolveModelConfig()): { provider: LLMProvider; model: string } {
  const options = { apiKey: config.apiKey, baseURL: config.baseURL, name: config.name, timeout: config.timeoutMs, maxRetries: 0 };
  return {
    provider: config.name === 'anthropic' ? new AnthropicProvider(options) : new OpenAIProvider(options),
    model: config.model,
  };
}

function safeSessionTitle(content: string, maxChars = 30): string {
  const chars = Array.from(content.trim());
  return chars.slice(0, maxChars).join('') + (chars.length > maxChars ? '...' : '');
}

function shorten(content: unknown, maxChars = 72): string {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.slice(0, maxChars).join('') + (chars.length > maxChars ? '...' : '');
}

function buildRecoverableErrorOutput(message: string, traces: TraceEvent[]): string {
  const lastUsefulTrace = [...traces]
    .reverse()
    .find(trace => trace.type !== 'error' && trace.summary);
  const lastStage = lastUsefulTrace?.summary || '尚未形成可用中间结果';

  return [
    '## 任务未能完整完成',
    '',
    '> 本次运行遇到系统或模型接口错误，TAgent 已停止继续调用工具，并返回可读的降级报告。',
    '',
    `- 错误原因: ${message}`,
    `- 最后完成阶段: ${lastStage}`,
    '',
    '## 已采取的降级策略',
    '',
    '- 保留当前工作流事件和治理记录，便于复盘。',
    '- 不再继续执行联网、浏览器或外部工具调用，避免重复成本。',
    '- 请先按错误原因检查网络、模型配置或额度，再决定是否重试。工具协议错误需要排查，不代表已经自动修复。',
    '- 中断请求可能仍被服务商计费；显示费用仅包含已经收到的用量，不要连续重复发送。',
  ].join('\n');
}

function workflowSummary(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case 'task_decomposition':
      return `任务拆解为 ${Array.isArray(data.tasks) ? data.tasks.length : 0} 个子任务`;
    case 'agent_spawn':
      return `${data.agentName || data.agentId || 'Agent'} 接手：${shorten(data.objective)}`;
    case 'agent_progress':
      return `${data.agentId || 'Agent'} 第 ${data.iteration || '?'} 轮推理`;
    case 'agent_stage':
      return `${data.agentId || 'Agent'} ${data.stage || 'stage'}：${shorten(data.summary)}`;
    case 'agent_tool_call':
    case 'tool_call':
      return `${data.agentId || 'Agent'} 调用工具 ${data.tool || data.toolName || 'unknown'}`;
    case 'agent_tool_result':
    case 'tool_result':
      return `${data.tool || data.toolName || '工具'} 返回 ${data.resultLength || 0} 字符`;
    case 'governance':
      return String(data.message || '治理检查已记录');
    case 'agent_complete':
      return data.success === false ? `${data.agentId || 'Agent'} 返回降级结果` : `${data.agentId || 'Agent'} 完成任务`;
    case 'agent_failed':
      return `${data.agentId || 'Agent'} 执行失败：${shorten(data.error)}`;
    case 'synthesis_start':
      return '进入综合整理阶段';
    case 'complete':
      return data.success === false ? '已返回结果，部分内容未通过验收' : '任务完成';
    case 'error':
      return `执行错误：${shorten(data.message)}`;
    default:
      return type;
  }
}

function recordWorkflowTrace(
  traces: TraceEvent[],
  context: { sessionId?: string; runId: string },
  type: string,
  data: Record<string, unknown>,
  overrides: Partial<TraceEvent> = {},
): TraceEvent {
  const trace: TraceEvent = {
    type,
    data: structuredClone(data),
    timestamp: Date.now(),
    eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: context.sessionId,
    runId: context.runId,
    taskId: typeof data.taskId === 'string' ? data.taskId : overrides.taskId,
    parentTaskId: typeof data.parentTaskId === 'string' ? data.parentTaskId : overrides.parentTaskId,
    agentSnapshot: overrides.agentSnapshot ? structuredClone(overrides.agentSnapshot) : undefined,
    agentId: String(data.agentId || overrides.agentId || '') || undefined,
    parentAgentId: String(data.parentAgentId || overrides.parentAgentId || '') || undefined,
    status: overrides.status || workflowStatus(type, data),
    summary: overrides.summary || workflowSummary(type, data),
    toolName: String(data.tool || data.toolName || overrides.toolName || '') || undefined,
    resultLength: typeof data.resultLength === 'number' ? data.resultLength : overrides.resultLength,
    cost: typeof data.cost === 'number' ? data.cost : overrides.cost,
  };
  traces.push(trace);
  return trace;
}

function emitWorkflowEvent(
  stream: { writeSSE: (payload: { event: string; data: string }) => unknown },
  trace: TraceEvent,
) {
  stream.writeSSE({
    event: 'workflow_event',
    data: JSON.stringify(trace),
  });
}

function emitTrace(
  stream: { writeSSE: (payload: { event: string; data: string }) => unknown },
  traces: TraceEvent[],
  context: { sessionId?: string; runId: string },
  event: string,
  data: Record<string, unknown>,
  overrides: Partial<TraceEvent> = {},
) {
  const trace = recordWorkflowTrace(traces, context, event, data, overrides);
  stream.writeSSE({ event, data: JSON.stringify(data) });
  emitWorkflowEvent(stream, trace);
}

async function writeFinalComplete(
  stream: { writeSSE: (payload: { event: string; data: string }) => unknown },
  traces: TraceEvent[],
  context: { sessionId?: string; runId: string },
  workspaceId: string,
  sessionId: string,
  result: OrchestratorResult,
  journal: RunJournal,
  mode?: RunRequest['mode'],
): Promise<boolean> {
  const completeTrace = recordWorkflowTrace(traces, context, 'complete', {
    success: result.success, totalCost: result.totalCost, totalTokens: result.totalTokens,
    termination: result.termination, mode,
    researchAssessment: result.research?.assessment, researchReview: result.research?.review,
    deliveryReviewStatus: result.deliveryReview?.status,
  }, result.termination ? { status: 'failed', summary: result.termination === 'deadline' ? '任务超时，已停止'
    : result.termination === 'storage_failure' ? '保存失败，任务已停止'
    : result.termination === 'disconnected' ? '连接断开，任务已停止' : '任务已取消' } : {});
  const receipt = store.findRun(context.runId)!;
  const message: ChatMessage = {
    id: receipt.message.id, role: 'assistant', content: result.output,
    timestamp: new Date().toISOString(), traces, cost: result.totalCost,
    tokens: result.totalTokens, iterations: result.subResults.length, research: result.research, deliveryReview: result.deliveryReview,
    run: { ...receipt.message.run!, status: 'finished', completedAt: new Date().toISOString() },
  };
  try { await journal.prepareFinal(message); }
  catch { console.error('[Run] Final checkpoint persistence failed', context.runId); }
  let persisted = true;
  try {
    await store.finishRun(workspaceId, sessionId, context.runId, message);
  } catch {
    persisted = false;
    completeTrace.data.persistence = 'failed';
    completeTrace.status = 'failed';
    completeTrace.summary = '运行已结束，但结果保存失败';
    console.error('[Run] Final result persistence failed', context.runId);
  }
  if (persisted) await journal.discard().catch(() => console.warn('[Run] Checkpoint cleanup deferred', context.runId));
  // Publish exactly one terminal event, after persistence, even if the client has disconnected.
  await stream.writeSSE({ event: 'workflow_event', data: JSON.stringify(completeTrace) });
  await stream.writeSSE({ event: 'complete', data: JSON.stringify({
    ...result, persisted, workspaceId, sessionId, runId: context.runId, mode,
    iterations: result.subResults.length,
    ...(persisted ? {} : { persistenceError: '结果保存失败，请保留当前内容，不要刷新页面。' }),
  }) });
  return persisted;
}

function buildAgentCard(body: Partial<AgentCard> & { soul?: string }, existing?: AgentCard): AgentCard {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || ['capabilities', 'constraints', 'card'].some(key => key in body && (!body[key as keyof typeof body]
      || typeof body[key as keyof typeof body] !== 'object' || Array.isArray(body[key as keyof typeof body])))) {
    throw new ResidentAgentError('Agent 请求格式不正确，请检查配置后重试。', 400);
  }
  const fallbackId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const id = existing?.id || body.id || fallbackId;
  const cardV2 = {
    ...createDefaultAgentCardV2(),
    ...(existing?.card || {}),
    ...(body.card || {}),
    soul: body.soul ?? body.card?.soul ?? existing?.card.soul ?? body.description ?? existing?.description ?? '',
  };
  const card = createAgentCard({
    ...existing,
    ...body,
    id,
    name: body.name ?? existing?.name ?? '新 Agent',
    type: body.type || existing?.type || 'resident',
    description: body.description ?? existing?.description ?? '自定义办公 Agent',
    icon: body.icon ?? existing?.icon ?? '◆',
    capabilities: {
      skills: body.capabilities?.skills || existing?.capabilities.skills || [],
      tools: body.capabilities?.tools || existing?.capabilities.tools || ['web_research', 'web_search', 'read_url'],
      mcpServers: body.capabilities?.mcpServers || existing?.capabilities.mcpServers || [],
    },
    constraints: {
      maxFissionDepth: body.constraints?.maxFissionDepth ?? existing?.constraints.maxFissionDepth ?? 1,
      maxCostPerTask: body.constraints?.maxCostPerTask ?? existing?.constraints.maxCostPerTask ?? 0.4,
      allowedTools: body.constraints?.allowedTools || existing?.constraints.allowedTools || ['web_research', 'web_search', 'read_url'],
      approvalMode: body.constraints?.approvalMode || existing?.constraints.approvalMode || 'full_auto',
      allowedDomains: body.constraints?.allowedDomains || existing?.constraints.allowedDomains || [],
    },
    card: cardV2,
  });

  return card;
}

function agentTemplate(template: string, name?: string): AgentCard {
  const normalized = template.trim().toLowerCase();
  const base = agentPool.getAgent(`${normalized}-agent`) || agentPool.getAgent('research-agent');
  if (!base) {
    return buildAgentCard({ name: name || '新 Agent', description: '自定义办公 Agent', icon: '◆' });
  }
  return buildAgentCard({
    ...base,
    id: `agent-${normalized || 'custom'}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: name || `${base.name} 副本`,
    type: 'resident',
  });
}

function confirmedAgentSave(value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') throw new ResidentAgentError('save 必须为明确的布尔值；未确认前不会保存。', 400);
  return value === true;
}

// ─── App ─────────────────────────────────────────────

const app = new Hono();

app.onError((error, c) => {
  if (error instanceof RunAdmissionError) {
    if (error.status === 429) c.header('Retry-After', '5');
    return c.json({ error: error.message, code: error.code, accepted: false }, error.status);
  }
  if (error instanceof ProviderRequestError) {
    // Upstream authentication failures must not invalidate the user's TAgent login.
    return c.json({ error: error.message, code: `model_${error.code}` }, error.code === 'timeout' ? 504 : 502);
  }
  if (error instanceof ResidentAgentError) return c.json({ error: error.message }, error.status);
  if (error instanceof TaskAgentError) return c.json({ error: error.message }, error.status);
  if (error instanceof ActiveRunError) return c.json({ error: error.message }, 409);
  if (error instanceof HTTPException) return error.getResponse();
  console.error('[Server] Request failed', error.name);
  return c.json({ error: '请求未能完成，请检查服务或存储后重试。' }, 500);
});

// D7: WebSocket 升级中间件
const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app, baseUrl: `http://127.0.0.1:${PORT}` });
// ws reads these public server options during each upgrade, before allocating the receiver.
wss.options.maxPayload = 16 * 1024;

const access = installAccessControl(app, accessConfig);

app.use('*', async (c, next) => {
  await next();
  const contentType = c.res.headers.get('Content-Type');
  if ((contentType?.startsWith('application/json') || contentType?.startsWith('text/event-stream')) && !contentType.includes('charset=')) {
    c.res.headers.set('Content-Type', `${contentType}; charset=utf-8`);
  }
});

app.get('/api/health', async (c) => {
  if (access.required && !access.isAuthorized(c)) return c.json({ status: 'ok', access: 'protected' });
  const redisOk = redisCache ? await redisCache.ping() : false;
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    provider: modelConfigurationStatus().provider,
    model: modelConfigurationStatus(),
    search: searchConfigurationStatus({ TAGENT_SEARCH_PROVIDER: searchSettings.provider }),
    persistence: process.env.DATABASE_URL ? 'postgresql' : 'file',
    redis: redisOk ? 'connected' : 'unavailable',
  });
});

app.route('/api/research-search', createSearchSettingsRoutes(searchSettings));
app.route('/api/model-connection', createModelConnectionRoutes(modelConnection));
app.route('/api/data/import', createTableImportRoutes());

// ─── Workspace API ───────────────────────────────────

app.get('/api/workspaces', (c) => {
  return c.json({ workspaces: store.listWorkspaces() });
});

app.post('/api/workspaces', async (c) => {
  const body = await c.req.json<{ name?: unknown; description?: unknown }>();
  if (!body || typeof body.name !== 'string' || !body.name.trim()
    || (body.description !== undefined && typeof body.description !== 'string')) {
    return c.json({ error: 'A workspace name and a text description are required' }, 400);
  }
  const ws = await store.createWorkspace(body.name.trim(), body.description as string | undefined);
  return c.json(ws, 201);
});

app.get('/api/workspaces/:wsId', (c) => {
  const ws = store.getWorkspace(c.req.param('wsId'));
  if (!ws) return c.json({ error: 'Workspace not found' }, 404);
  return c.json(ws);
});

app.delete('/api/workspaces/:wsId', async (c) => {
  const workspaceId = c.req.param('wsId');
  const sources = workflowCatalog.list().filter(source => source.workspaceId === workspaceId);
  await store.deleteWorkspace(workspaceId);
  return c.json({ ok: true, warnings: await removeWorkflowIndexes(workflowIndex, sources) });
});

// ─── Session API ─────────────────────────────────────

app.get('/api/workspaces/:wsId/sessions', (c) => {
  return c.json({ sessions: store.listSessions(c.req.param('wsId')) });
});

app.post('/api/workspaces/:wsId/sessions', async (c) => {
  const wsId = c.req.param('wsId');
  const body = await c.req.json<{
    title?: string;
    creationType?: 'new' | 'fork_full' | 'fork_summary';
    parentSessionId?: string;
  }>();

  if (!body || (body.title !== undefined && typeof body.title !== 'string')
    || (body.parentSessionId !== undefined && typeof body.parentSessionId !== 'string')
    || (body.creationType !== undefined && !['new', 'fork_full', 'fork_summary'].includes(body.creationType))) {
    return c.json({ error: 'Invalid session fields' }, 400);
  }
  if ((body.creationType && body.creationType !== 'new') || body.parentSessionId) return c.json({ error: '复制历史请使用 Fork 接口；新建会话不会自动继承其他会话。' }, 400);

  const session = await store.createSession(
    wsId,
    body.title || '新对话',
    body.creationType || 'new',
    body.parentSessionId || null,
  );

  if (!session) return c.json({ error: 'Workspace not found' }, 404);
  return c.json(session, 201);
});

app.get('/api/workspaces/:wsId/sessions/tree', (c) => {
  if (!store.getWorkspace(c.req.param('wsId'))) return c.json({ error: 'Workspace not found' }, 404);
  return c.json({ sessions: store.listSessions(c.req.param('wsId')) });
});

app.get('/api/workspaces/:wsId/sessions/:sessId', (c) => {
  const session = store.getSession(c.req.param('wsId'), c.req.param('sessId'));
  if (!session) return c.json({ error: 'Session not found' }, 404);
  return c.json(session);
});

// Fix 4: Session 删除 API (Gap 3)
app.delete('/api/workspaces/:wsId/sessions/:sessId', async (c) => {
  const workspaceId = c.req.param('wsId'), sessionId = c.req.param('sessId');
  const sources = workflowCatalog.list().filter(source => source.workspaceId === workspaceId && source.sessionId === sessionId);
  const deleted = await store.deleteSession(workspaceId, sessionId);
  if (!deleted) return c.json({ error: 'Session not found' }, 404);
  return c.json({ ok: true, warnings: await removeWorkflowIndexes(workflowIndex, sources) });
});

// Phase 3b: Session 分支与树形查询 API

app.route('/api', createSummaryForkRoutes(summaryForks));

app.route('/api', createSessionQuoteRoutes(store));
app.route('/api', createExecutionSnapshotRoutes(snapshots, store));

// D3: 结论摘取 API
app.get('/api/workspaces/:wsId/sessions/:sessId/conclusions', (c) => {
  const conclusions = store.extractConclusions(c.req.param('wsId'), c.req.param('sessId'));
  return c.json({ conclusions });
});

// D4: 跨 Session 记忆继承 API
app.get('/api/workspaces/:wsId/sessions/:sessId/memory', (c) => {
  if (!store.hasSession(c.req.param('wsId'), c.req.param('sessId'))) return c.json({ error: 'Session not found' }, 404);
  const rawDepth = c.req.query('depth') || '3';
  if (!/^[1-5]$/.test(rawDepth)) return c.json({ error: 'depth must be an integer from 1 to 5' }, 400);
  const depth = Number(rawDepth);
  const memories = store.getSessionMemory(c.req.param('wsId'), c.req.param('sessId'), depth);
  return c.json({ memories });
});

// V3b.2/V3b.3: Session 消息列表 API（Diff 视图 + 摘要 Fork 验证）
app.get('/api/workspaces/:wsId/sessions/:sessId/messages', (c) => {
  if (!store.hasSession(c.req.param('wsId'), c.req.param('sessId'))) return c.json({ error: 'Session not found' }, 404);
  const messages = store.getMessages(c.req.param('wsId'), c.req.param('sessId'));
  return c.json({ messages });
});

// ─── Agent Run (Fix 5: 统一走 Orchestrator) ──────────
// 保留旧端点兼容性，内部转发到 /api/agent/orchestrate
// 简单任务由 orchestrator 自动降级为单 Agent 模式

interface RunRequest {
  message: string;
  workspaceId?: string;
  sessionId?: string;
  governanceTemplate?: 'standard' | 'strict_cost' | 'quality_first';
  mode?: 'normal' | 'research_smoke' | 'explore';
}

async function runTask(c: Context) {
  const body = await c.req.json<RunRequest>().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || ['workspaceId', 'sessionId'].some(key => key in body && (typeof body[key as keyof RunRequest] !== 'string'
      || !String(body[key as keyof RunRequest]).trim() || String(body[key as keyof RunRequest]).length > 256))) {
    return c.json({ error: '任务请求格式不正确，请检查后再发送。', code: 'INVALID_TASK_REQUEST', accepted: false }, 400);
  }
  const { message } = body;
  if (typeof message !== 'string' || !message.trim()) return c.json({ error: '请输入任务内容。', code: 'INVALID_TASK_REQUEST', accepted: false }, 400);
  if (Buffer.byteLength(message, 'utf8') > taskLimits.maxInputBytes) {
    return c.json({ error: `任务内容超过 ${Math.floor(taskLimits.maxInputBytes / 1024)} KB，请减少材料或分成几次发送。本次未提交。`,
      code: 'TASK_INPUT_TOO_LARGE', accepted: false }, 413);
  }
  if (body.mode !== undefined && !['normal', 'research_smoke', 'explore'].includes(body.mode)) {
    return c.json({ error: '任务模式不正确。', code: 'INVALID_TASK_REQUEST', accepted: false }, 400);
  }
  if (body.governanceTemplate !== undefined && !['standard', 'strict_cost', 'quality_first'].includes(body.governanceTemplate)) {
    return c.json({ error: 'Invalid governance template', code: 'INVALID_TASK_REQUEST', accepted: false }, 400);
  }
  if (body.mode === 'explore' && message.length > 6000)
    return c.json({ error: '只读探索的问题请控制在6000字以内。', accepted: false }, 400);
  let wsId = body.workspaceId || store.listWorkspaces()[0]?.id;
  let sessId = body.sessionId;
  const reservation = runs.reserve(wsId, sessId);
  let admitted: ReturnType<RunRegistry['create']>;
  try {
    if (!wsId) wsId = (await store.createWorkspace('默认工作空间')).id;
    if (!sessId) {
      const session = await store.createSession(wsId, safeSessionTitle(message));
      if (!session) return c.json({ error: 'Workspace not found', code: 'TASK_TARGET_NOT_FOUND', accepted: false }, 404);
      sessId = session.id;
    }
    if (!store.getSession(wsId, sessId)) return c.json({ error: 'Session not found', code: 'TASK_TARGET_NOT_FOUND', accepted: false }, 404);
    admitted = reservation.start(wsId, sessId);
  } finally { reservation.release(); }
  const { runId, signal } = admitted;
  let conversationContext: ConversationContext;
  try { conversationContext = await store.beginRun(wsId, sessId, runId, message); }
  catch (error) {
    runs.finish(runId, false);
    if (error instanceof ActiveRunError) throw new RunAdmissionError('RUN_ALREADY_ACTIVE', 409, error.message);
    throw error;
  }
  return streamSSE(c, async rawStream => {
    const disconnect = () => { runs.stop(runId, 'disconnected'); };
    rawStream.onAbort(disconnect);
    c.req.raw.signal.addEventListener('abort', disconnect, { once: true });
    if (c.req.raw.signal.aborted || rawStream.aborted) disconnect();
    const traces: TraceEvent[] = [];
    liveGovernance.set(runId, { workspaceId: wsId!, sessionId: sessId!, runId, traces });
    const journal = new RunJournal(persistence, runId, wsId!, sessId!, traces, () => runs.stop(runId, 'storage_failure'));
    const traceRecorder = new WorkflowIndexRecorder(workflowIndex, { workspaceId: wsId!, sessionId: sessId!, runId },
      () => console.warn('[Trace] Background index paused; history queries can rebuild from saved events.'));
    let outgoing: Promise<void> = Promise.resolve();
    const stream = { writeSSE: (payload: { event: string; data: string }) => {
      if (payload.event === 'text_delta' || (payload.event === 'workflow_event'
        && JSON.parse(payload.data).type !== 'complete')) void journal.checkpoint();
      outgoing = outgoing.then(async () => {
        // Serialize publication after the corresponding checkpoints, including the terminal event.
        await journal.flush().catch(() => {});
        if (payload.event === 'workflow_event') traceRecorder.record(JSON.parse(payload.data));
        if (rawStream.aborted) return;
        try { await rawStream.writeSSE(payload); } catch { disconnect(); }
      });
      return outgoing;
    } };
    const workflowContext = { sessionId: sessId, runId };
    let persisted = false;
    try {
      await stream.writeSSE({ event: 'session', data: JSON.stringify({ workspaceId: wsId, sessionId: sessId, runId }) });
      if (conversationContext.items.length) emitTrace(stream, traces, workflowContext, 'context_loaded',
        { context: store.findRun(runId)!.message.run!.context }, { status: conversationContext.omittedMessages || conversationContext.items.some(item => item.truncated) ? 'warning' : 'complete',
          summary: `参考 ${conversationContext.items.length} 条历史消息${conversationContext.omittedMessages || conversationContext.items.some(item => item.truncated) ? '，部分历史已省略' : ''}；历史输出不视为本次授权或已核实事实` });
      let result: OrchestratorResult;
      try {
        if (body.mode === 'research_smoke') {
          signal.throwIfAborted();
          const smoke = buildResearchSmokePayload(message);
          for (const event of smoke.events) emitTrace(stream, traces, workflowContext, event.type, event.data, {
            summary: event.summary, status: event.status, agentSnapshot: event.agentSnapshot,
          });
          result = { success: true, output: smoke.output, totalCost: 0, totalTokens: { input: 0, output: 0 },
            subResults: [{ agentId: 'research-agent', agentName: '研究助手', summary: smoke.output.slice(0, 800), cost: 0 }] };
        } else {
          const { provider, model } = createProvider();
          const handlers = createWorkflowHandlers({
            emit: (type, data, overrides) => emitTrace(stream, traces, workflowContext, type, data, overrides),
            approval: (agentId, request, task) => approvals.register({ workspaceId: wsId!, sessionId: sessId!, runId, agentId, ...task }, request, signal, async approval => {
              emitTrace(stream, traces, workflowContext, 'governance', { agentId, ...task, tool: approval.toolName,
                policyType: 'approval', ruleName: 'tool_approval', severity: approval.status === 'approved' ? 'info' : 'hard',
                result: approval.status === 'pending' ? 'warning' : approval.status === 'approved' ? 'passed' : 'blocked',
                message: approval.reason, approval }, { summary: approval.status === 'pending' ? `等待确认：${approval.toolName}` : approval.reason });
              await journal.flush();
            }),
            text: text => {
              journal.setDraft(text);
              void stream.writeSSE({ event: 'text_delta', data: JSON.stringify({ text }) });
              if (sessId) wsBroadcast(sessId, { type: 'text_delta', text });
            },
          });
          const completeAgent = handlers.onAgentComplete;
          handlers.onAgentComplete = (id, result, task) => {
            journal.addArtifact(id, result.output, task?.taskId);
            completeAgent?.(id, result, task);
          };
          handlers.onResearchSources = sources => journal.setSources(sources);
          result = await runOrchestrator({
            workspaceId: wsId, sessionId: sessId, runId, persistTaskAgent: agent => taskAgents.save(agent),
            persistOfficeDelivery: progress => journal.setOfficeDelivery(progress),
            captureSnapshot: snapshot => snapshots.save(snapshot),
            conversationContext,
            provider: journal.provider(provider), model: body.mode === 'explore' ? process.env.TAGENT_EXPLORE_MODEL?.trim() || model : model,
            mode: body.mode === 'explore' ? 'explore' : 'normal', signal, maxTotalCost: body.mode === 'explore' ? 0.15 : 1.0, agentPool, skillsRegistry, mcpRegistry,
            governanceTemplate: body.governanceTemplate || 'standard', searchProvider: searchSettings.provider,
            searchSessionId: createHash('sha256').update(`tagent-search:${wsId}:${sessId}`).digest('hex'),
          }, message, handlers);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        emitTrace(stream, traces, workflowContext, 'error', { message: reason });
        result = { success: false, output: buildRecoverableErrorOutput(reason, traces),
          subResults: [], totalCost: 0, totalTokens: { input: 0, output: 0 } };
      }
      await approvals.finishRun(runId);
      runs.finalizing(runId);
      persisted = await writeFinalComplete(stream, traces, workflowContext, wsId!, sessId!, journal.withKnownUsage(result), journal, body.mode);
    } finally {
      await approvals.finishRun(runId);
      liveGovernance.delete(runId);
      c.req.raw.signal.removeEventListener('abort', disconnect);
      runs.finish(runId, persisted);
    }
  });
}

app.post('/api/agent/run', runTask);
app.post('/api/agent/orchestrate', runTask);
app.get('/api/runs/:runId', c => {
  const run = runs.get(c.req.param('runId'));
  if (run) return c.json(run);
  const saved = store.findRun(c.req.param('runId'));
  if (!saved) return c.json({ error: 'Run not found' }, 404);
  const terminal = saved.message.traces && [...saved.message.traces].reverse().find(event => event.type === 'complete');
  return c.json({ runId: saved.message.run!.id, workspaceId: saved.workspaceId, sessionId: saved.sessionId,
    status: saved.message.run!.status === 'running' ? 'running' : 'finished',
    persisted: saved.message.run!.status !== 'running', termination: terminal?.data.termination });
});
app.post('/api/runs/:runId/cancel', c => {
  const run = runs.stop(c.req.param('runId'));
  return run ? c.json(run, run.status === 'stopping' ? 202 : 200) : c.json({ error: 'Run not found' }, 404);
});

// ─── Agent Pool API (Phase 2) ────────────────────────

app.get('/api/agents', (c) => {
  return c.json({ agents: agentPool.getAllAgents() });
});

app.get('/api/agents/resident', (c) => {
  return c.json({ agents: agentPool.getResidentAgents() });
});

app.get('/api/agents/task-spawned', (c) => {
  const parentId = c.req.query('parentId') || undefined;
  const sessionId = c.req.query('sessionId') || undefined;
  const runId = c.req.query('runId') || undefined;
  return c.json({
    agents: agentPool.getTaskAgents({ parentId, sessionId, runId }),
    filters: { parentId, sessionId, runId },
  });
});

app.route('/api', createBenchmarkRoutes(benchmarkStore, agentPool, store, officeBenchmarks));
app.route('/api', createOfficeBenchmarkRoutes(officeBenchmarks));

app.get('/api/agents/:id', (c) => {
  const agent = agentPool.getAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  return c.json(agent);
});

app.post('/api/agents', async (c) => {
  const body = await c.req.json<Partial<AgentCard> & { soul?: string; sourceTaskAgentId?: string }>();
  const card = buildAgentCard(body);
  return c.json(await residentAgents.create(card, body.sourceTaskAgentId), 201);
});

app.post('/api/agents/from-template', async (c) => {
  const body = await c.req.json<{ template?: string; name?: string; save?: boolean }>();
  const save = confirmedAgentSave(body.save);
  let card = agentTemplate(body.template || 'research', body.name);
  if (save) card = await residentAgents.create(card);
  return c.json({
    agent: card,
    saved: body.save === true,
    note: body.save ? 'Agent 已保存到常驻池。' : '这是 Agent 模板草稿，确认保存前不会写入常驻池。',
  }, body.save ? 201 : 200);
});

app.post('/api/agents/from-run', async (c) => {
  const body = await c.req.json<{
    runId?: string;
    sessionId?: string;
    agentId?: string;
    name?: string;
    summary?: string;
    save?: boolean;
  }>();
  const sourceAgent = body.agentId ? agentPool.getAgent(body.agentId) : agentPool.getAgent('research-agent');
  const sourceCard = createDefaultAgentCardV2(sourceAgent?.card);
  const save = confirmedAgentSave(body.save);
  let card = buildAgentCard({
    ...(sourceAgent || {}),
    id: `agent-from-run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: body.name || `${sourceAgent?.name || '任务'}沉淀 Agent`,
    type: 'resident',
    description: body.summary || sourceAgent?.description || '从一次成功任务沉淀的 Agent 草稿',
    card: {
      ...sourceCard,
      soul: [
        sourceCard.soul || sourceAgent?.description || '',
        body.summary ? `\n## 成功任务沉淀\n${body.summary}` : '',
      ].join('\n').trim(),
      responsibilities: sourceCard.responsibilities,
      boundaries: sourceCard.boundaries,
      mcpPreferences: sourceCard.mcpPreferences,
      qualityChecks: sourceCard.qualityChecks,
      fallbackStrategy: sourceCard.fallbackStrategy || '说明不确定性并返回部分结果。',
      exampleTasks: body.summary ? [body.summary] : sourceCard.exampleTasks,
      outputStandards: sourceCard.outputStandards,
      scoreProfile: sourceCard.scoreProfile,
      capabilityGraph: sourceCard.capabilityGraph,
      runtimeProfile: sourceCard.runtimeProfile,
      version: 'v2',
    },
  });
  if (save) card = await residentAgents.create(card, sourceAgent?.type === 'task_spawned' ? sourceAgent.id : undefined);
  return c.json({
    agent: card,
    saved: body.save === true,
    source: { runId: body.runId, sessionId: body.sessionId, agentId: body.agentId },
    note: body.save ? 'Agent 已保存到常驻池。' : '这是从运行沉淀的 Agent 草稿，确认保存前不会写入常驻池。',
  }, body.save ? 201 : 200);
});

app.post('/api/agents/:parentId/spawn', async (c) => {
  const parentId = c.req.param('parentId');
  type SpawnTaskAgentBody = {
    workspaceId?: string;
    confirmed?: boolean;
    name?: string;
    description?: string;
    icon?: string;
    sessionId?: string;
    runId?: string;
    taskId?: string;
    objective?: string;
    createdReason?: string;
    inputSummary?: string;
  };
  const body = await c.req.json<SpawnTaskAgentBody>().catch(() => null);
  const fields = ['name', 'description', 'icon', 'workspaceId', 'sessionId', 'runId', 'taskId', 'objective', 'createdReason', 'inputSummary'];
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => ![...fields, 'confirmed'].includes(key))
    || fields.some(key => { const value = body[key as keyof SpawnTaskAgentBody]; return value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 12000); })
    || (body.confirmed !== undefined && typeof body.confirmed !== 'boolean')) return c.json({ error: '子任务参数无效；不能通过创建接口扩大工具权限或预算。' }, 400);

  const parent = agentPool.getAgent(parentId);
  if (!parent) return c.json({ error: 'Parent agent not found' }, 404);
  if (parent.state.runtime !== 'running' || parent.constraints.maxCostPerTask <= 0) return c.json({ error: '父 Agent 已停止或没有可用预算。' }, 409);
  if (parent.constraints.approvalMode !== 'full_auto' && body.confirmed !== true) return c.json({ error: '父 Agent 要求确认后才能创建子任务。', requiresConfirmation: true }, 409);
  if (parent.type === 'task_spawned' && parent.spawnMeta?.status !== 'queued') return c.json({ error: '运行中或已结束的子 Agent 不能通过手动接口追加任务。' }, 409);
  if (parent.constraints.maxFissionDepth <= 0) {
    return c.json({
      error: 'Fission depth exhausted',
      message: '该 Agent 的裂变深度已用尽，不能继续创建子 Agent。',
    }, 409);
  }

  const objective = body.objective?.trim() || body.description?.trim();
  if (!objective) return c.json({ error: 'objective is required' }, 400);
  let workspaceId = body.workspaceId || parent.spawnMeta?.workspaceId;
  const sessionId = body.sessionId || parent.spawnMeta?.sessionId;
  const runId = body.runId || parent.spawnMeta?.runId;
  if (runId) {
    const run = store.findRun(runId);
    if (!run || (workspaceId && workspaceId !== run.workspaceId) || !sessionId || sessionId !== run.sessionId) return c.json({ error: '来源运行或会话不存在或不匹配。' }, 400);
    workspaceId = run.workspaceId;
  }
  if (sessionId) {
    workspaceId ||= store.listWorkspaces().find(workspace => store.getSession(workspace.id, sessionId))?.id;
    if (!workspaceId || !store.getSession(workspaceId, sessionId)) return c.json({ error: '来源会话不存在。' }, 400);
  } else if (workspaceId && !store.listWorkspaces().some(workspace => workspace.id === workspaceId)) return c.json({ error: '工作空间不存在。' }, 400);
  if (parent.type === 'task_spawned' && (parent.spawnMeta?.workspaceId !== workspaceId || parent.spawnMeta?.sessionId !== sessionId || parent.spawnMeta?.runId !== runId)) return c.json({ error: '不能改变父子任务的来源归属。' }, 409);

  {
    const child = await taskAgents.save(agentPool.prepareTaskAgent(parentId, {
      name: body.name?.trim() || `${parent.name} · 子任务`,
      description: body.description?.trim() || objective,
      icon: body.icon || '⚡',
      workspaceId,
      sessionId,
      runId,
      taskId: body.taskId,
      objective,
      createdReason: body.createdReason?.trim() || '由主 Agent 根据当前任务拆解创建，用于临时协作。',
      inputSummary: body.inputSummary,
    }));

    const workflowEvent = recordWorkflowTrace([], {
      sessionId: child.spawnMeta?.sessionId,
      runId: child.spawnMeta?.runId || `manual-spawn-${Date.now()}`,
    }, 'agent_spawn', {
      agentId: child.id,
      agentName: child.name,
      agentType: child.type,
      parentAgentId: parentId,
      icon: child.icon,
      taskId: child.spawnMeta?.taskId,
      objective: child.spawnMeta?.objective,
      createdReason: child.spawnMeta?.createdReason,
    }, {
      agentId: child.id,
      parentAgentId: parentId,
      status: 'pending',
      summary: `${child.name} 已创建，尚未执行`,
    });

    return c.json({
      agent: child,
      parentAgent: parent,
      workflowEvent,
      saved: false,
      taskSaved: true,
      note: '子 Agent 记录已保存，尚未执行；未创建常驻 Agent。',
    }, 201);
  }
});

app.post('/api/agents/:id/promote', async (c) => {
  const id = c.req.param('id');
  type PromoteTaskAgentBody = {
    name?: string;
    description?: string;
    icon?: string;
    outputSummary?: string;
    save?: boolean;
  };
  const body = await c.req.json<PromoteTaskAgentBody>().catch(() => ({} as PromoteTaskAgentBody));

  const source = agentPool.getAgent(id);
  if (!source) return c.json({ error: 'Agent not found' }, 404);
  if (source.type !== 'task_spawned') {
    return c.json({ error: 'Only task-spawned agents can be promoted' }, 400);
  }

  {
    const save = confirmedAgentSave(body.save);
    let agent = agentPool.createResidentFromTaskAgent(id, body);
    if (save) agent = await residentAgents.create(agent, id);
    const updatedSource = agentPool.getAgent(id);
    return c.json({
      agent,
      saved: body.save === true,
      sourceAgent: updatedSource,
      source: {
        taskAgentId: id,
        parentAgentId: source.parentAgentId,
        sessionId: source.spawnMeta?.sessionId,
        runId: source.spawnMeta?.runId,
      },
      note: body.save
        ? 'Agent 已保存到常驻池。'
        : '这是从任务子 Agent 生成的常驻 Agent 草稿，确认保存前不会写入常驻池。',
    }, body.save ? 201 : 200);
  }
});

app.put('/api/agents/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Partial<AgentCard> & { soul?: string }>();
  const saved = await residentAgents.update(id, existing => buildAgentCard({ ...body, id }, existing), body.configurationRevision);
  return c.json(saved);
});

// Discovery API: shared search provider layer for Skills and MCP.

app.get('/api/discovery/providers', (c) => {
  const domain = c.req.query('domain') as 'skill' | 'mcp' | undefined;
  return c.json({ providers: getDiscoveryProviders(domain) });
});

app.get('/api/discovery/health', (c) => {
  return c.json({ providers: getDiscoveryHealth() });
});

app.post('/api/discovery/search', async (c) => {
  const body = await c.req.json<{ domain?: unknown; query?: unknown }>().catch(() => null);
  const domain = body?.domain ?? 'skill';
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!query || query.length > 500) return c.json({ error: '搜索词须为1至500个字符。' }, 400);
  if (domain !== 'skill' && domain !== 'mcp') return c.json({ error: 'domain must be skill or mcp' }, 400);

  const result = await runDiscoverySearch({
    domain,
    query,
    skillsRegistry,
    mcpRegistry,
  });
  return c.json(result);
});

// Phase 3a: Skills & MCP API

app.get('/api/skills', async (c) => {
  return c.json({ skills: await skillsRegistry.getSkills() });
});

app.post('/api/skills/search', async (c) => {
  const body = await c.req.json<{ query?: unknown }>().catch(() => null);
  const keyword = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!keyword || keyword.length > 500) return c.json({ error: '搜索词须为1至500个字符。' }, 400);

  const result = await runDiscoverySearch({
    domain: 'skill',
    query: keyword,
    skillsRegistry,
    mcpRegistry,
  });
  return c.json(result);
});

app.post('/api/skills', async (c) => {
  const body = await c.req.json();
  const skill = await skillsRegistry.addSkill(body);
  return c.json(skill, 201);
});

app.put('/api/skills/:id', async (c) => {
  const body = await c.req.json();
  const skill = await skillsRegistry.updateSkill(c.req.param('id'), body);
  return c.json(skill);
});

app.delete('/api/skills/:id', async (c) => {
  await skillsRegistry.deleteSkill(c.req.param('id'));
  return c.json({ ok: true });
});

// D18: Skill AI 建议草稿 — 由 LLM 生成 Skill YAML
app.post('/api/skills/suggest', async (c) => {
  const { taskDescription } = await c.req.json<{ taskDescription: string }>();
  if (!taskDescription) return c.json({ error: 'taskDescription is required' }, 400);

  try {
    const { provider, model } = createProvider();
    const response = await provider.call({
      model,
      messages: [
        {
          role: 'system',
          content: `你是一个 TAgent Skill Package 创建助手。根据用户描述的任务场景，生成一个多文档 Skill 定义草稿。

Skill 格式（Markdown）：
---
name: skill-name
description: 一句话描述
version: 1.0.0
tags: [tag1, tag2]
---

## 核心 SOP

1. **步骤一**: 描述
2. **步骤二**: 描述
3. **步骤三**: 描述

## Prompt 模板

写出 Agent 执行该 Skill 时可复用的提示词片段。

## 参考资料

列出执行该 Skill 时需要优先参考的背景知识、资料来源或上下文。

## 输出模板

描述期望的输出格式。

## 质量检查清单

- 检查项一
- 检查项二

## 风险与边界

说明不该做什么、何时降级、何时请求用户确认。

---
请严格按此格式输出，不要多余文字。`,
        },
        { role: 'user', content: taskDescription },
      ],
      maxTokens: 1000,
      temperature: 0.7,
    });

    return c.json({ draft: response.content });
  } catch (err) {
    if (err instanceof ProviderRequestError) throw err;
    return c.json({ error: err instanceof Error ? err.message : 'LLM call failed' }, 500);
  }
});

const skillImportPreview = async (c: Context) => {
  try {
    return c.json(await previewSkillImport(await c.req.json()));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '导入预览失败，未生成草稿。' }, 400);
  }
};
app.post('/api/skills/import', skillImportPreview);
app.post('/api/skills/import/preview', skillImportPreview);

app.post('/api/skills/:id/test', async (c) => {
  const skill = await skillsRegistry.getSkill(c.req.param('id'));
  if (!skill) return c.json({ error: 'Skill not found' }, 404);

  const tests = skill.package?.tests || [];
  const searchableText = [
    skill.name,
    skill.description,
    skill.body,
    skill.package?.instructions || '',
    ...(skill.package?.documents || []).map(document => `${document.title}\n${document.content}`),
  ].join('\n');
  const results = tests.length
    ? tests.map(test => ({
        name: test.name,
        passed: test.expectedIncludes.every(fragment =>
          searchableText.includes(fragment),
        ),
        expectedIncludes: test.expectedIncludes,
      }))
    : [{
        name: 'package-shape',
        passed: Boolean(skill.name && (skill.body || skill.package?.documents?.length) && skill.package?.manifest.name),
        expectedIncludes: ['name', 'body/documents', 'manifest'],
      }];

  return c.json({
    ok: results.every(result => result.passed),
    results,
    note: '当前 Skill 测试只执行静态最小验证，不调用外部模型或工具。',
  });
});

app.route('/api/mcp', createMCPManagementRoutes(mcpRegistry));

app.post('/api/mcp/search', async (c) => {
  const body = await c.req.json<{ query?: unknown }>().catch(() => null);
  const keyword = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!keyword || keyword.length > 500) return c.json({ error: '搜索词须为1至500个字符。' }, 400);

  const result = await runDiscoverySearch({
    domain: 'mcp',
    query: keyword,
    skillsRegistry,
    mcpRegistry,
  });
  return c.json(result);
});

app.route('/api/mcp', createMCPImportRoutes());

app.get('/api/runtime', c => c.json(runtimeOverview(workflowCatalog, agentPool.getResidentAgents())));
app.get('/api/metrics', c => {
  const data = runtimeOverview(workflowCatalog, agentPool.getResidentAgents());
  return c.json({ ...data, totalRequests: data.recordedRuns, totalCost: data.knownCost, totalTokens: data.totalTokens,
    avgResponseTime: null, startedAt: null, uptimeMs: null,
    agentStats: Object.fromEntries(data.agents.map(agent => [agent.id, {
      runs: agent.completed + agent.failed + agent.unknown, avgIterations: null, totalCost: null,
      successRate: agent.completed + agent.failed ? 100 * agent.completed / (agent.completed + agent.failed) : null,
    }])), toolStats: Object.fromEntries(data.tools.map(tool => [tool.name, { calls: tool.calls, avgDuration: tool.averageMs ?? null }])) });
});
app.get('/api/heartbeat', c => c.json({ agents: runtimeOverview(workflowCatalog, agentPool.getResidentAgents()).agents }));
// Manual beats must not manufacture an apparently healthy execution state.
app.post('/api/heartbeat/:agentId', c => c.json({ error: '状态由任务事件生成，不接受外部伪造心跳。' }, 409));
app.route('/api', createScheduleRoutes(schedules));

// Agent Override API (绑定 Skills/Tools)
app.post('/api/agents/:id/override', async (c) => {
  const { skills, mcpServers, configurationRevision } = await c.req.json();
  const updatedAgent = await residentAgents.update(c.req.param('id'), existing => ({ ...existing,
    capabilities: { ...existing.capabilities, ...(skills !== undefined ? { skills } : {}), ...(mcpServers !== undefined ? { mcpServers } : {}) },
  }), configurationRevision);
  return c.json(updatedAgent);
});

// ─── Orchestrate API (Phase 2: Multi-Agent SSE) ──────


// ─── Trace API ───────────────────────────────────────

app.route('/api', createWorkflowHistoryRoutes(store, workflowCatalog, workflowIndex));

// ─── Governance API (Phase 4) ──────────────────────

app.get('/api/governance/events', (c) => {
  const limit = Number(c.req.query('limit') || '50');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (c.req.query('before') || '').length > 400) return c.json({ error: '治理查询参数不正确。' }, 400);
  try { return c.json(governanceStore.query({ limit, before: c.req.query('before'), runId: c.req.query('runId'), sessionId: c.req.query('sessionId'), agentId: c.req.query('agentId') })); }
  catch { return c.json({ error: '治理记录游标无效，请刷新列表。' }, 400); }
});

app.get('/api/governance/stats', (c) => {
  return c.json(governanceStore.query({ runId: c.req.query('runId'), sessionId: c.req.query('sessionId'), agentId: c.req.query('agentId') }).stats);
});

// ─── D7: WebSocket Route (流式文本通道) ─────────────

app.get('/ws', async (c, next) => {
  if (wss.clients.size >= MAX_WS_CONNECTIONS) return c.json({ error: '连接数量已达上限，请关闭不用的页面后重试。', code: 'WS_CONNECTION_LIMIT' }, 429);
  await next();
}, upgradeWebSocket((c) => {
  return {
    onOpen(_event, ws) {
      if (wsAuthorization.size >= MAX_WS_CONNECTIONS) { ws.close(1008, 'Connection limit'); return; }
      wsAuthorization.set(ws, () => !!access.isAuthorized(c));
      wsMessageWindows.set(ws, new RequestWindow(120));
      // 客户端连接后发一个 join 消息附带 sessionId
      // 暂存到 default 池，等 join 消息后移动
      const defaultSet = wsClients.get('__pending__') ?? new Set();
      defaultSet.add(ws);
      wsClients.set('__pending__', defaultSet);
    },
    onMessage(event, ws) {
      if (!access.isAuthorized(c)) { ws.close(1008, 'Login expired'); return; }
      const window = wsMessageWindows.get(ws);
      if (!window) return;
      if (window.take() || wsMessageWindow.take()) { ws.close(1008, 'Message rate limit'); return; }
      if (typeof event.data !== 'string') { ws.close(1003, 'Text messages only'); return; }
      try {
        const msg = JSON.parse(event.data) as { type: string; sessionId?: string; runId?: string; requestId?: string; approved?: boolean };
        if (msg.type === 'join' && typeof msg.sessionId === 'string' && msg.sessionId) {
          if (!store.listWorkspaces().some(workspace => store.getSession(workspace.id, msg.sessionId!))) {
            ws.send(JSON.stringify({ type: 'error', error: 'Session not found' })); return;
          }
          // 移到对应 session 的连接池
          // A socket belongs to one session; repeated joins must not retain old subscriptions.
          for (const [id, clients] of wsClients) {
            clients.delete(ws);
            if (!clients.size) wsClients.delete(id);
          }
          const sessionSet = wsClients.get(msg.sessionId) ?? new Set();
          sessionSet.add(ws);
          wsClients.set(msg.sessionId, sessionSet);
          ws.send(JSON.stringify({ type: 'joined', sessionId: msg.sessionId }));
        }
        // D1: WebSocket 审批响应
        if (msg.type === 'approval_response' && msg.requestId !== undefined && typeof msg.approved === 'boolean') {
          void approvals.decide(msg.requestId, { approved: msg.approved, runId: msg.runId, sessionId: msg.sessionId })
            .then(approval => ws.send(JSON.stringify({ type: 'approval_decision', approval })))
            .catch(() => { try { ws.send(JSON.stringify({ type: 'approval_error', requestId: msg.requestId, message: '审批已结束或任务归属不匹配，请核对当前会话。' })); } catch { /* Disconnected. */ } });
        }
      } catch { /* ignore non-JSON */ }
    },
    onClose(_event, ws) {
      wsAuthorization.delete(ws);
      wsMessageWindows.delete(ws);
      for (const [id, clients] of wsClients) {
        clients.delete(ws);
        if (!clients.size) wsClients.delete(id);
      }
    },
  };
}));

/** D7: 向 session 的所有 WS 客户端广播文本 */
function wsBroadcast(sessionId: string, data: Record<string, unknown>) {
  const clients = wsClients.get(sessionId);
  if (!clients) return;
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    try {
      if (!wsAuthorization.get(ws)?.()) { ws.close(1008, 'Login expired'); clients.delete(ws); continue; }
      ws.send(msg);
    } catch { /* client disconnected */ }
  }
}

// ─── D1: Approval API (POST) ─────────────────────────

app.post('/api/approval/:requestId', async (c) => {
  const requestId = c.req.param('requestId');
  try {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || typeof body.approved !== 'boolean' || Object.keys(body).some(key => !['approved', 'runId', 'sessionId'].includes(key))) return c.json({ error: '审批只接受 approved、runId 和 sessionId。' }, 400);
    return c.json({ ok: true, approval: await approvals.decide(requestId, body) });
  } catch (error) { return c.json({ error: error instanceof ApprovalError ? error.message : '审批请求无效，未授予执行许可。' }, error instanceof ApprovalError ? error.status : 400); }
});
app.get('/api/approvals', c => {
  const runId = c.req.query('runId'), sessionId = c.req.query('sessionId');
  if (!runId || !sessionId) return c.json({ error: '必须指定 runId 和 sessionId。' }, 400);
  return c.json({ approvals: approvals.list(runId, sessionId) });
});

// 团队导出/导入 API
import { exportTeam, importTeam } from '@tagent/core';

app.get('/api/team/export', (c) => {
  const agents = agentPool.getAllAgents();
  const sanitize = c.req.query('sanitize') !== 'false';
  const data = exportTeam(agents, { removeCredentials: sanitize, anonymize: false });
  return c.json(data);
});

app.post('/api/team/import', async (c) => {
  const body = await c.req.json<{ data: ReturnType<typeof exportTeam>; mode?: 'merge' | 'replace' }>();
  const existingAgents = agentPool.getAllAgents();
  const merged = importTeam(body.data, existingAgents, body.mode || 'merge');
  // Update pool with merged agents
  for (const agent of merged) {
    agentPool.updateAgent(agent.id, agent);
  }
  return c.json({ ok: true, agentCount: merged.length });
});

// ─── Start ───────────────────────────────────────────

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🚀 TAgent Server');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`   Port:     ${PORT}`);
console.log(`   API:      http://localhost:${PORT}/api`);
console.log(`   WS:       ws://localhost:${PORT}/ws`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const defaultWs = store.listWorkspaces()[0];
if (defaultWs) {
  console.log(`   Default:  ${defaultWs.name} (${defaultWs.id})`);
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST });
schedules.start();
server.on('close', () => schedules.stop());
// D7: 注入 WebSocket 升级
injectWebSocket(server);
