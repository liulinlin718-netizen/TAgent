import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMResponse } from '@tagent/ai';
import type { ResearchSource } from '../research-evidence.js';
import { AgentPool } from '../agent-pool.js';
import { runOrchestrator } from '../orchestrator.js';

const fixture = vi.hoisted(() => ({ sources: [] as ResearchSource[], execute: vi.fn() }));
vi.mock('../tools/web-research.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../tools/web-research.js')>();
  return { ...actual, createWebResearchTool: (options: Parameters<typeof actual.createWebResearchTool>[0]) => ({
    definition: { name: 'web_research', description: 'offline fixture', parameters: { type: 'object', properties: {} } },
    execute: async (args: Record<string, unknown>) => {
      fixture.execute(args); options?.onSources?.(fixture.sources); return 'fixture evidence';
    },
  }) };
});

beforeEach(() => {
  fixture.execute.mockClear();
  fixture.sources = [{ id: 'fixture-source', title: '合成来源', url: 'https://example.org/synthetic', query: 'AI Agent',
    retrievedAt: new Date().toISOString(), publication: { date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()), basis: 'publication_metadata' },
    readable: true, relevant: true, excerpt: '用于离线编排验收的材料。', publisher: 'unverified' }];
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in fixture'));
});
afterEach(() => vi.restoreAllMocks());

function providerFixture() {
  const response: LLMResponse = { content: '初步探索结论，未独立核实。', toolCalls: [], model: 'deepseek-chat', stopReason: 'end',
    usage: { inputTokens: 100, outputTokens: 20, cost: 0.001 } };
  const call = vi.fn<LLMProvider['call']>().mockResolvedValue(response);
  const provider: LLMProvider = { name: 'fixture', call, stream: async function* () {} };
  return { call, provider };
}

describe('Explore orchestration contract', () => {
  it('returns one final result with source receipts and one participating agent, without planner or verifier model calls', async () => {
    const f = providerFixture(), sources = vi.fn(), complete = vi.fn(), tools = vi.fn();
    const result = await runOrchestrator({ provider: f.provider, model: 'deepseek-chat', mode: 'explore', agentPool: new AgentPool() },
      '近30天 AI Agent 最新进展', { onResearchSources: sources, onComplete: complete, onAgentToolCall: tools });
    expect(result.success).toBe(true); expect(result.subResults).toHaveLength(1);
    expect(result.subResults[0]).toMatchObject({ taskId: 't-explore', summary: result.output, cost: 0.001 });
    expect(result.output).toContain(fixture.sources[0].url); expect(result.output).toContain('未经过完整报告');
    expect(sources).toHaveBeenCalledWith(fixture.sources); expect(complete).toHaveBeenCalledExactlyOnceWith(result);
    expect(f.call).toHaveBeenCalledOnce(); expect(f.call.mock.calls[0][0].tools).toBeUndefined();
    expect(tools).toHaveBeenCalledWith('research-agent', 'web_research', expect.any(Object), { taskId: 't-explore' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('denies read-only exploration before any search or model call if user approval is missing', async () => {
    const f = providerFixture(), pool = new AgentPool(), complete = vi.fn();
    pool.getAgent('research-agent')!.constraints.approvalMode = 'suggest';
    const result = await runOrchestrator({ provider: f.provider, model: 'deepseek-chat', mode: 'explore', agentPool: pool },
      '近30天 AI Agent 最新进展', { onComplete: complete });
    expect(result.success).toBe(false); expect(result.output).toContain('未取得可验证来源');
    expect(complete).toHaveBeenCalledOnce(); expect(f.call).not.toHaveBeenCalled(); expect(fixture.execute).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
