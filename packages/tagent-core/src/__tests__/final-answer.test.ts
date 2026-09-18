import { describe, expect, it, vi } from 'vitest';
import { CostTracker, type LLMProvider, type LLMResponse, type Message } from '@tagent/ai';
import { finalAnswerTokenBudget, resolveFinalAnswer } from '../final-answer.js';

const response = (content: string, stopReason: LLMResponse['stopReason'] = 'end'): LLMResponse => ({
  content, stopReason, toolCalls: [], model: 'deepseek-chat', usage: { inputTokens: 100, outputTokens: 50, cost: 0.001 },
});
function setup(initial = response('Partial paid-for draft with source https://source.example/article', 'max_tokens')) {
  const call = vi.fn<LLMProvider['call']>();
  const costTracker = new CostTracker();
  costTracker.record('deepseek-chat', initial.usage);
  const messages: Message[] = [
    { role: 'system', content: 'No external installs. Respect source uncertainty.' },
    { role: 'user', content: 'Research a report' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read_url', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'read', content: 'Date: 2026-09-09. Source: https://source.example/article. Identity unverified.' },
  ];
  return { call, costTracker, messages, options: { response: initial, messages,
    provider: { name: 'test', call, stream: async function* () {} }, model: 'deepseek-chat',
    maxTokens: 6144, maxCost: 0.5, costTracker, agentId: 'research', traceId: 'run-research', onRewrite: vi.fn(),
  } };
}

describe('bounded final answer recovery', () => {
  it('allocates room for structured reports without raising all short-reply limits', () => {
    expect(finalAnswerTokenBudget('只回复收到')).toBe(4096);
    expect(finalAnswerTokenBudget('近 30 天调研报告')).toBe(6144);
    expect(finalAnswerTokenBudget('办公交付', 3)).toBe(6144);
  });
  it('rewrites once without tools, retaining policies and the paired evidence conversation', async () => {
    const { call, costTracker, messages, options } = setup();
    call.mockImplementation(async params => {
      expect(params.tools).toBeUndefined();
      expect(params.messages.slice(0, messages.length)).toEqual(messages);
      expect(params.messages.at(-1)?.content).toContain('NEW complete compact deliverable');
      return response('Compact complete report with date and source.');
    });
    const result = await resolveFinalAnswer(options);
    expect(result).toMatchObject({ success: true, output: 'Compact complete report with date and source.' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(options.onRewrite).toHaveBeenCalledTimes(1);
    expect(costTracker.totalCost).toBeCloseTo(0.002);
    expect(costTracker.totalTokens.input).toBe(200);
    expect(messages).toHaveLength(4);
  });
  it.each(['empty', 'truncated', 'error', 'tool_request'])('retains the initial draft if the single rewrite is %s', async mode => {
    const { call, options, costTracker } = setup();
    if (mode === 'error') call.mockRejectedValue(new Error('Network down'));
    else call.mockResolvedValue(mode === 'tool_request'
      ? { ...response('Bad tool request', 'tool_use'), toolCalls: [{ id: 'x', name: 'write_file', arguments: '{}' }] }
      : response(mode === 'empty' ? '' : 'Short fragment', mode === 'truncated' ? 'max_tokens' : 'end'));
    const result = await resolveFinalAnswer(options);
    expect(result.success).toBe(false);
    expect(result.output).toBe(options.response.content);
    expect(call).toHaveBeenCalledTimes(1);
    expect(costTracker.totalCost).toBeCloseTo(mode === 'error' ? 0.001 : 0.002);
  });
  it.each(['budget', 'unknown_price'])('does not issue extra requests with %s', async mode => {
    const { call, options } = setup();
    if (mode === 'budget') options.maxCost = 0.001;
    else options.model = 'unpriced-model';
    expect((await resolveFinalAnswer(options)).success).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });
  it.each(['end', 'unknown', 'tool_use'] as const)('does not retry non-length termination: %s', async reason => {
    const { call, options } = setup(response(reason === 'end' ? '' : 'Pending', reason));
    expect((await resolveFinalAnswer(options)).success).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });
});
