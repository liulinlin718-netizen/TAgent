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

import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { WSContext } from 'hono/ws';
import { AnthropicProvider } from '@tagent/ai';
import type { LLMProvider } from '@tagent/ai';
import {
  runOrchestrator,
  AgentPool,
  TraceWriter,
  SkillsRegistry,
  MCPRegistry,
  HeartbeatMonitor,
  CronScheduler,
  MetricsCollector,
  SnapshotManager,
} from '@tagent/core';
import type { OrchestratorEventHandler } from '@tagent/core';
import { store } from './store.js';
import type { ChatMessage, TraceEvent } from './store.js';
import { governanceStore } from './governance-store.js';
import * as path from 'path';

const workspaceRoot = path.resolve(process.cwd(), '../..');
const agentPool = new AgentPool();
const skillsRegistry = new SkillsRegistry(workspaceRoot);
const mcpRegistry = new MCPRegistry(workspaceRoot);
// D15/D16/D17: Runtime infrastructure
const heartbeat = new HeartbeatMonitor();
const cron = new CronScheduler();
const metrics = new MetricsCollector();
const snapshots = new SnapshotManager();

// 初始化 agent 池配置 (加载持久化的 skills 和 tools 绑定)
await agentPool.initialize(workspaceRoot);

// D7: WebSocket 双通道 — 活跃的 WS 连接 (sessionId → WSContext)
const wsClients = new Map<string, Set<WSContext>>();

// D1: 待审批请求缓存 (requestId → resolve callback)
const pendingApprovals = new Map<string, (approved: boolean) => void>();

// ─── Config ──────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3001');

function createProvider(): { provider: LLMProvider; model: string } {
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      provider: new AnthropicProvider({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: 'https://api.deepseek.com/anthropic',
        name: 'deepseek',
      }),
      model: 'deepseek-chat',
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: new AnthropicProvider(), model: 'claude-sonnet-4-20250514' };
  }
  throw new Error('No API key set. Set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY.');
}

// ─── App ─────────────────────────────────────────────

const app = new Hono();

