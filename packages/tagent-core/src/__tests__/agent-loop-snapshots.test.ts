import { describe, expect, it, vi } from 'vitest';
import { CostTracker, type LLMProvider, type LLMResponse } from '@tagent/ai';
import { runAgentLoop } from '../agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { TraceWriter } from '../trace.js';
import type { ExecutionSnapshot } from '../execution-snapshot.js';

vi.mock('../trace.js', () => ({ TraceWriter: class { write() {} getPath() { return 'fixture'; } } }));
const response: LLMResponse = { content: '完整答复', toolCalls: [], model: 'fixture', stopReason: 'end', usage: { inputTokens: 10, outputTokens: 4, cost: 0 } };

describe('Agent Loop snapshot capture', () => {
  it('captures the real run context before model execution', async () => {
    const snapshots: ExecutionSnapshot[] = [], call = vi.fn<LLMProvider['call']>(async () => {
      expect(snapshots).toHaveLength(1); return response;
    });
    await runAgentLoop({ id: 'agent', name: '办公助手', systemPrompt: '规则', provider: { name: 'fixture', call, stream: async function* () {} },
      model: 'fixture', tools: new ToolRegistry(), traceWriter: new TraceWriter('unused'), costTracker: new CostTracker(),
      snapshotScope: { workspaceId: 'ws', sessionId: 'session', runId: 'run-example', taskId: 'task' },
      captureSnapshot: async snapshot => { snapshots.push(snapshot); },
    }, '中文任务');
    expect(snapshots[0]).toMatchObject({ workspaceId: 'ws', sessionId: 'session', runId: 'run-example', agentId: 'agent', taskId: 'task', iteration: 1 });
    expect(snapshots[0].messages.at(-1)!.content).toBe('中文任务');
  });
  it('reports a snapshot write failure without discarding the final answer', async () => {
    const governance = vi.fn();
    const result = await runAgentLoop({ id: 'agent', name: '办公助手', systemPrompt: '规则',
      provider: { name: 'fixture', call: async () => response, stream: async function* () {} }, model: 'fixture',
      tools: new ToolRegistry(), traceWriter: new TraceWriter('unused'), costTracker: new CostTracker(),
      snapshotScope: { workspaceId: 'ws', sessionId: 'session', runId: 'run-example' }, captureSnapshot: async () => { throw new Error('disk full'); },
    }, '中文任务', { onGovernance: governance });
    expect(result.output).toBe('完整答复'); expect(result.success).toBe(true);
    expect(governance).toHaveBeenCalledWith(expect.objectContaining({ ruleName: 'snapshot_storage', result: 'warning' }));
  });
});
