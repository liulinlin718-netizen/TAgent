import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMResponse } from '@tagent/ai';
import { buildConversationContext } from '../conversation-context.js';
import { AgentPool } from '../agent-pool.js';
import { runOrchestrator } from '../orchestrator.js';
vi.mock('../trace.js', () => ({ TraceWriter: class { write() {} getPath() { return 'fixture'; } } }));
const answer = (content: string): LLMResponse => ({ content, toolCalls: [], model: 'fixture', stopReason: 'end', usage: { inputTokens: 10, outputTokens: 2, cost: 0 } });
const history = buildConversationContext('ws', 'session', [{ id: 'history-user', role: 'user', content: 'MATERIAL_1200 全文不超过200字。', timestamp: '2026-09-13' }]);
describe('conversation references in actual orchestration stages', () => {
  it.each([false, true])('supplies planning, execution and verification for a single deliverable (fallback=%s)', async fallback => {
    const pool = new AgentPool();
    const calls: Parameters<LLMProvider['call']>[0][] = [];
    const call = vi.fn<LLMProvider['call']>().mockImplementation(async params => {
      calls.push({ ...params, messages: structuredClone(params.messages) });
      if (params.messages[0].content.includes('你是任务编排器')) return answer(fallback ? '[]' : '[{"id":"d","agentRole":"document","objective":"整理已有材料","contextMessageIds":["history-user"]}]');
      return answer('Fixture result');
    });
    const done = vi.fn();
    const result = await runOrchestrator({ model: 'deepseek-chat', provider: { name: 'fixture', call, stream: async function* () {} },
      agentPool: pool, conversationContext: history, workspaceId: 'ws', sessionId: 'session' }, '按刚才的限制继续整理', { onComplete: done });
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every(params => JSON.stringify(params.messages).includes('MATERIAL_1200'))).toBe(true);
    expect(calls.every(params => params.messages.every(message => !message.toolCalls?.length && message.role !== 'tool'))).toBe(true);
    expect(calls.find(params => params.purpose === 'verification')?.messages[1].content).toContain('user_input');
    expect(result.output).toContain('Fixture result'); expect(done).toHaveBeenCalledTimes(1);
  });
  it('rejects a different session before model calls', async () => {
    const call = vi.fn<LLMProvider['call']>();
    await expect(runOrchestrator({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'fixture',
      conversationContext: history, workspaceId: 'ws', sessionId: 'foreign' }, '继续')).rejects.toThrow('归属');
    expect(call).not.toHaveBeenCalled();
  });
  it('does not trigger fresh research because an old request contained latest-news keywords', async () => {
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer('[{"id":"d","agentRole":"document","objective":"改写邮件","contextMessageIds":[]}]')).mockResolvedValue(answer('邮件原稿'));
    const context = buildConversationContext('ws', 's', [{ id: 'old', role: 'user', content: 'OLD_RESEARCH 最新资讯', timestamp: 'old' }]);
    const tools = vi.fn();
    await runOrchestrator({ model: 'fixture', provider: { name: 'fixture', call, stream: async function* () {} }, conversationContext: context }, '改写成邮件，不联网', { onAgentToolCall: tools });
    expect(tools).not.toHaveBeenCalled();
    expect(call.mock.calls[1][0].messages.at(-1)?.content).not.toContain('OLD_RESEARCH');
  });
});
