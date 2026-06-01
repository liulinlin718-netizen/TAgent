/**
 * Agent Loop — 系统心脏
 *
 * 7步标准循环：
 *   ⓪ Snapshot (状态快照)
 *   ① Planning (规划)
 *   ② Decision (决策) — LLM 决定行动
 *   ③ Execute (执行工具 / 裂变 / Explore / 直接回复)
 *   ④ Governance (治理检查点)
 *   ⑤ Trace (记录)
 *   ⑥ Verify (验证目标是否达成)
 *   ⑦ Output (输出)
 *
 * 参考: Claude Code Loop, Codex CLI, OpenCode
 */

import type { LLMProvider, LLMResponse, Message, ToolDefinition, ToolCall } from '@tagent/ai';
import { CostTracker } from '@tagent/ai';
import { TraceWriter, type TraceSpan, type TraceEntry } from './trace.js';
import { ToolRegistry } from './tools/registry.js';

// ─── Types ───────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  systemPrompt: string;
  provider: LLMProvider;
  model: string;
  tools: ToolRegistry;
  traceWriter: TraceWriter;
  costTracker: CostTracker;
  maxIterations?: number;
  maxCostPerTask?: number; // USD — 治理资源协议
}

export interface AgentLoopResult {
  success: boolean;
  output: string;
  iterations: number;
  totalCost: number;
  totalTokens: { input: number; output: number };
  traceFile: string;
}

export interface LoopEventHandler {
  onIteration?: (iteration: number) => void;
  onPlanning?: (content: string) => void;
  onToolCall?: (tool: string, args: Record<string, unknown>) => void;
  onToolResult?: (tool: string, result: string) => void;
  onTextDelta?: (text: string) => void;
  onGovernance?: (event: { type: string; message: string }) => void;
  onComplete?: (result: AgentLoopResult) => void;
}

// ─── Snapshot ────────────────────────────────────────

interface Snapshot {
  id: string;
  iteration: number;
  messages: Message[];
  timestamp: string;
}

function createSnapshot(iteration: number, messages: Message[]): Snapshot {
  return {
    id: `snap-${Date.now()}-${iteration}`,
    iteration,
    messages: JSON.parse(JSON.stringify(messages)), // deep clone
    timestamp: new Date().toISOString(),
  };
}

// ─── Agent Loop ──────────────────────────────────────

