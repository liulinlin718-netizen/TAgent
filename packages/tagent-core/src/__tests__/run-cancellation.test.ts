import { describe, expect, it, vi } from 'vitest';
import { CostTracker, type LLMProvider, type LLMResponse } from '@tagent/ai';
import { runAgentLoop } from '../agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { TraceWriter } from '../trace.js';
import { runOrchestrator } from '../orchestrator.js';
import { executeTaskPlan } from '../task-plan.js';
import { RunAbortedError, withRunSignal } from '../run-control.js';

vi.mock('../trace.js', () => ({ TraceWriter: class { write() {} getPath() { return 'memory'; } } }));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const response = (content: string): LLMResponse => ({ content, toolCalls: [], stopReason: 'end', model: 'test',
  usage: { inputTokens: 10, outputTokens: 5, cost: 0.02 } });
const provider = (call: LLMProvider['call']): LLMProvider => ({ name: 'test', call, stream: async function* () {} });
const config = (call: LLMProvider['call'], tools: ToolRegistry, signal: AbortSignal) => ({
  id: 'research', name: 'Research', systemPrompt: 'Read only', model: 'test', provider: provider(call), tools,
  signal, traceWriter: new TraceWriter('unused'), costTracker: new CostTracker(),
});
const toolResponse = () => ({ ...response('Read materials'), stopReason: 'tool_use' as const,
  toolCalls: [{ id: 'a', name: 'read_url', arguments: '{}' }, { id: 'b', name: 'read_url', arguments: '{}' }] });

