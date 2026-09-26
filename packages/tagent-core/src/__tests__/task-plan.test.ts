import { describe, expect, it, vi } from 'vitest';
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
  it('starts a dependent task as soon as its parent finishes and a slot opens', async () => {
    const tasks = [
      { id: 'fast', agentRole: 'research', objective: 'A' },
      { id: 'slow', agentRole: 'research', objective: 'B' },
      { id: 'child', agentRole: 'document', objective: 'C', dependsOn: ['fast'] },
    ];
    let releaseFast!: () => void;
    let releaseSlow!: () => void;
    const fast = new Promise<void>(resolve => { releaseFast = resolve; });
    const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
    const started: string[] = [];
    const completed = executeTaskPlan(tasks, async (task, dependencies: string[]) => {
      started.push(task.id);
      if (task.id === 'fast') await fast;
      if (task.id === 'slow') await slow;
      if (task.id === 'child') expect(dependencies).toEqual(['fast']);
      return task.id;
    });
    expect(started).toEqual(['fast', 'slow']);
    releaseFast();
    await vi.waitFor(() => expect(started).toContain('child'));
    releaseSlow();
    await completed;
  });
  it('does not report completion when cancellation arrives with the final child result', async () => {
    const controller = new AbortController();
    const tasks = normalizeTaskPlan([{ id: 'only', agentRole: 'research', objective: 'Collect' }], 'Topic');
    await expect(executeTaskPlan(tasks, async () => {
      controller.abort();
      return 'collected';
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
