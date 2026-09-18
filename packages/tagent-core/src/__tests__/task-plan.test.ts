import { describe, expect, it } from 'vitest';
import { executeTaskPlan, normalizeTaskPlan } from '../task-plan.js';

describe('task dependency handoffs', () => {
  it('retains the user topic and waits for research before writing', async () => {
    const tasks = normalizeTaskPlan([
      { id: 'research', agentRole: 'research', objective: '查找来源', searchQuery: 'AI Agent release' },
      { id: 'document', agentRole: 'document', objective: '整理重要进展' },
    ], '近30天 AI Agent 最新进展');
    expect(tasks.every(task => task.originalTask?.includes('AI Agent'))).toBe(true);
    expect(tasks[1].dependsOn).toEqual(['research']);
    const order: string[] = [];
    await executeTaskPlan(tasks, async (task, input: string[]) => {
      order.push(task.id);
      if (task.id === 'document') expect(input).toEqual(['SOURCE https://example.com/verified']);
      return 'SOURCE https://example.com/verified';
    });
    expect(order).toEqual(['research', 'document']);
  });
  it('rejects unknown roles, duplicate IDs and dependency cycles', () => {
    const task = { id: 'a', agentRole: 'research', objective: 'Search' };
    expect(normalizeTaskPlan([task, task], 'test')).toEqual([]);
    expect(normalizeTaskPlan([{ ...task, agentRole: 'shell' }], 'test')).toEqual([]);
    expect(normalizeTaskPlan([{ ...task, dependsOn: ['missing'] }], 'test')).toEqual([]);
    expect(normalizeTaskPlan([{ ...task, dependsOn: ['b'] }, { ...task, id: 'b', dependsOn: ['a'] }], 'test')).toEqual([]);
  });
  it('starts independent researchers concurrently before their dependent task', async () => {
    const tasks = normalizeTaskPlan([
      { id: 'a', agentRole: 'research', objective: 'First' },
      { id: 'b', agentRole: 'research', objective: 'Second' },
      { id: 'c', agentRole: 'document', objective: 'Write' },
    ], 'Topic');
    const started: string[] = [];
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const result = executeTaskPlan(tasks, async task => {
      started.push(task.id);
      if (task.id !== 'c') await ready;
      return task.id;
    });
    expect(started).toEqual(['a', 'b']);
    release();
    await result;
    expect(started).toEqual(['a', 'b', 'c']);
  });
});
