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

import type { LLMProvider, LLMResponse, Message } from '@tagent/ai';
import { randomUUID } from 'node:crypto';
import type { SnapshotCapture } from './execution-snapshot.js';
import { CostTracker } from '@tagent/ai';
import { TraceWriter, type TraceSpan } from './trace.js';
import { ToolRegistry } from './tools/registry.js';
import { GovernanceEngine, type GovernanceContext } from './governance.js';
import { finalAnswerTokenBudget, resolveFinalAnswer } from './final-answer.js';
import { withRunSignal, terminationNotice, runTermination, type RunTermination } from './run-control.js';
import { requestToolApproval, type ApprovalHandler } from './tool-approval.js';
export type { ApprovalRequest } from './tool-approval.js';

// ─── Types ───────────────────────────────────────────

export interface AgentConfig {
  snapshotScope?: { workspaceId: string; sessionId: string; runId: string; taskId?: string };
  captureSnapshot?: SnapshotCapture;
  governanceTemplate?: 'standard' | 'strict_cost' | 'quality_first';
  id: string;
  name: string;
  systemPrompt: string;
  provider: LLMProvider;
  signal?: AbortSignal;
  model: string;
  tools: ToolRegistry;
  traceWriter: TraceWriter;
  costTracker: CostTracker;
  maxIterations?: number;
  /** Stop scheduling new work after this budget; an in-flight tool completes before synthesis. */
  maxDurationMs?: number;
  maxCostPerTask?: number; // USD — 治理资源协议
  /** 工具白名单（治理安全协议 §3.10）— 不在此列表中的工具将被拦截 */
  allowedTools?: string[];
  /** 三级审批模式 (D1) — suggest / auto_edit / full_auto */
  approvalMode?: 'suggest' | 'auto_edit' | 'full_auto';
}

