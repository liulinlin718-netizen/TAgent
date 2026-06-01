/**
 * Explore 模式 — 低成本只读探索
 *
 * 用低成本模型（如 Haiku / GPT-4o-mini / deepseek-chat）并行搜索多个信息源。
 * 仅做只读探索，不执行任何副作用操作。
 *
 * 设计参考：Claude Code 的 Explore Agent 模式
 * - 隔离上下文：Explore 不污染主对话
 * - 摘要返回：仅返回结论摘要给父 Agent
 * - 成本优化：使用最便宜的模型
 */

import type { LLMProvider, Message } from '@tagent/ai';

export interface ExploreResult {
  query: string;
  summary: string;
  source: string;
  tokens: number;
  cost: number;
}

export interface ExploreConfig {
  provider: LLMProvider;
  model: string; // 便宜模型
  maxConcurrent?: number;
}

/**
 * 并行执行多个 Explore 查询
 * 每个查询都是隔离上下文，互不干扰
 */
export async function runExplore(
  config: ExploreConfig,
  queries: { query: string; context?: string }[],
): Promise<ExploreResult[]> {
  const { provider, model, maxConcurrent = 3 } = config;

  const results: ExploreResult[] = [];
  const batches: { query: string; context?: string }[][] = [];

  // 按并发数分批
  for (let i = 0; i < queries.length; i += maxConcurrent) {
    batches.push(queries.slice(i, i + maxConcurrent));
  }

  for (const batch of batches) {
    const batchResults = await Promise.all(
      batch.map(async ({ query, context }) => {
        const messages: Message[] = [
          {
            role: 'system',
            content: `你是一个信息搜索助手。请针对用户的问题提供简洁的摘要回答。
只做只读信息检索，不执行任何操作。
回答控制在 200 字以内，聚焦关键信息。`,
          },
        ];

        if (context) {
          messages.push({ role: 'user', content: `参考上下文：${context}` });
          messages.push({ role: 'assistant', content: '好的，我会参考这些上下文来回答。' });
        }

        messages.push({ role: 'user', content: query });

        try {
          const response = await provider.call({
            model,
            messages,
            maxTokens: 500, // 限制输出以控制成本
            temperature: 0.3, // 低温度确保准确性
          });

          return {
            query,
            summary: response.content,
            source: model,
            tokens: response.usage.inputTokens + response.usage.outputTokens,
            cost: response.usage.cost,
          };
        } catch (error) {
          return {
            query,
            summary: `探索失败: ${error instanceof Error ? error.message : String(error)}`,
            source: model,
            tokens: 0,
            cost: 0,
          };
        }
      }),
    );

    results.push(...batchResults);
  }

  return results;
}
