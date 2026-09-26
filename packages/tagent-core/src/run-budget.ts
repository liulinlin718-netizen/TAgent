import { calculateCost, MODEL_PRICING, type LLMCallParams, type LLMProvider, type TokenUsage } from '@tagent/ai';

/** Shared admission ledger for every model request in one orchestration run. */
export function withRunBudget(provider: LLMProvider, maxCost: number): LLMProvider {
  let settled = 0;
  let held = 0;

  function reserve(params: LLMCallParams): number {
    if (!Number.isFinite(maxCost) || maxCost <= 0) throw new Error('本次任务模型预算不足，未发起模型请求。');
    const priced = !!MODEL_PRICING[params.model];
    if (!priced && !['fixture', 'test', 'stub'].includes(provider.name)) {
      throw new Error('模型价格未知，未发起模型请求。');
    }
    // UTF-8 bytes plus a tool/schema margin provide a conservative local admission estimate.
    const inputTokens = Buffer.byteLength(JSON.stringify(params.messages), 'utf8')
      + Buffer.byteLength(JSON.stringify(params.tools || []), 'utf8') + 1024;
    const estimate = priced ? calculateCost(params.model, {
      inputTokens, outputTokens: params.maxTokens || 4096,
    }) : 0;
    if (settled + held + estimate > maxCost) throw new Error('本次任务剩余模型预算不足，未发起新的模型请求。');
    held += estimate;
    return estimate;
  }

  function settle(estimate: number, usage: TokenUsage) {
    held -= estimate;
    settled += usage.cost;
  }

  return {
    name: provider.name,
    async call(params) {
      const estimate = reserve(params);
      // An uncertain failed request retains its reservation: it may still be billed.
      const response = await provider.call(params);
      settle(estimate, response.usage);
      return response;
    },
    async *stream(params) {
      const estimate = reserve(params);
      let usage: TokenUsage | undefined;
      try {
        for await (const event of provider.stream(params)) {
          if (event.type === 'usage' && event.usage) usage = event.usage;
          yield event;
        }
      } finally {
        if (usage) settle(estimate, usage);
      }
    },
  };
}
