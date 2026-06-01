/**
 * Orchestrator — 多 Agent 编排器 (plan §3.4 ③b 裂变)
 *
 * 3 阶段流程：
 *   ① LLM 分解任务（判断复杂度，拆分子任务）
 *   ② 并行分派子 Agent（Promise.all，隔离上下文）
 *   ③ LLM 综合结果（收集摘要，生成最终报告）
 *
 * 关键设计（按产品初心）：
 * - 子 Agent 隔离上下文（← Claude Code）
 * - 只返回摘要（← Claude Code 摘要返回）
 * - 并行执行（Promise.all）
 * - 简单任务自动降级为单 Agent
 */

import type { LLMProvider } from '@tagent/ai';
import { CostTracker } from '@tagent/ai';
import { runAgentLoop, type AgentLoopResult, type LoopEventHandler } from './agent-loop.js';
import { ToolRegistry } from './tools/registry.js';
import { createWebSearchTool } from './tools/web-search.js';
import { createUrlReaderTool } from './tools/url-reader.js';
import { TraceWriter } from './trace.js';
import { AgentPool, AGENT_SOULS } from './agent-pool.js';
import { GovernanceEngine, type GovernanceContext } from './governance.js';
import {
  MessageBus,
  type TaskRequestPayload,
  type TaskCompletePayload,
  type TaskFailedPayload,
} from './protocol.js';
import type { AgentCard } from './agent-card.js';

// ─── Types ───────────────────────────────────────────

export interface OrchestratorConfig {
  provider: LLMProvider;
  model: string;
  maxTotalCost?: number;
}

export interface SubTask {
  id: string;
  agentRole: string;   // 'research' | 'document' | 'data'
  objective: string;
  context?: string;
}

export interface OrchestratorResult {
  success: boolean;
  output: string;
  subResults: { agentId: string; agentName: string; summary: string; cost: number }[];
  totalCost: number;
  totalTokens: { input: number; output: number };
}

export interface OrchestratorEventHandler {
  onTaskDecomposition?: (tasks: SubTask[]) => void;
  onAgentSpawned?: (agent: AgentCard, task: SubTask) => void;
  onAgentProgress?: (agentId: string, iteration: number) => void;
  onAgentToolCall?: (agentId: string, tool: string, args: Record<string, unknown>) => void;
  onAgentToolResult?: (agentId: string, tool: string, resultLength: number) => void;
  onAgentComplete?: (agentId: string, result: AgentLoopResult) => void;
  onAgentFailed?: (agentId: string, error: string) => void;
  onGovernanceEvent?: (agentId: string, event: { type: string; message: string }) => void;
  onSynthesisStart?: () => void;
  onTextDelta?: (text: string) => void;
  onComplete?: (result: OrchestratorResult) => void;
}

// ─── Orchestrator ────────────────────────────────────

