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
import { GovernanceEngine, type GovernanceContext } from './governance.js';

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
  /** 工具白名单（治理安全协议 §3.10）— 不在此列表中的工具将被拦截 */
  allowedTools?: string[];
  /** 三级审批模式 (D1) — suggest / auto_edit / full_auto */
  approvalMode?: 'suggest' | 'auto_edit' | 'full_auto';
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
  onGovernance?: (event: { policyType: string; severity: string; result: string; message: string; suggestion?: string; ruleName?: string }) => void;
  /** D1: 审批请求 — suggest/auto_edit 模式下工具执行前触发 */
  onApprovalRequest?: (request: ApprovalRequest) => void;
  onComplete?: (result: AgentLoopResult) => void;
}

/** D1: 审批请求数据结构 */
export interface ApprovalRequest {
  requestId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  mode: 'suggest' | 'auto_edit';
  /** resolve 为 true=批准, false=拒绝 */
  resolve: (approved: boolean) => void;
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
    allowedTools,
    approvalMode = 'full_auto',
  } = config;

  // 治理引擎实例（plan §3.4 步骤④ Hook）
  const governance = new GovernanceEngine('standard');

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

    // ④ GOVERNANCE CHECK — 治理检查点（plan §3.4 §3.10）
    // 每次迭代后先进行全局治理检查（预算+迭代次数）
    {
      const govCtx: GovernanceContext = {
        agentId,
        currentCost: costTracker.totalCost,
        maxCost: maxCostPerTask,
        currentIterations: iteration,
        maxIterations,
        approvalMode: 'full_auto',
      };
      const govResult = governance.evaluate(govCtx);

      // 发送所有警告事件
      for (const r of govResult.results) {
        if (r.event.result === 'warning') {
          events?.onGovernance?.(r.event);
          writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot.id, {
            type: 'governance_check', timestamp: new Date().toISOString(),
            policy: r.event.policyType, result: 'warning', summary: r.event.message,
          });
        }
      }

      // 硬约束拦截
      if (!govResult.allPassed) {
        const blocker = govResult.blockers[0];
        writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot.id, {
          type: 'governance_check', timestamp: new Date().toISOString(),
          policy: blocker.event.policyType, result: 'blocked', summary: blocker.event.message,
        });
        events?.onGovernance?.(blocker.event);

        return {
          success: false,
          output: `${response.content}\n\n⚠️ 治理拦截: ${blocker.event.message}`,
          iterations: iteration,
          totalCost: costTracker.totalCost,
          totalTokens: costTracker.totalTokens,
          traceFile: traceWriter.getPath(),
        };
      }
    }

    // ③ EXECUTE — 如果有工具调用，先治理检查每个工具，再执行
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

        // ④ 工具级治理检查：白名单 (plan §3.10 安全协议)
        if (allowedTools && !allowedTools.includes(toolCall.name)) {
          const blockMsg = `🛡️ 工具 "${toolCall.name}" 未在白名单中，已被治理引擎拦截。允许的工具: ${allowedTools.join(', ')}`;
          writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot.id, {
            type: 'governance_check', timestamp: new Date().toISOString(),
            policy: 'tool_whitelist', result: 'blocked',
            summary: blockMsg, tool: toolCall.name,
          });
          events?.onGovernance?.({ policyType: 'security', severity: 'hard', result: 'blocked', message: blockMsg, ruleName: 'tool_whitelist' });

          // 向 LLM 返回拦截消息，让它知道该工具不可用
          messages.push({
            role: 'tool',
            content: blockMsg,
            toolCallId: toolCall.id,
          });
          continue;
        }

        events?.onToolCall?.(toolCall.name, toolArgs);

        // D1: 三级审批模式检查 (plan §2.13)
        if (approvalMode !== 'full_auto') {
          const approved = await requestApproval(toolCall.name, toolArgs, approvalMode, events);
          if (!approved) {
            const rejectMsg = `用户拒绝了工具 "${toolCall.name}" 的执行。`;
            writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot.id, {
              type: 'governance_check', timestamp: new Date().toISOString(),
              policy: 'approval', result: 'blocked', summary: rejectMsg, tool: toolCall.name,
            });
            messages.push({ role: 'tool', content: rejectMsg, toolCallId: toolCall.id });
            continue;
          }
        }

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

/**
 * D1: 三级审批请求
 *
 * suggest:    暂停等待用户确认（无超时）
 * auto_edit:  暂停等待用户确认，3s 内无反对则自动批准
 */
function requestApproval(
  toolName: string,
  toolArgs: Record<string, unknown>,
  mode: 'suggest' | 'auto_edit',
  events?: LoopEventHandler,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const requestId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // auto_edit: 3s 后自动批准
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (mode === 'auto_edit') {
      timer = setTimeout(() => resolve(true), 3000);
    }

    const request: ApprovalRequest = {
      requestId,
      toolName,
      toolArgs,
      mode,
      resolve: (approved: boolean) => {
        if (timer) clearTimeout(timer);
        resolve(approved);
      },
    };

    if (events?.onApprovalRequest) {
      events.onApprovalRequest(request);
    } else {
      // 没有审批处理器时，默认批准
      if (timer) clearTimeout(timer);
      resolve(true);
    }
  });
}