describe('cooperative run cancellation', () => {
  it('retains a charged final draft that arrives concurrently with cancellation', async () => {
    const controller = new AbortController();
    const call = vi.fn<LLMProvider['call']>().mockImplementation(async () => {
      controller.abort(); return response('A completed model draft, pending verification.');
    });
    const result = await runAgentLoop(config(call, new ToolRegistry(), controller.signal), 'Write');
    expect(result).toMatchObject({ success: false, totalCost: 0.02, termination: 'cancelled' });
    expect(result.output).toContain('A completed model draft');
    expect(result.output).toContain('未核验草稿');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('waits for actual tool cleanup, skips pending calls and never requests paid synthesis after stop', async () => {
    const controller = new AbortController();
    const entered = deferred(), aborted = deferred(), cleaned = deferred();
    const execute = vi.fn(async (_args, context) => {
      expect(context.signal).toBe(controller.signal);
      context.signal.addEventListener('abort', aborted.resolve, { once: true });
      entered.resolve();
      await cleaned.promise;
      return 'Already-read source: https://example.com/report';
    });
    const tools = new ToolRegistry();
    tools.register({ definition: { name: 'read_url', description: 'Read', parameters: {} }, execute });
    const call = vi.fn<LLMProvider['call']>().mockResolvedValue(toolResponse());
    const complete = vi.fn(), resultEvent = vi.fn();
    const running = runAgentLoop(config(call, tools, controller.signal), 'Read', { onComplete: complete, onToolResult: resultEvent });
    await entered.promise;
    controller.abort(new RunAbortedError('cancelled'));
    await aborted.promise;
    expect(complete).not.toHaveBeenCalled();
    cleaned.resolve();
    const result = await running;
    expect(result).toMatchObject({ success: false, termination: 'cancelled', totalCost: 0.02 });
    expect(result.output).toContain('https://example.com/report');
    expect(result.output).toContain('可能仍被服务商计费');
    expect(call).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(resultEvent).toHaveBeenCalledTimes(2);
    expect(resultEvent.mock.calls[1][1]).toContain('未执行');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('cancels a waiting model and retains prior tool material and received usage', async () => {
    const controller = new AbortController(), entered = deferred();
    const tools = new ToolRegistry();
    tools.register({ definition: { name: 'read_url', description: 'Read', parameters: {} }, execute: async () => 'Preserved material' });
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(toolResponse())
      .mockImplementation(params => new Promise((_resolve, reject) => {
        params.signal!.addEventListener('abort', () => reject(params.signal!.reason), { once: true }); entered.resolve();
      }));
    const task = runAgentLoop(config(call, tools, controller.signal), 'Read');
    await entered.promise;
    controller.abort(new RunAbortedError('deadline'));
    const result = await task;
    expect(result).toMatchObject({ success: false, totalCost: 0.02, termination: 'deadline' });
    expect(result.output).toContain('Preserved material');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('releases pending approvals and ignores approval after cancellation', async () => {
    const controller = new AbortController(), entered = deferred();
    const execute = vi.fn(async () => 'Should not execute');
    const tools = new ToolRegistry();
    tools.register({ definition: { name: 'read_url', description: 'Read', parameters: {} }, execute });
    let approve!: (value: boolean) => void;
    const call = vi.fn<LLMProvider['call']>().mockResolvedValue(toolResponse());
    const task = runAgentLoop({ ...config(call, tools, controller.signal), approvalMode: 'suggest' }, 'Read', {
      onApprovalRequest: request => { approve = request.resolve; entered.resolve(); },
    });
    await entered.promise;
    controller.abort();
    const result = await task;
    approve(true);
    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('does not start dependent tasks and waits for all running siblings', async () => {
    const controller = new AbortController(), sibling = deferred(), entered = deferred();
    const execute = vi.fn(async task => {
      if (task.id === 'a') return 'a';
      entered.resolve(); await sibling.promise; return 'b';
    });
    const running = executeTaskPlan([{ id: 'a', agentRole: 'document', objective: 'a' },
      { id: 'b', agentRole: 'document', objective: 'b' }, { id: 'c', agentRole: 'document', objective: 'c', dependsOn: ['a', 'b'] }], execute, controller.signal);
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    await entered.promise;
    controller.abort();
    expect(settled).toBe(false);
    sibling.resolve();
    await expect(running).rejects.toThrow();
    expect(execute.mock.calls.map(([task]) => task.id)).toEqual(['a', 'b']);
  });

  it('returns one final result when cancelled during decomposition', async () => {
    const controller = new AbortController(), entered = deferred();
    const call = vi.fn<LLMProvider['call']>().mockImplementation(params => new Promise((_resolve, reject) => {
      params.signal!.addEventListener('abort', () => reject(params.signal!.reason), { once: true }); entered.resolve();
    }));
    const complete = vi.fn(), spawned = vi.fn();
    const task = runOrchestrator({ provider: provider(call), model: 'test', signal: controller.signal }, 'Plan an office task', {
      onComplete: complete, onAgentSpawned: spawned,
    });
    await entered.promise;
    controller.abort(new RunAbortedError('disconnected'));
    expect(await task).toMatchObject({ success: false, termination: 'disconnected', totalCost: 0 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(spawned).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'deadline', 'storage_failure'] as const)('retains office review receipts in the unique %s final result', async termination => {
    const controller = new AbortController(), complete = vi.fn();
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(response('[]'))
      .mockResolvedValueOnce(response('A completed office draft.'))
      .mockImplementationOnce(async () => { controller.abort(new RunAbortedError(termination)); return response('{retained-raw-review}'); });
    const result = await runOrchestrator({ provider: provider(call), model: 'deepseek-chat', signal: controller.signal }, '整理给定办公材料，不联网。', { onComplete: complete });
    expect(result).toMatchObject({ success: false, termination, totalCost: .06,
      deliveryReview: { status: 'unverified', receipt: { status: 'received', rawOutput: '{retained-raw-review}', usage: { cost: .02 } } } });
    expect(result.output).toContain('A completed office draft.');
    expect(result.output).not.toContain('{retained-raw-review}');
    expect(result.deliveryReview?.issues.join()).toContain('任务已中断');
    expect(complete).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(3);
  });

  it('rejects pre-aborted nested model and tool calls before invoking implementations', async () => {
    const controller = new AbortController(); controller.abort();
    const call = vi.fn(), execute = vi.fn();
    const tools = new ToolRegistry(controller.signal);
    tools.register({ definition: { name: 'blocked', description: '', parameters: {} }, execute });
    await expect(tools.execute('blocked', {})).rejects.toThrow();
    expect(() => withRunSignal(provider(call), controller.signal).call({ model: 'test', messages: [] })).toThrow();
    expect(call).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
});