export async function runAgentLoop(
  config: AgentConfig,
  userMessage: string,
  events?: LoopEventHandler,
): Promise<AgentLoopResult> {
  const {
    id: agentId,
    provider,
    model,
    tools,
    traceWriter,
    costTracker,
    maxIterations = 15,
    maxCostPerTask = 1.0,
  } = config;

  const sessionId = `sess-${Date.now()}`;
  const traceId = `tr-${Date.now()}`;

  // Initialize conversation with system prompt
  const messages: Message[] = [
    { role: 'system', content: config.systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const toolDefs = tools.getDefinitions();
  let iteration = 0;
  let lastSnapshot: Snapshot | null = null;

  while (iteration < maxIterations) {
    iteration++;
    events?.onIteration?.(iteration);

    // ⓪ SNAPSHOT — 保存当前状态以便回滚
    lastSnapshot = createSnapshot(iteration, messages);
    writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot.id, {
      type: 'snapshot',
      timestamp: new Date().toISOString(),
      summary: `Iteration ${iteration} snapshot (${messages.length} messages)`,
    });

    // ①② PLAN + DECIDE — 调用 LLM，让它规划并决定行动
    const startTime = Date.now();
    let response: LLMResponse;

    try {
      response = await provider.call({
        model,
        messages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot.id, {
        type: 'error',
        timestamp: new Date().toISOString(),
        summary: `LLM call failed: ${msg}`,
      });
      return {
        success: false,
        output: `Agent 错误: ${msg}`,
        iterations: iteration,
        totalCost: costTracker.totalCost,
        totalTokens: costTracker.totalTokens,
        traceFile: traceWriter.getPath(),
      };
    }

    const durationMs = Date.now() - startTime;

    // Record cost
    costTracker.record(model, response.usage, { agentId, traceId });

    writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot.id, {
      type: 'planning',
      timestamp: new Date().toISOString(),
      summary: response.content.slice(0, 200),
      tokens: response.usage.inputTokens + response.usage.outputTokens,
      cost: response.usage.cost,
      model,
      durationMs,
    });

    if (response.content) {
      events?.onTextDelta?.(response.content);
    }

    // ④ GOVERNANCE CHECK — 治理检查点
    if (costTracker.isOverBudget(maxCostPerTask)) {
      const govMsg = `⚠️ 成本已超过预算上限 ($${maxCostPerTask})。当前累计: $${costTracker.totalCost.toFixed(4)}`;
      writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot.id, {
        type: 'governance_check',
        timestamp: new Date().toISOString(),
        policy: 'resource_budget',
        result: 'blocked',
        summary: govMsg,
      });
      events?.onGovernance?.({ type: 'budget_exceeded', message: govMsg });

      return {
        success: false,
        output: `${response.content}\n\n${govMsg}`,
        iterations: iteration,
        totalCost: costTracker.totalCost,
        totalTokens: costTracker.totalTokens,
        traceFile: traceWriter.getPath(),
      };
    }

    // ③ EXECUTE — 如果有工具调用，执行工具
    if (response.stopReason === 'tool_use' && response.toolCalls.length > 0) {
      // Add assistant message with tool calls to conversation
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      });

      // Execute each tool call
      for (const toolCall of response.toolCalls) {
        const toolArgs = JSON.parse(toolCall.arguments) as Record<string, unknown>;
        events?.onToolCall?.(toolCall.name, toolArgs);

        writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot.id, {
          type: 'tool_call',
          timestamp: new Date().toISOString(),
          tool: toolCall.name,
          toolInput: toolArgs,
          summary: `Calling ${toolCall.name}`,
        });

        let toolResult: string;
        const toolStart = Date.now();

        try {
          toolResult = await tools.execute(toolCall.name, toolArgs);
        } catch (error) {
          toolResult = `工具执行失败: ${error instanceof Error ? error.message : String(error)}`;
        }

        const toolDuration = Date.now() - toolStart;

        writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot.id, {
          type: 'tool_result',
          timestamp: new Date().toISOString(),
          tool: toolCall.name,
          toolResult: toolResult.slice(0, 500),
          durationMs: toolDuration,
          summary: `${toolCall.name} completed (${toolDuration}ms)`,
        });

        events?.onToolResult?.(toolCall.name, toolResult);

        // Add tool result to conversation
        messages.push({
          role: 'tool',
          content: toolResult,
          toolCallId: toolCall.id,
        });
      }

      // ⑥ VERIFY — 继续循环让 LLM 评估结果
      continue;
    }

    // ⑦ OUTPUT — LLM 决定直接回复，循环结束
    writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot?.id || null, {
      type: 'output',
      timestamp: new Date().toISOString(),
      summary: response.content.slice(0, 200),
      tokens: response.usage.inputTokens + response.usage.outputTokens,
    });

    events?.onComplete?.({
      success: true,
      output: response.content,
      iterations: iteration,
      totalCost: costTracker.totalCost,
      totalTokens: costTracker.totalTokens,
      traceFile: traceWriter.getPath(),
    });

    return {
      success: true,
      output: response.content,
      iterations: iteration,
      totalCost: costTracker.totalCost,
      totalTokens: costTracker.totalTokens,
      traceFile: traceWriter.getPath(),
    };
  }

  // Max iterations reached
  return {
    success: false,
    output: '达到最大迭代次数限制。',
    iterations: iteration,
    totalCost: costTracker.totalCost,
    totalTokens: costTracker.totalTokens,
    traceFile: traceWriter.getPath(),
  };
}

// ─── Helper ──────────────────────────────────────────

function writeTrace(
  writer: TraceWriter,
  traceId: string,
  agentId: string,
  sessionId: string,
  snapshotId: string | null,
  span: TraceSpan,
): void {
  writer.write({ traceId, agentId, sessionId, parentTraceId: null, snapshotId, span });
}
