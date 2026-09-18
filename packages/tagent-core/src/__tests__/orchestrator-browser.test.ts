import { afterEach, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMResponse } from '@tagent/ai';
import type { SkillsRegistry } from '../skills-registry.js';

const sessions = vi.hoisted(() => [] as Array<{ close: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> }>);
vi.mock('../trace.js', () => ({ TraceWriter: class { write() {} getPath() { return 'fixture'; } } }));
vi.mock('../tools/browser.js', () => ({
  createBrowserToolSession: () => {
    const id = `browser-${sessions.length}`;
    const execute = vi.fn(async () => id);
    const close = vi.fn(async () => {});
    sessions.push({ execute, close });
    return { close, tools: [{ definition: { name: 'browser_snapshot', description: 'Fixture', parameters: { type: 'object' } }, execute }] };
  },
}));
import { runOrchestrator } from '../orchestrator.js';
import { AgentPool } from '../agent-pool.js';

afterEach(() => { sessions.length = 0; vi.restoreAllMocks(); });
function answer(content: string): LLMResponse {
  return { content, toolCalls: [], model: 'fixture', stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1, cost: 0 } };
}
function provider(call: LLMProvider['call']): LLMProvider { return { name: 'fixture', call, stream: async function* () {} }; }

it('allocates and closes a browser session for each actual execution of the same resident', async () => {
  const pool = new AgentPool();
  vi.spyOn(pool, 'findBestAgentForTask').mockReturnValue(pool.getAgent('research-agent')!);
  const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer('[{"id":"a","agentRole":"research","objective":"Review input"},{"id":"b","agentRole":"research","objective":"Check input"}]'));
  call.mockImplementation(async request => {
    if (request.purpose === 'verification') {
      const input = JSON.parse(request.messages[1].content);
      expect(input.materials.map((material: { text: string }) => material.text)).toEqual(expect.arrayContaining(['browser-0', 'browser-1']));
      return answer(JSON.stringify({ areas: ['instructions', 'material_consistency', 'arithmetic', 'deliverable', 'actions'].map(area =>
        ({ area, status: 'passed', reason: '模拟核对，仅验证浏览器生命周期' })),
        blocks: input.blocks.map((block: { index: number }) => ({ index: block.index, verdict: 'non_factual', reason: '模拟输出', evidence: [] })),
        lengthLimits: [], calculations: [] }));
    }
    if (!request.tools) return answer('Final fixture output');
    if (!request.messages.some(message => message.role === 'tool')) return { ...answer(''), stopReason: 'tool_use',
      toolCalls: [{ id: 'snapshot', name: 'browser_snapshot', arguments: '{}' }] };
    return answer('Task output');
  });
  const result = await runOrchestrator({ agentPool: pool, model: 'deepseek-chat', provider: provider(call) }, '检查给定输入');
  expect(result.success).toBe(true);
  expect(sessions).toHaveLength(2);
  for (const session of sessions) {
    expect(session.execute).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
  }
  const toolReplies = call.mock.calls.flatMap(([request]) => request.messages.filter(message => message.role === 'tool').map(message => message.content));
  expect(toolReplies).toContain('browser-0');
  expect(toolReplies).toContain('browser-1');
});

it('releases a single-agent execution even if browser cleanup throws', async () => {
  const pool = new AgentPool();
  vi.spyOn(pool, 'findBestAgentForTask').mockReturnValue(pool.getAgent('document-agent')!);
  const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer('[]')).mockImplementation(async () => {
    sessions[0].close.mockRejectedValueOnce(new Error('Cleanup failed'));
    return answer('已整理材料');
  });
  await runOrchestrator({ agentPool: pool, model: 'fixture', provider: provider(call) }, '整理材料').catch(() => {});
  expect(sessions[0].close).toHaveBeenCalledTimes(1);
  expect(pool.getAgent('document-agent')!.state.business).toBe('idle');
});

it.each([true, false])('closes the task browser if skill loading fails before the loop (single=%s)', async single => {
  const pool = new AgentPool();
  pool.getAgent('research-agent')!.capabilities.skills = ['broken'];
  vi.spyOn(pool, 'findBestAgentForTask').mockReturnValue(pool.getAgent('research-agent')!);
  const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer(single ? '[]' : '[{"id":"a","agentRole":"research","objective":"Review input"}]'));
  const skillsRegistry = { getSkill: vi.fn(async () => { throw new Error('Skill read failed'); }) } as unknown as SkillsRegistry;
  await runOrchestrator({ agentPool: pool, skillsRegistry, model: 'fixture', provider: provider(call) }, '检查给定输入').catch(() => {});
  expect(sessions).toHaveLength(1);
  expect(sessions[0].close).toHaveBeenCalledTimes(1);
  expect(pool.getAgent('research-agent')!.state.business).toBe('idle');
});
