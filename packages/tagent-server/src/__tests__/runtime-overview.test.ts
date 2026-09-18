import { describe, expect, it } from 'vitest';
import { AgentPool, MemoryPersistence } from '@tagent/core';
import type { WorkflowEvent } from '@tagent/core';
import { Store, type TraceEvent } from '../store.js';
import { WorkflowCatalog } from '../workflow-catalog.js';
import { runtimeOverview } from '../runtime-overview.js';

async function fixture() {
  const persistence = new MemoryPersistence(), store = await Store.open(persistence);
  const workspaceId = store.listWorkspaces()[0]!.id, sessionId = (await store.createSession(workspaceId))!.id;
  await store.beginRun(workspaceId, sessionId, 'run-runtime', '材料整理');
  const event = (type: WorkflowEvent['type'], timestamp: number, data: Record<string, unknown> = {}): TraceEvent => ({
    eventId: `event-${timestamp}`, runId: 'run-runtime', sessionId, type, timestamp, data, summary: type,
    agentId: 'research-agent', taskId: 't1', ...(type.startsWith('agent_tool') ? { toolName: 'web_research' } : {}),
  });
  return { store, persistence, workspaceId, sessionId, event, pool: new AgentPool() };
}

describe('runtime metrics derived from canonical task history', () => {
  it('records actual tools and outcomes once, excluding copied branch history', async () => {
    const f = await fixture(), receipt = f.store.findRun('run-runtime')!;
    await f.store.finishRun(f.workspaceId, f.sessionId, 'run-runtime', { ...receipt.message, content: '已完成', cost: 0.02,
      tokens: { input: 100, output: 20 }, run: { ...receipt.message.run!, status: 'finished' },
      traces: [f.event('agent_tool_call', 1000), f.event('agent_tool_result', 1500),
        f.event('agent_complete', 1600, { success: true }), f.event('complete', 1700, { success: true })] });
    await f.store.forkSession(f.workspaceId, f.sessionId, 'fork_full');
    const reopened = await Store.open(f.persistence), result = runtimeOverview(new WorkflowCatalog(reopened), f.pool.getResidentAgents());
    expect(result).toMatchObject({ recordedRuns: 1, finishedRuns: 1, knownCost: 0.02, failedRuns: 0 });
    expect(result.tools).toEqual([{ name: 'web_research', calls: 1, results: 1, averageMs: 500 }]);
    expect(result.agents.find(agent => agent.id === 'document-agent')!.status).toBe('not_used');
  });
  it('reports waiting rather than dead for an approval with no subsequent activity', async () => {
    const f = await fixture();
    const catalog = new WorkflowCatalog(f.store, () => [{ workspaceId: f.workspaceId, sessionId: f.sessionId, runId: 'run-runtime',
      traces: [f.event('governance', 1000, { approval: { status: 'pending' } })] }]);
    const result = runtimeOverview(catalog, f.pool.getResidentAgents(), 1000000);
    expect(result.activeRuns).toBe(1); expect(result.agents.find(agent => agent.id === 'research-agent')!.status).toBe('waiting');
    expect(result.knownCost).toBe(0); expect(result.finishedRuns).toBe(0);
  });
  it('does not treat an interrupted record with missing cost as successful or free', async () => {
    const f = await fixture(), receipt = f.store.findRun('run-runtime')!;
    await f.store.finishRun(f.workspaceId, f.sessionId, 'run-runtime', { ...receipt.message, content: '中断',
      run: { ...receipt.message.run!, status: 'interrupted' } });
    const result = runtimeOverview(new WorkflowCatalog(f.store), f.pool.getResidentAgents());
    expect(result.failedRuns).toBe(1); expect(result.runsWithoutCost).toBe(1);
  });
  it('does not reactivate a completed agent on governance events or count repeated terminal events twice', async () => {
    const f = await fixture();
    const catalog = new WorkflowCatalog(f.store, () => [{ workspaceId: f.workspaceId, sessionId: f.sessionId, runId: 'run-runtime',
      traces: [f.event('agent_spawn', 1000), f.event('agent_complete', 2000, { success: true }),
        f.event('agent_complete', 2100, { success: true }), f.event('governance', 2200, { result: 'passed' })] }]);
    const result = runtimeOverview(catalog, f.pool.getResidentAgents(), 2300);
    expect(result.activeRuns).toBe(1);
    expect(result.agents.find(agent => agent.id === 'research-agent')).toMatchObject({ status: 'idle', activeRuns: 0, completed: 1 });
  });
});