// D7: WebSocket 升级中间件
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use('*', cors({
  origin: ['http://localhost:3000', 'http://localhost:3001'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowHeaders: ['Content-Type'],
}));

app.get('/api/health', (c) => c.json({
  status: 'ok',
  timestamp: new Date().toISOString(),
  provider: process.env.DEEPSEEK_API_KEY ? 'deepseek' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'none',
}));

// ─── Workspace API ───────────────────────────────────

app.get('/api/workspaces', (c) => {
  return c.json({ workspaces: store.listWorkspaces() });
});

app.post('/api/workspaces', async (c) => {
  const { name, description } = await c.req.json<{ name: string; description?: string }>();
  const ws = store.createWorkspace(name, description);
  return c.json(ws, 201);
});

app.get('/api/workspaces/:wsId', (c) => {
  const ws = store.getWorkspace(c.req.param('wsId'));
  if (!ws) return c.json({ error: 'Workspace not found' }, 404);
  return c.json(ws);
});

app.delete('/api/workspaces/:wsId', (c) => {
  store.deleteWorkspace(c.req.param('wsId'));
  return c.json({ ok: true });
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

  const session = store.createSession(
    wsId,
    body.title || '新对话',
    body.creationType || 'new',
    body.parentSessionId || null,
  );

  if (!session) return c.json({ error: 'Workspace not found' }, 404);
  return c.json(session, 201);
});

app.get('/api/workspaces/:wsId/sessions/:sessId', (c) => {
  const session = store.getSession(c.req.param('wsId'), c.req.param('sessId'));
  if (!session) return c.json({ error: 'Session not found' }, 404);
  return c.json(session);
});

// Fix 4: Session 删除 API (Gap 3)
app.delete('/api/workspaces/:wsId/sessions/:sessId', (c) => {
  const deleted = store.deleteSession(c.req.param('wsId'), c.req.param('sessId'));
  if (!deleted) return c.json({ error: 'Session not found' }, 404);
  return c.json({ ok: true });
});

// Phase 3b: Session 分支与树形查询 API

app.get('/api/workspaces/:wsId/sessions/tree', (c) => {
  const sessions = store.listSessions(c.req.param('wsId'));
  // Build tree logic here or just return all sessions with parentId and let frontend build it
  return c.json({ sessions });
});

app.post('/api/workspaces/:wsId/sessions/:sessId/fork', async (c) => {
  const wsId = c.req.param('wsId');
  const sessId = c.req.param('sessId');
  const body = await c.req.json<{ forkType: 'fork_full' | 'fork_summary' }>();
  
  let summaryText = undefined;

  if (body.forkType === 'fork_summary') {
    const sourceSession = store.getSession(wsId, sessId);
    if (!sourceSession) return c.json({ error: 'Source session not found' }, 404);
    
    // Generate summary using LLM
    const historyText = sourceSession.messages.map(m => `${m.role}: ${m.content}`).join('\n');
    const response = await provider.call({
      model,
      messages: [{ 
        role: 'system', 
        content: `请对以下对话历史进行摘要压缩，提取核心结论、当前的进展状态以及关键的决策点。摘要需简明扼要。` 
      }, {
        role: 'user',
        content: historyText
      }],
      maxTokens: 1000
    });
    summaryText = response.content;
  }

  const newSession = store.forkSession(wsId, sessId, body.forkType, summaryText);
  if (!newSession) return c.json({ error: 'Failed to fork session' }, 500);

  return c.json(newSession, 201);
});

app.post('/api/workspaces/:wsId/sessions/:sessId/merge-to-parent', async (c) => {
  const wsId = c.req.param('wsId');
  const sessId = c.req.param('sessId');
  const body = await c.req.json<{ text?: string }>().catch(() => ({}));

  const childSession = store.getSession(wsId, sessId);
  if (!childSession || !childSession.parentSessionId) {
    return c.json({ error: 'Source session or parent not found' }, 404);
  }

  const parentSession = store.getSession(wsId, childSession.parentSessionId);
  if (!parentSession) {
    return c.json({ error: 'Parent session not found' }, 404);
  }
  
  let summaryText = body.text;
  if (!summaryText) {
    // Generate summary of child branch using LLM
    const historyText = childSession.messages.map(m => `${m.role}: ${m.content}`).join('\n');
    const response = await provider.call({
      model,
      messages: [{ 
        role: 'system', 
        content: `你是一个合并助手。请总结以下对话历史中的最终结论、所做出的关键决策以及有价值的方案，准备将其合并回主干对话。以列表或简短段落形式输出，直接给出内容，无需客套。` 
      }, {
        role: 'user',
        content: historyText
      }],
      maxTokens: 1000
    });
    summaryText = response.content;
  }

  // Add message to parent
  store.addMessage(wsId, parentSession.id, {
    id: `msg-${Date.now()}-merge`,
    role: 'assistant',
    content: `**[来自探索分支 "${childSession.title}"]**\n\n${summaryText}`,
    timestamp: new Date().toISOString(),
    traces: []
  });

  return c.json({ ok: true, parentSessionId: parentSession.id });
});

// D3: 结论摘取 API
app.get('/api/workspaces/:wsId/sessions/:sessId/conclusions', (c) => {
  const conclusions = store.extractConclusions(c.req.param('wsId'), c.req.param('sessId'));
  return c.json({ conclusions });
});

// D4: 跨 Session 记忆继承 API
app.get('/api/workspaces/:wsId/sessions/:sessId/memory', (c) => {
  const depth = parseInt(c.req.query('depth') || '3');
  const memories = store.getSessionMemory(c.req.param('wsId'), c.req.param('sessId'), depth);
  return c.json({ memories });
});

// V3b.2/V3b.3: Session 消息列表 API（Diff 视图 + 摘要 Fork 验证）
app.get('/api/workspaces/:wsId/sessions/:sessId/messages', (c) => {
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
}

app.post('/api/agent/run', async (c) => {
  // 直接复用 orchestrate 端点的完整流程
  const body = await c.req.json<RunRequest>();
  const { message } = body;
  if (!message) return c.json({ error: 'message is required' }, 400);

  let wsId = body.workspaceId;
  let sessId = body.sessionId;

  if (!wsId) {
    const workspaces = store.listWorkspaces();
    wsId = workspaces[0]?.id;
    if (!wsId) { wsId = store.createWorkspace('默认工作空间').id; }
  }
  if (!sessId) {
    const session = store.createSession(wsId, message.slice(0, 30));
    sessId = session?.id || `sess-${Date.now()}`;
  }

  store.addMessage(wsId, sessId, {
    id: `msg-${Date.now()}-u`, role: 'user', content: message, timestamp: new Date().toISOString(),
  });

  const { provider, model } = createProvider();

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'session', data: JSON.stringify({ workspaceId: wsId, sessionId: sessId }) });

    const traces: TraceEvent[] = [];

    const events: OrchestratorEventHandler = {
      onTaskDecomposition: (tasks) => {
        traces.push({ type: 'task_decomposition', data: { tasks } as Record<string, unknown>, timestamp: Date.now() });
        stream.writeSSE({ event: 'task_decomposition', data: JSON.stringify({ tasks }) });
      },
      onAgentSpawned: (agent, task) => {
        const d = { agentId: agent.id, agentName: agent.name, icon: agent.icon, taskId: task.id, objective: task.objective };
        traces.push({ type: 'agent_spawn', data: d as Record<string, unknown>, timestamp: Date.now() });
        stream.writeSSE({ event: 'agent_spawn', data: JSON.stringify(d) });
      },
      onAgentProgress: (agentId, iteration) => {
        traces.push({ type: 'agent_progress', data: { agentId, iteration } as Record<string, unknown>, timestamp: Date.now() });
        stream.writeSSE({ event: 'agent_progress', data: JSON.stringify({ agentId, iteration }) });
      },
      onAgentToolCall: (agentId, tool, args) => {
        traces.push({ type: 'agent_tool_call', data: { agentId, tool, args } as Record<string, unknown>, timestamp: Date.now() });
        stream.writeSSE({ event: 'agent_tool_call', data: JSON.stringify({ agentId, tool, args }) });
      },
      onAgentToolResult: (agentId, tool, resultLength) => {
        stream.writeSSE({ event: 'agent_tool_result', data: JSON.stringify({ agentId, tool, resultLength }) });
      },
      onAgentComplete: (agentId, result) => {
        const d = { agentId, success: result.success, iterations: result.iterations, cost: result.totalCost };
        traces.push({ type: 'agent_complete', data: d as Record<string, unknown>, timestamp: Date.now() });
        stream.writeSSE({ event: 'agent_complete', data: JSON.stringify(d) });
      },
      onAgentFailed: (agentId, error) => {
        stream.writeSSE({ event: 'agent_failed', data: JSON.stringify({ agentId, error }) });
      },
      onGovernanceEvent: (agentId, event) => {
        traces.push({ type: 'governance', data: { agentId, ...event } as Record<string, unknown>, timestamp: Date.now() });
        stream.writeSSE({ event: 'governance', data: JSON.stringify({ agentId, ...event }) });
        // Phase 4: 记录治理事件到仓库 — 完整决策链数据
        governanceStore.record({
          agentId,
          policyType: event.policyType,
          ruleName: event.ruleName || event.policyType,
          severity: event.severity,
          result: event.result,
          message: event.message,
          suggestion: event.suggestion,
        });
      },
      onSynthesisStart: () => {
        stream.writeSSE({ event: 'synthesis_start', data: '{}' });
      },
      onTextDelta: (text) => {
        stream.writeSSE({ event: 'text_delta', data: JSON.stringify({ text }) });
      },
      onComplete: (result) => {
        store.addMessage(wsId!, sessId!, {
          id: `msg-${Date.now()}-a`, role: 'assistant', content: result.output,
          timestamp: new Date().toISOString(), traces,
          cost: result.totalCost, tokens: result.totalTokens, iterations: result.subResults.length,
        });
        stream.writeSSE({
          event: 'complete',
          data: JSON.stringify({
            success: result.success, output: result.output, subResults: result.subResults,
            totalCost: result.totalCost, totalTokens: result.totalTokens,
            workspaceId: wsId, sessionId: sessId,
          }),
        });
      },
    };

    try {
      const govTemplate = body.governanceTemplate || 'standard';
      await runOrchestrator({ provider, model, maxTotalCost: 1.0, agentPool, skillsRegistry, mcpRegistry, governanceTemplate: govTemplate }, message, events);
    } catch (error) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
      });
    }
  });
});

