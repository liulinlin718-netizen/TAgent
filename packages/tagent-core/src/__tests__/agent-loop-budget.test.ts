import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CostTracker, type LLMProvider, type LLMResponse } from '@tagent/ai';
import { runAgentLoop } from '../agent-loop.js';
import { TraceWriter } from '../trace.js';
import { ToolRegistry } from '../tools/registry.js';

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const response = (content: string): LLMResponse => ({
  content, model: 'test', stopReason: 'end', toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
});

describe('Agent Loop elapsed budget', () => {
  it('recovers an iteration-limited report once, without new tools and with all response costs accounted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagent-loop-rewrite-'));
    directories.push(root);
    const tools = new ToolRegistry();
    const execute = vi.fn(async () => 'Actual evidence, published 2026-09-09: https://example.com/release');
    tools.register({ definition: { name: 'read_url', description: 'Read', parameters: { type: 'object' } }, execute });
    const charged = (content: string) => ({ ...response(content), usage: { inputTokens: 100, outputTokens: 20, cost: 0.01 } });
    const call = vi.fn<LLMProvider['call']>()
      .mockResolvedValueOnce({ ...charged('Read source'), stopReason: 'tool_use',
        toolCalls: [{ id: 'read', name: 'read_url', arguments: '{}' }] })
      .mockResolvedValueOnce({ ...charged('Truncated report'), stopReason: 'max_tokens' })
      .mockImplementationOnce(async params => {
        expect(params.tools).toBeUndefined();
        expect(params.messages.filter(message => message.toolCallId === 'read')).toHaveLength(1);
        expect(params.messages.some(message => message.content.includes('Actual evidence'))).toBe(true);
        return charged('Complete concise report: https://example.com/release, 2026-09-09.');
      });
    const writer = new TraceWriter(join(root, 'trace.jsonl'));
    const complete = vi.fn();
    const result = await runAgentLoop({ id: 'research', name: 'Research', systemPrompt: 'Research',
      model: 'deepseek-chat', provider: { name: 'fixture', call, stream: async function* () {} },
      tools, traceWriter: writer, costTracker: new CostTracker(), maxIterations: 1,
    }, 'Write a research report', { onComplete: complete });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Complete concise report');
    expect(result.totalCost).toBeCloseTo(0.03);
    expect(call).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(writer.readAll().some(entry => entry.span.summary?.includes('bounded tool-free rewrite'))).toBe(true);
  });
  it('finishes the current tool, pairs skipped tool results and synthesizes once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
    const root = mkdtempSync(join(tmpdir(), 'tagent-loop-budget-'));
    directories.push(root);
    const writer = new TraceWriter(join(root, 'trace.jsonl'));
    const tools = new ToolRegistry();
    const execute = vi.fn(async () => {
      vi.setSystemTime(new Date('2026-09-11T00:00:02Z'));
      return 'Verified evidence: https://example.com/report dated 2026-09-10';
    });
    tools.register({ definition: { name: 'web_research', description: 'research', parameters: { type: 'object' } }, execute });
    const call = vi.fn<LLMProvider['call']>();
    call.mockResolvedValueOnce({
      ...response('Gather evidence'), stopReason: 'tool_use',
      toolCalls: [
        { id: 'one', name: 'web_research', arguments: '{"query":"first"}' },
        { id: 'two', name: 'web_research', arguments: '{"query":"second"}' },
      ],
    }).mockImplementationOnce(async params => {
      expect(params.tools).toBeUndefined();
      const results = params.messages.filter(m => m.role === 'tool');
      expect(results.map(m => m.toolCallId)).toEqual(['one', 'two']);
      expect(results[0]?.content).toContain('Verified evidence');
      expect(results[1]?.content).toContain('未执行此工具');
      expect(params.messages.at(-1)?.content).toContain('time budget');
      return response('## Report\nEvidence collected; remaining claims unverified.');
    });
    const complete = vi.fn();
    const governance = vi.fn();
    const result = await runAgentLoop({
      id: 'research', name: 'Research', systemPrompt: 'Research with citations',
      model: 'test', provider: { name: 'test', call, stream: async function* () {} },
      tools, traceWriter: writer, costTracker: new CostTracker(),
      maxDurationMs: 1000, maxIterations: 10, allowedTools: ['web_research'],
    }, 'Research', { onComplete: complete, onGovernance: governance });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('## Report');
    expect(governance).toHaveBeenCalledWith(expect.objectContaining({ ruleName: 'execution_time_budget' }));
    expect(writer.readAll().some(entry => entry.span.policy === 'execution_time_budget')).toBe(true);
  });

  it('retains normal direct replies within the budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagent-loop-direct-'));
    directories.push(root);
    const call = vi.fn<LLMProvider['call']>().mockResolvedValue(response('Complete answer'));
    const result = await runAgentLoop({
      id: 'document', name: 'Document', systemPrompt: 'Write',
      model: 'test', provider: { name: 'test', call, stream: async function* () {} },
      tools: new ToolRegistry(), traceWriter: new TraceWriter(join(root, 'trace.jsonl')), costTracker: new CostTracker(),
      maxDurationMs: 1000,
    }, 'Write a summary');
    expect(result.output).toBe('Complete answer');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('does not call the model when the task budget is already exhausted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagent-loop-no-budget-'));
    directories.push(root);
    const call = vi.fn<LLMProvider['call']>().mockResolvedValue(response('Should not run'));
    const result = await runAgentLoop({ id: 'document', name: 'Document', systemPrompt: 'Write',
      model: 'test', provider: { name: 'test', call, stream: async function* () {} },
      tools: new ToolRegistry(), traceWriter: new TraceWriter(join(root, 'trace.jsonl')),
      costTracker: new CostTracker(), maxCostPerTask: 0,
    }, 'Write a summary');
    expect(call).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.output).toContain('预算已用尽');
  });

  it.each(['model_error', 'limit_error', 'limit_empty'])('retains tool evidence without claiming success after %s', async failure => {
    const root = mkdtempSync(join(tmpdir(), 'tagent-loop-failure-'));
    directories.push(root);
    const tools = new ToolRegistry();
    tools.register({ definition: { name: 'read_url', description: 'Read', parameters: { type: 'object' } },
      execute: async () => 'Actual source: https://example.com/report, published 2026-09-10. Pending verification.' });
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce({ ...response('I will gather sources'), stopReason: 'tool_use',
      toolCalls: [{ id: 'read', name: 'read_url', arguments: '{"url":"https://example.com/report"}' }] });
    if (failure === 'limit_empty') call.mockResolvedValueOnce(response(''));
    else call.mockRejectedValueOnce(new Error('Connection error'));
    const complete = vi.fn();
    const result = await runAgentLoop({
      id: 'research', name: 'Research', systemPrompt: 'Research', model: 'test',
      provider: { name: 'test', call, stream: async function* () {} }, tools,
      costTracker: new CostTracker(), traceWriter: new TraceWriter(join(root, 'trace.jsonl')),
      maxIterations: failure === 'model_error' ? 5 : 1,
    }, 'Research a topic', { onComplete: complete });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Actual source: https://example.com/report');
    expect(result.output).toContain('任务未完整完成');
    expect(result.output).not.toContain('I will gather sources');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'Partial answer'])('does not label empty or truncated model text as a successful deliverable', async text => {
    const root = mkdtempSync(join(tmpdir(), 'tagent-loop-empty-'));
    directories.push(root);
    const call = vi.fn<LLMProvider['call']>().mockResolvedValue({ ...response(text), stopReason: text ? 'max_tokens' : 'end' });
    const result = await runAgentLoop({ id: 'document', name: 'Document', systemPrompt: 'Write', model: 'test',
      provider: { name: 'test', call, stream: async function* () {} }, tools: new ToolRegistry(),
      costTracker: new CostTracker(), traceWriter: new TraceWriter(join(root, 'trace.jsonl')),
    }, 'Write');
    expect(result.success).toBe(false);
    expect(result.output.trim()).not.toBe('');
  });

  it.each(['suggest', 'auto_edit'] as const)('does not execute %s tools without an approval handler', async approvalMode => {
    const root = mkdtempSync(join(tmpdir(), 'tagent-loop-approval-'));
    directories.push(root);
    const tools = new ToolRegistry();
    const execute = vi.fn(async () => 'should not run');
    tools.register({ definition: { name: 'external_write', description: 'Write', parameters: { type: 'object' } }, execute });
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce({ ...response('Request action'), stopReason: 'tool_use',
      toolCalls: [{ id: 'write', name: 'external_write', arguments: '{}' }] }).mockImplementationOnce(async params => {
        expect(params.messages.find(message => message.toolCallId === 'write')?.content).toContain('未取得执行确认');
        return response('Action was not executed.');
      });
    const governance = vi.fn();
    await runAgentLoop({ id: 'custom', name: 'Custom', systemPrompt: 'Work', model: 'test', tools, approvalMode,
      provider: { name: 'test', call, stream: async function* () {} }, costTracker: new CostTracker(),
      traceWriter: new TraceWriter(join(root, 'trace.jsonl')),
    }, 'Work', { onGovernance: governance });
    expect(execute).not.toHaveBeenCalled();
    expect(governance).toHaveBeenCalledWith(expect.objectContaining({ ruleName: 'approval', result: 'blocked' }));
  });

  it('does not advertise denied tools and still pairs hallucinated tool calls with blocked results', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagent-loop-whitelist-'));
    directories.push(root);
    const tools = new ToolRegistry();
    const execute = vi.fn(async () => 'should not run');
    tools.register({ definition: { name: 'denied', description: 'Denied', parameters: { type: 'object' } }, execute });
    const call = vi.fn<LLMProvider['call']>().mockImplementationOnce(async params => {
      expect(params.tools).toBeUndefined();
      return { ...response('Request'), stopReason: 'tool_use', toolCalls: [{ id: 'denied-call', name: 'denied', arguments: '{}' }] };
    }).mockImplementationOnce(async params => {
      expect(params.messages.find(message => message.toolCallId === 'denied-call')?.content).toContain('未在白名单中');
      return response('Not executed');
    });
    await runAgentLoop({ id: 'limited', name: 'Limited', systemPrompt: 'Work', model: 'test', tools, allowedTools: [],
      provider: { name: 'test', call, stream: async function* () {} }, costTracker: new CostTracker(),
      traceWriter: new TraceWriter(join(root, 'trace.jsonl')),
    }, 'Work');
    expect(execute).not.toHaveBeenCalled();
  });
});