export interface AgentLoopResult {
  termination?: RunTermination;
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
  onApprovalRequest?: ApprovalHandler;
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
    id: `snap-${randomUUID()}`,
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
    provider: originalProvider,
    signal,
    model,
    tools,
    traceWriter,
    costTracker,
    maxIterations = 15,
    maxDurationMs = 180000,
    maxCostPerTask = 1.0,
    allowedTools,
    approvalMode = 'full_auto',
  } = config;
  const provider = withRunSignal(originalProvider, signal);

  // 治理引擎实例（plan §3.4 步骤④ Hook）
  const governance = new GovernanceEngine(config.governanceTemplate || 'standard');

  const sessionId = config.snapshotScope?.sessionId || `sess-${randomUUID()}`;
  const traceId = `tr-${Date.now()}`;

  // Initialize conversation with system prompt
  const messages: Message[] = [
    { role: 'system', content: config.systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const toolDefs = tools.getDefinitions().filter(tool => !allowedTools || allowedTools.includes(tool.name));
  let iteration = 0;
  let lastSnapshot: Snapshot | null = null;
  const startedAt = Date.now();
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) throw new Error('maxDurationMs must be positive');
  const outOfTime = () => Date.now() - startedAt >= maxDurationMs;
  const maxOutputTokens = finalAnswerTokenBudget(userMessage);
  let returnedDraft = '';
  const finish = (result: AgentLoopResult): AgentLoopResult => {
    if (signal?.aborted) result = { ...result, success: false, termination: runTermination(signal),
      output: buildPartialOutput(messages, terminationNotice(signal))
        + (returnedDraft ? `\n\n## 已返回的未核验草稿\n\n${returnedDraft}` : '') };
    events?.onComplete?.(result);
    return result;
  };

  while (iteration < maxIterations && !outOfTime() && !signal?.aborted) {
    if (costTracker.totalCost >= maxCostPerTask) {
      return finish({ success: false,
        output: buildPartialOutput(messages, '本任务模型预算已用尽，未发起新的模型请求。'),
        iterations: iteration, totalCost: costTracker.totalCost, totalTokens: costTracker.totalTokens,
        traceFile: traceWriter.getPath() });
    }
    iteration++;
    events?.onIteration?.(iteration);

    // ⓪ SNAPSHOT — 保存当前状态以便回滚
    lastSnapshot = createSnapshot(iteration, messages);
    if (config.captureSnapshot && config.snapshotScope) {
      try {
        await config.captureSnapshot({ ...lastSnapshot, ...config.snapshotScope, agentId });
      } catch {
        events?.onGovernance?.({ policyType: 'resource', severity: 'info', result: 'warning',
          ruleName: 'snapshot_storage', message: '本轮快照未保存，最终报告仍会继续；不能从这个时刻创建分支。' });
      }
    }
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
        maxTokens: maxOutputTokens,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot.id, {
        type: 'error',
        timestamp: new Date().toISOString(),
        summary: `LLM call failed: ${msg}`,
      });
      return finish({
        success: false,
        output: buildPartialOutput(messages, `模型请求失败：${msg}`),
        iterations: iteration,
        totalCost: costTracker.totalCost,
        totalTokens: costTracker.totalTokens,
        traceFile: traceWriter.getPath(),
      });
    }

    const durationMs = Date.now() - startTime;

    // Record cost
    costTracker.record(model, response.usage, { agentId, traceId });
    if (response.stopReason !== 'tool_use') returnedDraft = response.content;

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

        return finish({
          success: false,
          output: buildPartialOutput(messages, `治理拦截：${blocker.event.message}`),
          iterations: iteration,
          totalCost: costTracker.totalCost,
          totalTokens: costTracker.totalTokens,
          traceFile: traceWriter.getPath(),
        });
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
        if (outOfTime() || signal?.aborted) {
          const skipped = signal?.aborted ? '任务已停止，未执行此工具。'
            : '本轮执行时间预算已用完，未执行此工具。请使用已获取的证据生成最终报告，标明未验证部分。';
          // Complete every requested tool message even when the remaining calls are skipped.
          messages.push({ role: 'tool', toolCallId: toolCall.id, content: skipped });
          events?.onToolResult?.(toolCall.name, skipped);
          continue;
        }
        let toolArgs: Record<string, unknown>;
        try {
          toolArgs = JSON.parse(toolCall.arguments) as Record<string, unknown>;
        } catch (error) {
          const parseMsg = `工具参数解析失败: ${error instanceof Error ? error.message : String(error)}。原始参数: ${toolCall.arguments}`;
          writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot.id, {
            type: 'error',
            timestamp: new Date().toISOString(),
            tool: toolCall.name,
            summary: parseMsg,
          });
          events?.onToolResult?.(toolCall.name, parseMsg);
          messages.push({
            role: 'tool',
            content: parseMsg,
            toolCallId: toolCall.id,
          });
          continue;
        }

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
          const approved = await requestToolApproval(toolCall.name, toolArgs, approvalMode, events?.onApprovalRequest, signal,
            tools.get(toolCall.name)?.approval === 'local_read_only');
          if (!approved) {
            const rejectMsg = `工具 "${toolCall.name}" 未取得执行确认，已停止执行。`;
            writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot.id, {
              type: 'governance_check', timestamp: new Date().toISOString(),
              policy: 'approval', result: 'blocked', summary: rejectMsg, tool: toolCall.name,
            });
            events?.onGovernance?.({ policyType: 'security', severity: 'hard', result: 'blocked', ruleName: 'approval', message: rejectMsg });
            events?.onToolResult?.(toolCall.name, rejectMsg);
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
          toolResult = await tools.execute(toolCall.name, toolArgs, { signal });
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
    const final = await resolveFinalAnswer({ response, messages, provider, model, costTracker,
      maxTokens: maxOutputTokens, maxCost: maxCostPerTask, agentId, traceId,
      onRewrite: () => writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot?.id || null, {
        type: 'planning', timestamp: new Date().toISOString(), summary: 'Output limit reached; one bounded tool-free rewrite.',
      }),
    });
    writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot?.id || null, {
      type: 'output', timestamp: new Date().toISOString(),
      summary: `${final.success ? 'Complete' : 'Incomplete'}: ${final.output.slice(0, 200)}`,
    });
    return finish({
      success: final.success,
      output: final.success ? final.output : `${final.output}\n\n> 模型未返回完整结果：${final.reason}。当前内容尚未完成质量验收。`,
      iterations: iteration,
      totalCost: costTracker.totalCost,
      totalTokens: costTracker.totalTokens,
      traceFile: traceWriter.getPath(),
    });
  }

  if (signal?.aborted) return finish({ success: false, output: '', iterations: iteration,
    totalCost: costTracker.totalCost, totalTokens: costTracker.totalTokens, traceFile: traceWriter.getPath() });

  const limitReason = outOfTime() ? 'time budget' : 'iteration limit';
  if (outOfTime()) {
    const message = '本轮执行时间预算已用完，停止追加工具调用并整理已有结果。';
    events?.onGovernance?.({ policyType: 'resource', severity: 'soft', result: 'warning', ruleName: 'execution_time_budget', message });
    writeTrace(traceWriter, traceId, agentId, sessionId, lastSnapshot?.id || null, {
      type: 'governance_check', timestamp: new Date().toISOString(), policy: 'execution_time_budget', result: 'warning', summary: message,
    });
  }
  const synthesis = await synthesizeFinalWhenLimited({
    provider,
    model,
    messages,
    costTracker,
    agentId,
    traceId,
    traceWriter,
    sessionId,
    snapshotId: lastSnapshot?.id || null,
    limitReason,
    maxTokens: maxOutputTokens,
    maxCost: maxCostPerTask,
  });

  return finish({
    success: synthesis.success,
    output: synthesis.output,
    iterations: iteration,
    totalCost: costTracker.totalCost,
    totalTokens: costTracker.totalTokens,
    traceFile: traceWriter.getPath(),
  });

}

