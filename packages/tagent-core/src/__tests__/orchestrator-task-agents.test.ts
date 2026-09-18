import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMResponse } from '@tagent/ai';
import { AgentPool } from '../agent-pool.js';
import { normalizeTaskPlan } from '../task-plan.js';
import type { AgentCard } from '../agent-card.js';
vi.mock('../trace.js', () => ({ TraceWriter: class { write() {} getPath() { return 'fixture'; } } }));
vi.mock('../tools/browser.js', () => ({ createBrowserToolSession: () => ({ tools: [], close: async () => {} }) }));
import { runOrchestrator } from '../orchestrator.js';

const reply = (content: string): LLMResponse => ({ content, toolCalls: [], model: 'fixture', stopReason: 'end', usage: { inputTokens: 10, outputTokens: 5, cost: 0 } });
const tasks = [
  { id: 'first', agentRole: 'document', objective: '整理材料', spawn: { name: '材料整理', reason: '独立上下文' } },
  { id: 'second', agentRole: 'document', objective: '核对整理结果', spawn: { name: '交接核对', reason: '需要第二层核对', parentTaskId: 'first' } },
];
const provider = (call: LLMProvider['call']): LLMProvider => ({ name: 'fixture', call, stream: async function* () {} });

describe('controlled planned task Agents', () => {
  it('executes two inherited generations, persists before events, and rejects a third generation', async () => {
    const pool = new AgentPool(), parent = pool.getAgent('document-agent')!;
    parent.constraints.maxFissionDepth = 2; parent.constraints.maxCostPerTask = 0.2;
    parent.constraints.allowedTools = []; parent.capabilities.skills = ['office-check'];
    parent.card.soul = '继承的办公材料边界';
    const snapshots: AgentCard[] = [];
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(reply(JSON.stringify([...tasks,
      { id: 'third', agentRole: 'document', objective: '不允许的第三层', spawn: { name: '第三层', reason: '模型请求', parentTaskId: 'second' } },
    ]))).mockImplementation(async params => {
      if (params.messages[0]!.content.includes('继承的办公材料边界')) expect(params.tools || []).toEqual([]);
      return reply('整理材料的完整结果，不应因为无法继续创建第三层而丢失。');
    });
    const spawned = vi.fn(), governance = vi.fn(), completed = vi.fn();
    const result = await runOrchestrator({ provider: provider(call), model: 'fixture', agentPool: pool, maxTotalCost: 0.8,
      workspaceId: 'ws', sessionId: 's', runId: 'r', persistTaskAgent: async agent => { snapshots.push(structuredClone(agent)); return pool.publishTaskAgent(agent); },
    }, '用子 Agent 分两层整理材料', {
      onAgentSpawned: (agent, task) => { expect(snapshots.some(saved => saved.id === agent.id && saved.spawnMeta?.status === 'running')).toBe(true); spawned(agent, task); },
      onAgentComplete: completed, onGovernanceEvent: governance,
    });
    expect(spawned).toHaveBeenCalledTimes(2); expect(completed).toHaveBeenCalledTimes(2);
    const [first, second] = pool.getTaskAgents();
    expect(first).toMatchObject({ parentAgentId: parent.id, constraints: { maxFissionDepth: 1, allowedTools: [], maxCostPerTask: 0.1 }, spawnMeta: { depth: 1, status: 'completed', sessionId: 's', runId: 'r' } });
    expect(second).toMatchObject({ parentAgentId: first!.id, constraints: { maxFissionDepth: 0, maxCostPerTask: 0.05 }, spawnMeta: { depth: 2, status: 'completed' } });
    expect(first!.childAgentIds).toContain(second!.id);
    expect(second!.capabilities.skills).toEqual(parent.capabilities.skills);
    expect(governance.mock.calls.some(args => args[1].ruleName === 'task_agent_spawn' && args[1].result === 'blocked')).toBe(true);
    expect(result.success).toBe(false); expect(result.subResults).toHaveLength(2);
    expect(completed.mock.calls[1]![2]).toMatchObject({ taskId: 'second', parentTaskId: 'first' });
    expect(snapshots).toHaveLength(4);
  });

  it('does not create a child when the parent requires user confirmation', async () => {
    const pool = new AgentPool(); pool.getAgent('document-agent')!.constraints.approvalMode = 'suggest';
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(reply(JSON.stringify([tasks[0]]))).mockResolvedValue(reply('未获得创建确认。'));
    const save = vi.fn(), spawned = vi.fn();
    await runOrchestrator({ provider: provider(call), model: 'fixture', agentPool: pool, persistTaskAgent: save }, '整理材料', { onAgentSpawned: spawned });
    expect(save).not.toHaveBeenCalled(); expect(spawned).not.toHaveBeenCalled(); expect(pool.getTaskAgents()).toEqual([]);
  });

  it('does not execute or announce a child before its initial history write succeeds', async () => {
    const pool = new AgentPool();
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(reply(JSON.stringify([tasks[0]])));
    const spawned = vi.fn();
    await expect(runOrchestrator({ provider: provider(call), model: 'fixture', agentPool: pool,
      persistTaskAgent: async () => { throw new Error('任务历史保存失败'); },
    }, '整理材料', { onAgentSpawned: spawned })).rejects.toThrow('保存失败');
    expect(call).toHaveBeenCalledTimes(1); expect(spawned).not.toHaveBeenCalled(); expect(pool.getTaskAgents()).toEqual([]);
  });

  it('validates model spawn requests and adds parent task dependencies', () => {
    expect(normalizeTaskPlan(tasks, '原任务')[1]!.dependsOn).toEqual(['first']);
    for (const forbidden of [{ allowedTools: ['shell'] }, { maxCost: 100 }, { confirmed: true }]) {
      expect(normalizeTaskPlan([{ ...tasks[0], spawn: { ...tasks[0]!.spawn, ...forbidden } }], '原任务')).toEqual([]);
    }
    expect(normalizeTaskPlan([{ ...tasks[0], spawn: { ...tasks[0]!.spawn, parentTaskId: 'missing' } }], '原任务')).toEqual([]);
    expect(normalizeTaskPlan([{ ...tasks[0], spawn: { ...tasks[0]!.spawn, parentTaskId: 'first' } }], '原任务')).toEqual([]);
  });

  it('retains an executed draft if its terminal history write fails, without marking it saved', async () => {
    const pool = new AgentPool();
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(reply(JSON.stringify([tasks[0]])))
      .mockResolvedValue(reply('已完成的付费材料草稿，保存历史失败时也不能丢弃。'));
    const completed = vi.fn();
    const result = await runOrchestrator({ provider: provider(call), model: 'fixture', agentPool: pool,
      persistTaskAgent: async agent => {
        if (agent.spawnMeta?.status !== 'running') throw new Error('历史保存失败');
        return pool.publishTaskAgent(agent);
      },
    }, '整理材料', { onAgentComplete: completed });
    expect(result.success).toBe(false);
    expect(result.subResults[0]?.summary).toContain('付费材料草稿');
    expect(completed).not.toHaveBeenCalled();
    expect(pool.getTaskAgents()[0]?.spawnMeta?.status).toBe('running');
  });
});
