import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMResponse } from '@tagent/ai';
import { withRunBudget } from '../run-budget.js';

const response = (cost: number): LLMResponse => ({ content: 'done', model: 'deepseek-chat',
  stopReason: 'end', toolCalls: [], usage: { inputTokens: 100, outputTokens: 100, cost } });
const request = { model: 'deepseek-chat', messages: [{ role: 'user' as const, content: 'Synthetic task' }], maxTokens: 4096 };

describe('shared run model budget', () => {
  it('rejects a zero budget before any provider request', async () => {
    const call = vi.fn(async () => response(0.01));
    const provider = withRunBudget({ name: 'fixture', call, async *stream() {} }, 0);
    await expect(provider.call(request)).rejects.toThrow('预算不足');
    expect(call).not.toHaveBeenCalled();
  });

  it('reserves in-flight calls and admits another only after settlement', async () => {
    let finish!: (value: LLMResponse) => void;
    const first = new Promise<LLMResponse>(resolve => { finish = resolve; });
    const call = vi.fn<LLMProvider['call']>().mockReturnValueOnce(first).mockResolvedValue(response(0.001));
    const provider = withRunBudget({ name: 'fixture', call, async *stream() {} }, 0.006);
    const pending = provider.call(request);
    await expect(provider.call(request)).rejects.toThrow('剩余模型预算不足');
    expect(call).toHaveBeenCalledTimes(1);
    finish(response(0.001));
    await pending;
    await provider.call(request);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('keeps an uncertain failed request reserved and rejects unpriced production models', async () => {
    const call = vi.fn<LLMProvider['call']>().mockRejectedValue(new Error('connection lost'));
    const provider = withRunBudget({ name: 'deepseek', call, async *stream() {} }, 0.006);
    await expect(provider.call(request)).rejects.toThrow('connection lost');
    await expect(provider.call(request)).rejects.toThrow('剩余模型预算不足');
    expect(call).toHaveBeenCalledTimes(1);
    await expect(provider.call({ ...request, model: 'unpriced-model' })).rejects.toThrow('模型价格未知');
  });
});