// ─── Agent Pool API (Phase 2) ────────────────────────

app.get('/api/agents', (c) => {
  return c.json({ agents: agentPool.getAllAgents() });
});

app.get('/api/agents/resident', (c) => {
  return c.json({ agents: agentPool.getResidentAgents() });
});

app.get('/api/agents/:id', (c) => {
  const agent = agentPool.getAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  return c.json(agent);
});

// Phase 3a: Skills & MCP API

app.get('/api/skills', async (c) => {
  return c.json({ skills: await skillsRegistry.getSkills() });
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
          content: `你是一个 TAgent Skill 创建助手。根据用户描述的任务场景，生成一个 Skill 定义草稿。

Skill 格式（Markdown）：
---
name: skill-name
description: 一句话描述
version: 1.0.0
tags: [tag1, tag2]
---

## 执行步骤

1. **步骤一**: 描述
2. **步骤二**: 描述
3. **步骤三**: 描述

## 输出格式

描述期望的输出格式。

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
    return c.json({ error: err instanceof Error ? err.message : 'LLM call failed' }, 500);
  }
});

app.get('/api/mcp', async (c) => {
  return c.json({ servers: await mcpRegistry.getServers() });
});

app.post('/api/mcp', async (c) => {
  const body = await c.req.json();
  const server = await mcpRegistry.addServer(body);
  return c.json(server, 201);
});

app.put('/api/mcp/:id', async (c) => {
  const body = await c.req.json();
  const server = await mcpRegistry.updateServer(c.req.param('id'), body);
  return c.json(server);
});

app.delete('/api/mcp/:id', async (c) => {
  await mcpRegistry.deleteServer(c.req.param('id'));
  return c.json({ ok: true });
});

// D17: 性能指标 API
app.get('/api/metrics', (c) => {
  return c.json(metrics.getMetrics());
});

// D15: 心跳状态 API
app.get('/api/heartbeat', (c) => {
  return c.json({ agents: heartbeat.checkAll() });
});
app.post('/api/heartbeat/:agentId', async (c) => {
  const body = await c.req.json<{ metadata?: Record<string, unknown> }>().catch(() => ({}));
  heartbeat.beat(c.req.param('agentId'), (body as { metadata?: Record<string, unknown> }).metadata);
  return c.json({ ok: true });
});

// D16: Cron 调度 API
app.get('/api/cron', (c) => {
  return c.json({ jobs: cron.listJobs() });
});
app.post('/api/cron', async (c) => {
  const body = await c.req.json<{ name: string; intervalMs: number; taskMessage: string; workspaceId?: string }>();
  const job = cron.addJob({ ...body, enabled: true });
  return c.json(job, 201);
});
app.delete('/api/cron/:id', (c) => {
  cron.removeJob(c.req.param('id'));
  return c.json({ ok: true });
});

// Agent Override API (绑定 Skills/Tools)
app.post('/api/agents/:id/override', async (c) => {
  const { skills, mcpServers } = await c.req.json();
  await agentPool.updateAgentOverride(c.req.param('id'), skills, mcpServers);
  const updatedAgent = agentPool.getAgent(c.req.param('id'));
  return c.json(updatedAgent);
});

// ─── Orchestrate API (Phase 2: Multi-Agent SSE) ──────

app.post('/api/agent/orchestrate', async (c) => {
  const body = await c.req.json<RunRequest>();
  const { message } = body;
  if (!message) return c.json({ error: 'message is required' }, 400);

  let wsId = body.workspaceId;
  let sessId = body.sessionId;

  if (!wsId) {
    const workspaces = store.listWorkspaces();
    wsId = workspaces[0]?.id;
    if (!wsId) { wsId = store.createWorkspace('默认工作空间').id; }
  }
  if (!sessId) {
    const session = store.createSession(wsId, message.slice(0, 30));
    sessId = session?.id || `sess-${Date.now()}`;
  }

  store.addMessage(wsId, sessId, {
    id: `msg-${Date.now()}-u`, role: 'user', content: message, timestamp: new Date().toISOString(),
  });

  const { provider, model } = createProvider();

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'session', data: JSON.stringify({ workspaceId: wsId, sessionId: sessId }) });

    const traces: TraceEvent[] = [];

    const events: OrchestratorEventHandler = {
      onTaskDecomposition: (tasks) => {
        const evt = { type: 'task_decomposition', data: { tasks } as Record<string, unknown>, timestamp: Date.now() };
        traces.push(evt);
        stream.writeSSE({ event: 'task_decomposition', data: JSON.stringify({ tasks }) });
      },
      onAgentSpawned: (agent, task) => {
        const evt = { type: 'agent_spawn', data: { agentId: agent.id, agentName: agent.name, icon: agent.icon, taskId: task.id, objective: task.objective } as Record<string, unknown>, timestamp: Date.now() };
        traces.push(evt);
        stream.writeSSE({ event: 'agent_spawn', data: JSON.stringify(evt.data) });
      },
      onAgentProgress: (agentId, iteration) => {
        const evt = { type: 'agent_progress', data: { agentId, iteration } as Record<string, unknown>, timestamp: Date.now() };
        traces.push(evt);
        stream.writeSSE({ event: 'agent_progress', data: JSON.stringify({ agentId, iteration }) });
      },
      onAgentToolCall: (agentId, tool, args) => {
        stream.writeSSE({ event: 'agent_tool_call', data: JSON.stringify({ agentId, tool, args }) });
      },
      onAgentToolResult: (agentId, tool, resultLength) => {
        stream.writeSSE({ event: 'agent_tool_result', data: JSON.stringify({ agentId, tool, resultLength }) });
      },
      onAgentComplete: (agentId, result) => {
        const evt = { type: 'agent_complete', data: { agentId, success: result.success, iterations: result.iterations, cost: result.totalCost } as Record<string, unknown>, timestamp: Date.now() };
        traces.push(evt);
        stream.writeSSE({ event: 'agent_complete', data: JSON.stringify(evt.data) });
      },
      onAgentFailed: (agentId, error) => {
        stream.writeSSE({ event: 'agent_failed', data: JSON.stringify({ agentId, error }) });
      },
      onGovernanceEvent: (agentId, event) => {
        const evt = { type: 'governance', data: { agentId, ...event } as Record<string, unknown>, timestamp: Date.now() };
        traces.push(evt);
        stream.writeSSE({ event: 'governance', data: JSON.stringify({ agentId, ...event }) });
      },
      onSynthesisStart: () => {
        stream.writeSSE({ event: 'synthesis_start', data: '{}' });
      },
      onTextDelta: (text) => {
        stream.writeSSE({ event: 'text_delta', data: JSON.stringify({ text }) });
        // D7: 同时通过 WebSocket 广播流式文本
        if (sessId) wsBroadcast(sessId, { type: 'text_delta', text });
      },
      onComplete: (result) => {
        store.addMessage(wsId!, sessId!, {
          id: `msg-${Date.now()}-a`, role: 'assistant', content: result.output,
          timestamp: new Date().toISOString(), traces,
          cost: result.totalCost, tokens: result.totalTokens, iterations: result.subResults.length,
        });
        stream.writeSSE({
          event: 'complete',
          data: JSON.stringify({
            success: result.success, output: result.output, subResults: result.subResults,
            totalCost: result.totalCost, totalTokens: result.totalTokens,
            workspaceId: wsId, sessionId: sessId,
          }),
        });
      },
    };

    try {
      await runOrchestrator({ provider, model, maxTotalCost: 1.0, agentPool, skillsRegistry, mcpRegistry }, message, events);
    } catch (error) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
      });
    }
  });
});

// ─── Trace API ───────────────────────────────────────

app.get('/api/trace/:sessionId', (c) => {
  const traceWriter = new TraceWriter(`./traces/${c.req.param('sessionId')}.jsonl`);
  return c.json({ entries: traceWriter.readAll() });
});

// ─── Governance API (Phase 4) ──────────────────────

app.get('/api/governance/events', (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  return c.json({ events: governanceStore.getEvents(limit) });
});

app.get('/api/governance/stats', (c) => {
  return c.json(governanceStore.getStats());
});

// ─── D7: WebSocket Route (流式文本通道) ─────────────

app.get('/ws', upgradeWebSocket((c) => {
  return {
    onOpen(_event, ws) {
      // 客户端连接后发一个 join 消息附带 sessionId
      // 暂存到 default 池，等 join 消息后移动
      const defaultSet = wsClients.get('__pending__') ?? new Set();
      defaultSet.add(ws);
      wsClients.set('__pending__', defaultSet);
    },
    onMessage(event, ws) {
      try {
        const msg = JSON.parse(String(event.data)) as { type: string; sessionId?: string; requestId?: string; approved?: boolean };
        if (msg.type === 'join' && msg.sessionId) {
          // 移到对应 session 的连接池
          wsClients.get('__pending__')?.delete(ws);
          const sessionSet = wsClients.get(msg.sessionId) ?? new Set();
          sessionSet.add(ws);
          wsClients.set(msg.sessionId, sessionSet);
          ws.send(JSON.stringify({ type: 'joined', sessionId: msg.sessionId }));
        }
        // D1: WebSocket 审批响应
        if (msg.type === 'approval_response' && msg.requestId !== undefined) {
          const resolver = pendingApprovals.get(msg.requestId);
          if (resolver) {
            resolver(msg.approved === true);
            pendingApprovals.delete(msg.requestId);
          }
        }
      } catch { /* ignore non-JSON */ }
    },
    onClose(_event, ws) {
      for (const [, clients] of wsClients) {
        clients.delete(ws);
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
    try { ws.send(msg); } catch { /* client disconnected */ }
  }
}

// ─── D1: Approval API (POST) ─────────────────────────

app.post('/api/approval/:requestId', async (c) => {
  const requestId = c.req.param('requestId');
  const { approved } = await c.req.json<{ approved: boolean }>();
  const resolver = pendingApprovals.get(requestId);
  if (!resolver) return c.json({ error: 'No pending approval with this ID' }, 404);
  resolver(approved);
  pendingApprovals.delete(requestId);
  return c.json({ ok: true });
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

// 时间旅行 API (plan §4.3)
app.get('/api/workspaces/:wsId/sessions/:sessId/snapshots', (c) => {
  const list = snapshots.listBySession(c.req.param('sessId'));
  return c.json({ snapshots: list.map(s => ({ ...s, messagesSnapshot: undefined })) }); // 不返回完整消息
});

app.get('/api/snapshots/:id', (c) => {
  const snapshot = snapshots.get(c.req.param('id'));
  if (!snapshot) return c.json({ error: 'Snapshot not found' }, 404);
  return c.json(snapshot);
});

app.post('/api/snapshots/:id/fork', async (c) => {
  const snapshot = snapshots.get(c.req.param('id'));
  if (!snapshot) return c.json({ error: 'Snapshot not found' }, 404);

  // 从快照点 Fork 一个新 Session
  const ws = store.listWorkspaces()[0];
  if (!ws) return c.json({ error: 'No workspace' }, 400);

  const forkedSession = store.forkSession(ws.id, snapshot.sessionId, 'fork_full');
  return c.json({ session: forkedSession, fromSnapshot: snapshot.id });
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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  // D7: 注入 WebSocket 升级
  injectWebSocket(info.server);
});