export async function runOrchestrator(
  config: OrchestratorConfig,
  userMessage: string,
  events?: OrchestratorEventHandler,
): Promise<OrchestratorResult> {
  const { provider, model, maxTotalCost = 1.0 } = config;
  const pool = new AgentPool();
  const bus = new MessageBus();
  const governance = new GovernanceEngine('standard');
  const globalCostTracker = new CostTracker();

  // ── Step 1: 任务分解 ──

  const decomposition = await decomposeTask(provider, model, userMessage, globalCostTracker);
  events?.onTaskDecomposition?.(decomposition);

  if (decomposition.length === 0) {
    return runSingleAgent(provider, model, pool, userMessage, globalCostTracker, events);
  }

  // ── Step 2: 并行分派 ──

  const subResults: { agentId: string; agentName: string; summary: string; cost: number }[] = [];
  const taskPromises: Promise<void>[] = [];

  for (const task of decomposition) {
    const agentId = matchAgent(task.agentRole);
    const agentCard = pool.getAgent(agentId);
    if (!agentCard) continue;

    // 治理检查
    const govCtx: GovernanceContext = {
      agentId,
      currentCost: globalCostTracker.totalCost,
      maxCost: maxTotalCost,
      currentIterations: 0,
      maxIterations: 10,
      approvalMode: agentCard.constraints.approvalMode,
      fissionDepth: 0,
      maxFissionDepth: agentCard.constraints.maxFissionDepth,
    };

    const govResult = governance.evaluate(govCtx);
    if (!govResult.allPassed) {
      const blocker = govResult.blockers[0];
      events?.onGovernanceEvent?.(agentId, {
        type: blocker.event.policyType,
        message: blocker.event.message,
      });
      continue;
    }

    pool.updateState(agentId, { business: 'busy' });
    events?.onAgentSpawned?.(agentCard, task);

    bus.send(MessageBus.createMessage<TaskRequestPayload>(
      'TaskRequest', 'orchestrator', agentId,
      { taskId: task.id, objective: task.objective, context: task.context },
    ));

    // 并行执行
    const taskPromise = executeSubAgent(
      provider, model, agentCard, task, globalCostTracker, pool, events,
    ).then(result => {
      pool.updateState(agentId, { business: 'idle' });

      if (result.success) {
        subResults.push({
          agentId,
          agentName: agentCard.name,
          summary: result.output.slice(0, 2000),
          cost: result.totalCost,
        });
        bus.send(MessageBus.createMessage<TaskCompletePayload>(
          'TaskComplete', agentId, 'orchestrator',
          {
            taskId: task.id,
            summary: result.output.slice(0, 500),
            fullResult: result.output,
            cost: result.totalCost,
            tokens: result.totalTokens,
            iterations: result.iterations,
          },
        ));
        events?.onAgentComplete?.(agentId, result);
      } else {
        bus.send(MessageBus.createMessage<TaskFailedPayload>(
          'TaskFailed', agentId, 'orchestrator',
          { taskId: task.id, error: result.output, attemptedStrategies: [] },
        ));
        events?.onAgentFailed?.(agentId, result.output);
      }
    });

    taskPromises.push(taskPromise);
  }

  await Promise.all(taskPromises);

  // ── Step 3: 综合报告 ──

  events?.onSynthesisStart?.();

  const finalOutput = await synthesizeResults(
    provider, model, userMessage, subResults, globalCostTracker, events,
  );

  const result: OrchestratorResult = {
    success: true,
    output: finalOutput,
    subResults,
    totalCost: globalCostTracker.totalCost,
    totalTokens: globalCostTracker.totalTokens,
  };

  events?.onComplete?.(result);
  return result;
}

// ─── Task Decomposition ──────────────────────────────

async function decomposeTask(
  provider: LLMProvider,
  model: string,
  userMessage: string,
  costTracker: CostTracker,
): Promise<SubTask[]> {
  const response = await provider.call({
    model,
    messages: [
      {
        role: 'system',
        content: `你是任务编排器。分析用户任务，判断是否需要多个 Agent 协作。

如果任务简单（如"搜索X"、"解释Y"），返回空数组 []。
如果任务复杂（如"做竞品分析"、"生成调研报告"），拆分为子任务。

每个子任务必须包含:
- id: 唯一标识
- agentRole: "research" | "document" | "data"
- objective: 具体目标

返回 JSON 数组格式，不要其他文字。

示例输出:
[
  {"id":"t1","agentRole":"research","objective":"搜索支付Agent行业的最新产品和技术方案"},
  {"id":"t2","agentRole":"research","objective":"搜索支付Agent的商业模式和融资情况"},
  {"id":"t3","agentRole":"document","objective":"基于研究数据生成支付Agent现状调研报告"}
]`,
      },
      { role: 'user', content: userMessage },
    ],
    maxTokens: 800,
    temperature: 0.2,
  });

  costTracker.record(model, response.usage, { agentId: 'orchestrator', traceId: 'decomposition' });

  try {
    const match = response.content.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const tasks = JSON.parse(match[0]) as SubTask[];
    return Array.isArray(tasks) ? tasks : [];
  } catch {
    return [];
  }
}

// ─── Sub Agent Execution ─────────────────────────────

async function executeSubAgent(
  provider: LLMProvider,
  model: string,
  agentCard: AgentCard,
  task: SubTask,
  globalCostTracker: CostTracker,
  pool: AgentPool,
  events?: OrchestratorEventHandler,
): Promise<AgentLoopResult> {
  const tools = new ToolRegistry();
  tools.register(createWebSearchTool());
  tools.register(createUrlReaderTool());

  const traceWriter = new TraceWriter(`./traces/${agentCard.id}-${task.id}.jsonl`);
  const localCostTracker = new CostTracker();

  const soul = AGENT_SOULS[agentCard.id] || agentCard.description;

  const loopEvents: LoopEventHandler = {
    onIteration: (i) => events?.onAgentProgress?.(agentCard.id, i),
    onToolCall: (tool, args) => events?.onAgentToolCall?.(agentCard.id, tool, args),
    onToolResult: (tool, result) => events?.onAgentToolResult?.(agentCard.id, tool, result.length),
    onGovernance: (event) => events?.onGovernanceEvent?.(agentCard.id, event),
  };

  // 隔离上下文: 子 Agent 只接收任务目标
  const result = await runAgentLoop(
    {
      id: agentCard.id,
      name: agentCard.name,
      systemPrompt: `${soul}\n\n## 当前任务\n${task.objective}${task.context ? `\n\n## 上下文\n${task.context}` : ''}`,
      provider,
      model,
      tools,
      traceWriter,
      costTracker: localCostTracker,
      maxIterations: 6,
      maxCostPerTask: agentCard.constraints.maxCostPerTask,
    },
    task.objective,
    loopEvents,
  );

  // 同步到全局成本
  globalCostTracker.record(model, {
    inputTokens: localCostTracker.totalTokens.input,
    outputTokens: localCostTracker.totalTokens.output,
    cost: localCostTracker.totalCost,
  }, { agentId: agentCard.id });

  return result;
}

