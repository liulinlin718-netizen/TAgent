import { describe, expect, it } from 'vitest';
import { AgentPool } from '@tagent/core';
import type { AgentLoopResult, WorkflowEvent } from '@tagent/core';
import { createWorkflowHandlers } from '../workflow-events.js';
import { snapshotAgentForWorkflow } from '../workflow-snapshot.js';

describe('task-scoped workflow handlers', () => {
  it('captures independent capability records without prompts, runtime statistics or arbitrary secret fields', () => {
    const agent = new AgentPool().getAgent('research-agent')!;
    agent.card.soul = 'private-prompt-fixture';
    Object.assign(agent.capabilities, { env: { TOKEN: 'private-token-fixture' } });
    const snapshot = snapshotAgentForWorkflow(agent, 'research', 123);
    const expectedTools = [...snapshot.constraints.allowedTools];
    agent.name = 'Changed later';
    agent.capabilities.skills.push('later-skill');
    agent.constraints.allowedTools.length = 0;
    expect(snapshot.capturedAt).toBe(123);
    expect(snapshot.name).not.toBe('Changed later');
    expect(snapshot.capabilities.skills).not.toContain('later-skill');
    expect(snapshot.constraints.allowedTools).toEqual(expectedTools);
    expect(JSON.stringify(snapshot)).not.toMatch(/private-prompt|private-token|stats|scoreProfile/);
  });

  it('keeps interleaved stages, tools, governance, completion and failures attached to their tasks', () => {
    const recorded: Array<{ type: string; data: Record<string, unknown>; overrides?: Partial<WorkflowEvent> }> = [];
    const handlers = createWorkflowHandlers({ emit: (type, data, overrides) => recorded.push({ type, data, overrides }), text: () => {}, complete: () => {} });
    const agent = new AgentPool().getAgent('research-agent')!;
    handlers.onAgentSpawned!(agent, { id: 'a', agentRole: 'research', objective: 'Task A' });
    handlers.onAgentSpawned!(agent, { id: 'b', agentRole: 'research', objective: 'Task B' });
    handlers.onAgentStage!(agent.id, 'execute', 'B executing', { taskId: 'b' });
    handlers.onAgentToolCall!(agent.id, 'web_research', { query: 'Task A' }, { taskId: 'a' });
    handlers.onAgentProgress!(agent.id, 2, { taskId: 'b' });
    handlers.onAgentToolResult!(agent.id, 'web_research', 123, { taskId: 'a' });
    handlers.onGovernanceEvent!(agent.id, { policyType: 'safety', severity: 'warning', result: 'blocked', message: 'fixture' }, { taskId: 'b' });
    const result = { success: true, output: 'Task A output', iterations: 2, totalCost: 0.1 } as AgentLoopResult;
    handlers.onAgentComplete!(agent.id, result, { taskId: 'a' });
    handlers.onAgentFailed!(agent.id, 'Task B failure', { taskId: 'b' });
    handlers.onSynthesisStart!();
    expect(recorded.slice(0, -1).map(event => event.data.taskId)).toEqual(['a', 'b', 'b', 'a', 'b', 'a', 'b', 'a', 'b']);
    expect(recorded[0].overrides?.agentSnapshot).toMatchObject({ id: agent.id, version: 1, role: 'research' });
    expect(recorded[7].data.outputSummary).toBe('Task A output');
    expect(recorded.at(-1)?.data.taskId).toBeUndefined();
  });
});
