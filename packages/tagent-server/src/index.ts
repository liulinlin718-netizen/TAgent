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
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { AnthropicProvider } from '@tagent/ai';
import type { LLMProvider } from '@tagent/ai';
import {
  runOrchestrator,
  AgentPool,
  TraceWriter,
} from '@tagent/core';
import type { OrchestratorEventHandler } from '@tagent/core';
import { store } from './store.js';
import type { ChatMessage, TraceEvent } from './store.js';

// Phase 2: 常驻 Agent 池
const agentPool = new AgentPool();

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
      await runOrchestrator({ provider, model, maxTotalCost: 1.0, agentPool }, message, events);
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
      await runOrchestrator({ provider, model, maxTotalCost: 1.0, agentPool }, message, events);
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

// ─── Start ───────────────────────────────────────────

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🚀 TAgent Server');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`   Port:     ${PORT}`);
console.log(`   API:      http://localhost:${PORT}/api`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const defaultWs = store.listWorkspaces()[0];
if (defaultWs) {
  console.log(`   Default:  ${defaultWs.name} (${defaultWs.id})`);
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

serve({ fetch: app.fetch, port: PORT });
