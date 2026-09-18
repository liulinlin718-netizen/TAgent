import { describe, expect, it } from 'vitest';
import { AgentPool } from '../agent-pool.js';

describe('AgentPool task-spawned agents', () => {
  it('creates task agents with inherited skills, tools, governance limits, and source metadata', () => {
    const pool = new AgentPool();
    const parent = pool.getAgent('research-agent');
    expect(parent).toBeTruthy();

    const child = pool.spawnTaskAgent('research-agent', {
      name: 'AI Agent 近况检索子 Agent',
      objective: '检索近 30 天 AI Agent 最新进展',
      createdReason: '主 Agent 将调研任务拆成独立检索子任务。',
      sessionId: 'sess-1',
      runId: 'run-1',
      taskId: 'task-1',
      inputSummary: '用户需要最新进展、来源日期和 URL。',
    });

    expect(child.type).toBe('task_spawned');
    expect(child.parentAgentId).toBe('research-agent');
    expect(child.spawnMeta).toMatchObject({
      sessionId: 'sess-1',
      runId: 'run-1',
      taskId: 'task-1',
      objective: '检索近 30 天 AI Agent 最新进展',
      createdReason: '主 Agent 将调研任务拆成独立检索子任务。',
    });
    expect(child.capabilities.skills).toEqual(parent!.capabilities.skills);
    expect(child.constraints.allowedTools).toEqual(parent!.constraints.allowedTools);
    expect(child.constraints.maxFissionDepth).toBe(parent!.constraints.maxFissionDepth - 1);
    expect(child.constraints.maxCostPerTask).toBeCloseTo(parent!.constraints.maxCostPerTask * 0.5);
    expect(pool.getAgent('research-agent')?.childAgentIds).toContain(child.id);
    expect(pool.getTaskAgents({ parentId: 'research-agent', runId: 'run-1' }).map(agent => agent.id)).toEqual([child.id]);
  });

  it('blocks uncontrolled recursive fission when depth is exhausted', () => {
    const pool = new AgentPool();
    const child = pool.spawnTaskAgent('research-agent', {
      name: '一级子 Agent',
      objective: '拆解一级任务',
      createdReason: '测试裂变深度。',
    });
    const grandchild = pool.spawnTaskAgent(child.id, {
      name: '二级子 Agent',
      objective: '拆解二级任务',
      createdReason: '测试裂变深度。',
    });

    expect(grandchild.constraints.maxFissionDepth).toBe(0);
    expect(() => pool.spawnTaskAgent(grandchild.id, {
      name: '三级子 Agent',
      objective: '不应被允许的继续裂变',
      createdReason: '测试裂变深度。',
    })).toThrow(/max fission depth/);
  });

  it('creates a resident draft from a task agent without saving until promotion is explicit', () => {
    const pool = new AgentPool();
    const child = pool.spawnTaskAgent('research-agent', {
      name: '来源验证子 Agent',
      objective: '验证来源日期和 URL',
      createdReason: '主 Agent 需要单独验证来源。',
    });

    const draft = pool.createResidentFromTaskAgent(child.id, { name: '来源验证常驻 Agent 草稿' });
    expect(draft.type).toBe('resident');
    expect(draft.parentAgentId).toBeNull();
    expect(pool.getAgent(draft.id)).toBeUndefined();
    expect(pool.getAgent(child.id)?.spawnMeta?.promotedAgentId).toBeUndefined();
    const originalSkills = [...child.capabilities.skills];
    const originalScore = child.card.scoreProfile.research;
    draft.capabilities.skills.push('draft-only-skill');
    draft.card.scoreProfile.research = 0;
    expect(child.capabilities.skills).toEqual(originalSkills);
    expect(child.card.scoreProfile.research).toBe(originalScore);
    child.card.scoreProfile.research = 1;
    expect(pool.getAgent('research-agent')!.card.scoreProfile.research).not.toBe(1);

    const saved = pool.promoteTaskAgent(child.id, { name: '来源验证常驻 Agent' });
    expect(saved.type).toBe('resident');
    expect(pool.getAgent(saved.id)?.id).toBe(saved.id);
    expect(pool.getAgent(child.id)?.spawnMeta?.promotedAgentId).toBe(saved.id);
  });
});