// ─── Result Synthesis ────────────────────────────────

async function synthesizeResults(
  provider: LLMProvider,
  model: string,
  originalTask: string,
  subResults: { agentId: string; agentName: string; summary: string; cost: number }[],
  costTracker: CostTracker,
  events?: OrchestratorEventHandler,
): Promise<string> {
  if (subResults.length === 0) return '所有子任务均未返回结果。';

  const summaries = subResults.map(r =>
    `### ${r.agentName} 的报告\n${r.summary}`
  ).join('\n\n---\n\n');

  const response = await provider.call({
    model,
    messages: [
      {
        role: 'system',
        content: `你是报告综合助手。将多个子 Agent 的调研结果综合为一份完整、结构化的中文报告。

要求：
1. 使用清晰的标题结构
2. 整合而非简单拼接各部分内容
3. 消除重复信息
4. 添加总结和关键洞察
5. 标注信息来源`,
      },
      {
        role: 'user',
        content: `原始任务: ${originalTask}\n\n## 子 Agent 报告\n\n${summaries}`,
      },
    ],
    maxTokens: 4000,
    temperature: 0.3,
  });

  costTracker.record(model, response.usage, { agentId: 'orchestrator', traceId: 'synthesis' });

  events?.onTextDelta?.(response.content);
  return response.content;
}

// ─── Single Agent Fallback ───────────────────────────

async function runSingleAgent(
  provider: LLMProvider,
  model: string,
  pool: AgentPool,
  userMessage: string,
  costTracker: CostTracker,
  events?: OrchestratorEventHandler,
): Promise<OrchestratorResult> {
  const agent = pool.getAgent('research-agent')!;
  pool.updateState(agent.id, { business: 'busy' });

  events?.onAgentSpawned?.(agent, { id: 't-single', agentRole: 'research', objective: userMessage });

  const tools = new ToolRegistry();
  tools.register(createWebSearchTool());
  tools.register(createUrlReaderTool());

  const traceWriter = new TraceWriter(`./traces/single-${Date.now()}.jsonl`);
  const localCostTracker = new CostTracker();

  const result = await runAgentLoop(
    {
      id: agent.id,
      name: agent.name,
      systemPrompt: AGENT_SOULS[agent.id] || agent.description,
      provider,
      model,
      tools,
      traceWriter,
      costTracker: localCostTracker,
      maxIterations: 10,
      maxCostPerTask: 0.5,
    },
    userMessage,
    {
      onIteration: (i) => events?.onAgentProgress?.(agent.id, i),
      onToolCall: (t, a) => events?.onAgentToolCall?.(agent.id, t, a),
      onToolResult: (t, r) => events?.onAgentToolResult?.(agent.id, t, r.length),
      onTextDelta: (text) => events?.onTextDelta?.(text),
      onGovernance: (ev) => events?.onGovernanceEvent?.(agent.id, ev),
    },
  );

  pool.updateState(agent.id, { business: 'idle' });

  costTracker.record(model, {
    inputTokens: localCostTracker.totalTokens.input,
    outputTokens: localCostTracker.totalTokens.output,
    cost: localCostTracker.totalCost,
  }, { agentId: agent.id });

  return {
    success: result.success,
    output: result.output,
    subResults: [{ agentId: agent.id, agentName: agent.name, summary: result.output, cost: localCostTracker.totalCost }],
    totalCost: costTracker.totalCost,
    totalTokens: costTracker.totalTokens,
  };
}

// ─── Helpers ─────────────────────────────────────────

function matchAgent(role: string): string {
  const map: Record<string, string> = {
    research: 'research-agent',
    document: 'document-agent',
    data: 'data-agent',
  };
  return map[role] || 'research-agent';
}