// ─── Helper ──────────────────────────────────────────

async function synthesizeFinalWhenLimited({
  provider,
  model,
  messages,
  costTracker,
  agentId,
  traceId,
  traceWriter,
  sessionId,
  snapshotId,
  limitReason,
  maxTokens,
  maxCost,
}: {
  provider: LLMProvider;
  model: string;
  messages: Message[];
  costTracker: CostTracker;
  agentId: string;
  traceId: string;
  traceWriter: TraceWriter;
  sessionId: string;
  snapshotId: string | null;
  limitReason: string;
  maxTokens: number;
  maxCost: number;
}): Promise<{ success: boolean; output: string }> {
  try {
    const response = await provider.call({
      model,
      messages: [
        ...messages,
        {
          role: 'user',
          content: [
            `You have reached the ${limitReason} for this run.`,
            'Stop calling tools and produce the final answer now, using only the evidence already gathered in this conversation.',
            'Requirements:',
            '1. Provide a complete final answer, not a process update.',
            '2. Clearly separate verified source-backed content from uncertain content.',
            '3. If evidence is insufficient, say so and give the best next steps.',
            '4. Do not say you will search again.',
          ].join('\n'),
        },
      ],
      maxTokens,
      temperature: 0.3,
    });

    costTracker.record(model, response.usage, { agentId, traceId });
    const final = await resolveFinalAnswer({ response, messages, provider, model, costTracker, maxTokens, maxCost, agentId, traceId,
      onRewrite: () => writeTrace(traceWriter, traceId, agentId, sessionId, snapshotId, {
        type: 'planning', timestamp: new Date().toISOString(), summary: 'Final report truncated; one bounded tool-free rewrite.',
      }),
    });
    if (!final.output.trim()) throw new Error(final.reason);
    writeTrace(traceWriter, traceId, agentId, sessionId, snapshotId, {
      type: 'output',
      timestamp: new Date().toISOString(),
      summary: `Final synthesis after ${limitReason} (${final.success ? 'complete' : 'incomplete'}): ${final.output.slice(0, 160)}`,
      tokens: response.usage.inputTokens + response.usage.outputTokens,
      cost: response.usage.cost,
    });

    return { success: final.success, output: final.success ? final.output
      : `# 任务未完整完成\n\n> ${final.reason}。以下保留未完成的综合稿，不能作为已核验的完整交付物。\n\n${final.output}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallback = buildPartialOutput(messages, `已达到本轮执行限制（${limitReason}），最终综合生成失败：${message}`);

    writeTrace(traceWriter, traceId, agentId, sessionId, snapshotId, {
      type: 'error',
      timestamp: new Date().toISOString(),
      summary: `Final synthesis failed: ${message}`,
    });

    return { success: false, output: fallback };
  }
}

function buildPartialOutput(messages: Message[], reason: string): string {
  const materials = messages.filter(message => message.role === 'tool').slice(-4);
  return [
    '# 任务未完整完成',
    '',
    `> ${reason.replace(/[\r\n]+/g, ' ')}`,
    '',
    materials.length ? '## 已保留的工具材料\n\n以下是原始返回内容，尚未完成综合与质量验证。' : '尚未取得可用的工具材料。',
    ...materials.map((message, index) => `### 材料 ${index + 1}\n\n${message.content.slice(0, 3000)}${message.content.length > 3000 ? '\n\n[材料过长，此处仅保留节选]' : ''}`),
  ].join('\n\n');
}

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
