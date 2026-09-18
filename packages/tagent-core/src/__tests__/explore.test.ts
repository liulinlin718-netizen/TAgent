import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMResponse } from '@tagent/ai';
import type { ResearchSource } from '../research-evidence.js';
import { runExplore } from '../explore.js';

const source: ResearchSource = { id: 'source-1', title: '公开材料', query: '任务', url: 'https://example.org/article',
  retrievedAt: '2026-09-17', publication: { basis: 'publication_metadata', date: '2026-09-16' },
  readable: true, relevant: true, excerpt: '这是一份已读取的公开材料，不代表独立核实。', publisher: 'unverified' };
function fixture() {
  const response: LLMResponse = { content: '初步摘要，需核实。', model: 'deepseek-chat', toolCalls: [], stopReason: 'end',
    usage: { inputTokens: 100, outputTokens: 30, cost: 0.001 } };
  const call = vi.fn<LLMProvider['call']>().mockResolvedValue(response);
  const provider: LLMProvider = { name: 'fixture', call, stream: async function* () {} };
  return { call, provider, response, research: vi.fn().mockResolvedValue([source]) };
}

describe('bounded read-only Explore', () => {
  it('retrieves sources before a tool-free summary and preserves usage', async () => {
    const f = fixture();
    const result = await runExplore({ ...f, model: 'deepseek-chat' }, [{ query: '公开调研' }]);
    expect(f.research).toHaveBeenCalledOnce(); expect(f.call).toHaveBeenCalledOnce();
    expect(f.call.mock.calls[0]![0].tools).toBeUndefined();
    expect(f.call.mock.calls[0]![0].messages[1]!.content).toContain(source.url);
    expect(result[0]).toMatchObject({ status: 'complete', inputTokens: 100, outputTokens: 30, cost: 0.001, sources: [source] });
  });
  it('never manufactures research when no readable relevant sources are available', async () => {
    const f = fixture(); f.research.mockResolvedValue([{ ...source, readable: false }]);
    const result = await runExplore({ ...f, model: 'deepseek-chat' }, [{ query: '任务' }]);
    expect(result[0]!.status).toBe('failed'); expect(f.call).not.toHaveBeenCalled();
  });
  it.each(['unknown-model', 'deepseek-chat'])('keeps sources without extra paid calls when pricing or budget is unavailable: %s', async model => {
    const f = fixture();
    const result = await runExplore({ ...f, model, maxCost: 0 }, [{ query: '任务' }]);
    expect(result[0]!.sources).toEqual([source]); expect(result[0]!.status).toBe('partial'); expect(f.call).not.toHaveBeenCalled();
  });
  it('preserves a truncated draft without retries', async () => {
    const f = fixture(); f.call.mockResolvedValue({ ...f.response, stopReason: 'max_tokens', content: '部分付费草稿' });
    const result = await runExplore({ ...f, model: 'deepseek-chat' }, [{ query: '任务' }]);
    expect(result[0]).toMatchObject({ status: 'partial', summary: '部分付费草稿', cost: 0.001 }); expect(f.call).toHaveBeenCalledOnce();
  });
  it('does not start research after cancellation', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    const result = await runExplore({ ...f, model: 'deepseek-chat', signal: controller.signal }, [{ query: '任务' }]);
    expect(result[0]!.status).toBe('failed'); expect(f.research).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled();
  });
  it('rejects unbounded query batches before research', async () => {
    const f = fixture();
    await expect(runExplore({ ...f, model: 'deepseek-chat' }, Array.from({ length: 4 }, () => ({ query: '任务' })))).rejects.toThrow('1至3');
    expect(f.research).not.toHaveBeenCalled();
  });
  it('keeps old or undated pages as background without manufacturing a latest summary', async () => {
    const f = fixture(); f.research.mockResolvedValue([{ ...source, publication: { basis: 'unknown' } }]);
    const result = await runExplore({ ...f, model: 'deepseek-chat', researchDate: '2026-09-17' }, [{ query: '近30天最新进展' }]);
    expect(result[0]!.status).toBe('partial'); expect(result[0]!.error).toContain('旧来源仅作背景');
    expect(f.call).not.toHaveBeenCalled();
  });
  it('does not expose arbitrary upstream error bodies in the saved report', async () => {
    const f = fixture(); f.research.mockRejectedValue(new Error('private query, token=secret-test-value'));
    const result = await runExplore({ ...f, model: 'deepseek-chat' }, [{ query: '任务' }]);
    expect(result[0]!.error).toContain('未自动重试');
    expect(JSON.stringify(result)).not.toContain('secret-test-value');
    expect(f.call).not.toHaveBeenCalled();
  });
});
