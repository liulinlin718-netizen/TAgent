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
import { AnthropicProvider, CostTracker } from '@tagent/ai';
import type { LLMProvider } from '@tagent/ai';
import {
  runAgentLoop,
  ToolRegistry,
  TraceWriter,
  createWebSearchTool,
  createUrlReaderTool,
} from '@tagent/core';
import type { LoopEventHandler } from '@tagent/core';
import { store } from './store.js';
import type { ChatMessage, TraceEvent } from './store.js';

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

// ─── Agent Run (SSE Stream) ──────────────────────────

interface RunRequest {
  message: string;
  workspaceId?: string;
  sessionId?: string;
}

app.post('/api/agent/run', async (c) => {
  const body = await c.req.json<RunRequest>();
  const { message } = body;

  if (!message) return c.json({ error: 'message is required' }, 400);

  // 获取或创建 workspace/session
  let wsId = body.workspaceId;
  let sessId = body.sessionId;

  if (!wsId) {
    const workspaces = store.listWorkspaces();
    wsId = workspaces[0]?.id;
    if (!wsId) {
      const ws = store.createWorkspace('默认工作空间');
      wsId = ws.id;
    }
  }

  if (!sessId) {
    const session = store.createSession(wsId, message.slice(0, 30));
    sessId = session?.id || `sess-${Date.now()}`;
  }

  // 记录用户消息
  store.addMessage(wsId, sessId, {
    id: `msg-${Date.now()}-u`,
    role: 'user',
    content: message,
    timestamp: new Date().toISOString(),
  });

  const { provider, model } = createProvider();
  const tools = new ToolRegistry();
  tools.register(createWebSearchTool());
  tools.register(createUrlReaderTool());

  const traceWriter = new TraceWriter(`./traces/${sessId}.jsonl`);
  const costTracker = new CostTracker();

  return streamSSE(c, async (stream) => {
    // 发送 session 信息
    await stream.writeSSE({
      event: 'session',
      data: JSON.stringify({ workspaceId: wsId, sessionId: sessId }),
    });

    const traces: TraceEvent[] = [];

    const events: LoopEventHandler = {
      onIteration: (i) => {
        const evt = { type: 'iteration', data: { iteration: i }, timestamp: Date.now() };
        traces.push(evt);
        stream.writeSSE({ event: 'iteration', data: JSON.stringify({ iteration: i }) });
      },
      onToolCall: (tool, args) => {
        const evt = { type: 'tool_call', data: { tool, args }, timestamp: Date.now() };
        traces.push(evt);
        stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ tool, args }) });
      },
      onToolResult: (tool, result) => {
        const evt = {
          type: 'tool_result',
          data: { tool, resultLength: result.length, preview: result.slice(0, 200) },
          timestamp: Date.now(),
        };
        traces.push(evt);
        stream.writeSSE({ event: 'tool_result', data: JSON.stringify(evt.data) });
      },
      onTextDelta: (text) => {
        stream.writeSSE({ event: 'text_delta', data: JSON.stringify({ text }) });
      },
      onGovernance: (event) => {
        const evt = { type: 'governance', data: event as Record<string, unknown>, timestamp: Date.now() };
        traces.push(evt);
        stream.writeSSE({ event: 'governance', data: JSON.stringify(event) });
      },
      onComplete: (result) => {
        // 保存 assistant 消息到 session
        store.addMessage(wsId!, sessId!, {
          id: `msg-${Date.now()}-a`,
          role: 'assistant',
          content: result.output,
          timestamp: new Date().toISOString(),
          traces,
          cost: result.totalCost,
          tokens: result.totalTokens,
          iterations: result.iterations,
        });

        stream.writeSSE({
          event: 'complete',
          data: JSON.stringify({
            success: result.success,
            output: result.output,
            iterations: result.iterations,
            totalCost: result.totalCost,
            totalTokens: result.totalTokens,
            workspaceId: wsId,
            sessionId: sessId,
          }),
        });
      },
    };

    try {
      const result = await runAgentLoop(
        {
          id: 'research-agent',
          name: 'Research Agent',
          systemPrompt: `你是 TAgent 的研究助手。帮助用户进行调研和信息收集。

可用工具：
- web_search: 搜索互联网
- read_url: 读取网页内容

工作流程：先搜索 → 找有价值链接 → 深入阅读 → 生成结构化报告。
报告用清晰的中文标题和子标题，列出关键发现和信息来源。
每次只调用一个工具。`,
          provider,
          model,
          tools,
          traceWriter,
          costTracker,
          maxIterations: 10,
          maxCostPerTask: 0.5,
        },
        message,
        events,
      );

      if (!result.success && result.output) {
        store.addMessage(wsId, sessId, {
          id: `msg-${Date.now()}-a`,
          role: 'assistant',
          content: result.output,
          timestamp: new Date().toISOString(),
          traces,
          cost: result.totalCost,
          tokens: result.totalTokens,
          iterations: result.iterations,
        });
        await stream.writeSSE({
          event: 'complete',
          data: JSON.stringify({
            success: false,
            output: result.output,
            iterations: result.iterations,
            totalCost: result.totalCost,
            totalTokens: result.totalTokens,
          }),
        });
      }
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
