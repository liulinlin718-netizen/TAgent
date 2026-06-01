/**
 * CostTracker — 内建成本追踪
 *
 * 记录每次 LLM 调用的 token 消耗和费用。
 * 数据可直接喂给治理引擎的资源协议。
 */

import type { TokenUsage } from './types.js';

export interface CostEntry {
  timestamp: Date;
  model: string;
  usage: TokenUsage;
  agentId?: string;
  traceId?: string;
}

export class CostTracker {
  private entries: CostEntry[] = [];

  record(model: string, usage: TokenUsage, meta?: { agentId?: string; traceId?: string }): void {
    this.entries.push({
      timestamp: new Date(),
      model,
      usage,
      ...meta,
    });
  }

  get totalCost(): number {
    return this.entries.reduce((sum, e) => sum + e.usage.cost, 0);
  }

  get totalTokens(): { input: number; output: number } {
    return this.entries.reduce(
      (sum, e) => ({
        input: sum.input + e.usage.inputTokens,
        output: sum.output + e.usage.outputTokens,
      }),
      { input: 0, output: 0 }
    );
  }

  /** 检查是否超过预算（治理引擎资源协议用） */
  isOverBudget(maxCost: number): boolean {
    return this.totalCost >= maxCost;
  }

  /** 获取当前 session 的成本摘要 */
  getSummary() {
    return {
      totalCost: this.totalCost,
      totalTokens: this.totalTokens,
      callCount: this.entries.length,
      entries: [...this.entries],
    };
  }

  getEntries(): CostEntry[] {
    return [...this.entries];
  }
}
