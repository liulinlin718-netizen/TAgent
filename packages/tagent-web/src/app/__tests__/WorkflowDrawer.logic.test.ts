import { describe, expect, it } from 'vitest';
import type { WorkflowAgentSnapshot } from '@tagent/core';
import {
  agentsForCurrentTask,
  activeWorkflowGroups,
  agentRunStatus,
  eventsForAgent,
  indexAgentEvents,
  resolveEventAgentId,
  groupFlowEvents,
  groupToolEvents,
  parentForAgent,
  runPresentation,
  taskDependencyEdges,
  toWorkflowEvent,
  type AgentCard,
  type TraceEvent,
} from '../WorkflowDrawer.logic';

describe('WorkflowDrawer logic', () => {
  const traces: TraceEvent[] = [
    {
      eventId: 'evt-task',
      type: 'task_decomposition',
      timestamp: 1,
      runId: 'run-1',
      data: { tasks: [{ id: 't1', agentRole: 'research', objective: '近 30 天 AI Agent 最新进展' }] },
    },
    {
      eventId: 'evt-agent',
      type: 'agent_spawn',
      timestamp: 2,
      runId: 'run-1',
      agentId: 'research-agent',
      data: { agentId: 'research-agent', agentName: '研究助手', objective: '近 30 天 AI Agent 最新进展' },
    },
    {
      eventId: 'evt-tool',
      type: 'agent_tool_call',
      timestamp: 3,
      runId: 'run-1',
      agentId: 'research-agent',
      toolName: 'web_research',
      data: { agentId: 'research-agent', tool: 'web_research' },
    },
    {
      eventId: 'evt-governance',
      type: 'governance',
      timestamp: 4,
      runId: 'run-1',
      agentId: 'research-agent',
      data: { agentId: 'research-agent', result: 'passed', message: '字段完整' },
    },
    {
      eventId: 'evt-complete',
      type: 'complete',
      timestamp: 5,
      runId: 'run-1',
      data: { success: true },
    },
  ];

  it('normalizes traces and groups the same run into workflow stages', () => {
    const events = traces.map(toWorkflowEvent);
    const groups = groupFlowEvents(events);

    expect(events.every(event => event.runId === 'run-1')).toBe(true);
    expect(groups.map(group => group.kind)).toEqual(['task', 'dispatch', 'research', 'governance', 'synthesis']);
    expect(groups.find(group => group.kind === 'research')?.events[0].toolName).toBe('web_research');
  });

  it('keeps static architecture limited to agents participating in the current task', () => {
    const agents: AgentCard[] = [
      { id: 'research-agent', name: '研究助手', description: '调研', icon: '🔍' },
      { id: 'document-agent', name: '文档助手', description: '文档', icon: '📄' },
    ];
    const events = traces.map(toWorkflowEvent);
    const currentAgents = agentsForCurrentTask(agents, events);

    expect(currentAgents.map(agent => agent.id)).toEqual(['research-agent']);
  });

  const event = (type: string, agentId?: string, data: Record<string, unknown> = {}, index = 0) =>
    toWorkflowEvent({ type, agentId, timestamp: index, data, runId: 'run-test' }, index);
  const agents: AgentCard[] = [
    { id: 'research-agent', name: '研究助手', description: '调研' },
    { id: 'document-agent', name: '文档助手', description: '文档' },
  ];

  it('indexes large task histories without mixing repeated agent instances', () => {
    const history = Array.from({ length: 240 }, (_, index) => [
      event('agent_spawn', 'office-agent', { taskId: `task-${index}` }, index * 3),
      event('agent_tool_call', 'office-agent', { taskId: `task-${index}`, tool: 'read_url' }, index * 3 + 1),
      event('agent_complete', 'office-agent', { taskId: `task-${index}`, success: true }, index * 3 + 2),
    ]).flat();
    const current = agentsForCurrentTask([], history);
    const indexed = indexAgentEvents(current, history);
    expect(current).toHaveLength(240);
    for (const agent of current) {
      expect(indexed.byAgent.get(agent.id)).toEqual(eventsForAgent(agent, history));
      expect(indexed.byAgent.get(agent.id)).toHaveLength(3);
      expect(agent.acceptsUnscopedEvents).toBe(false);
    }
    expect(history.map(indexed.resolveOwner)).toEqual(history.map(item => resolveEventAgentId(item, current)));
    expect(groupToolEvents(current, history, indexed.resolveOwner)).toHaveLength(240);
  });

  it('preserves legacy ambiguity, name fallback, case and run boundaries in indexed ownership', () => {
    const current: AgentCard[] = [
      { id: 'a', agentId: 'worker', name: 'Same Name', description: '', taskId: 't1', runId: 'one', acceptsUnscopedEvents: true },
      { id: 'b', agentId: 'worker', name: 'Same Name', description: '', taskId: 't2', runId: 'one' },
      { id: 'c', agentId: 'worker', name: 'Same Name', description: '', taskId: 't1', runId: 'two', acceptsUnscopedEvents: true },
      { id: 'legacy', agentId: 'other', name: 'Same Name', description: '' },
    ];
    const history = [undefined, 'one', 'two', 'missing'].flatMap(runId =>
      [undefined, 't1', 't2', 'unknown'].flatMap(taskId =>
        [undefined, 'WORKER', 'other', 'ORCHESTRATOR', 'unknown'].map(agentId => ({
          ...event('agent_tool_call', agentId), agentId, runId, taskId, data: { agentName: 'same name' },
        }))));
    const indexed = indexAgentEvents(current, history);
    for (const agent of current) expect(indexed.byAgent.get(agent.id)).toEqual(eventsForAgent(agent, history));
    for (const item of history) expect(indexed.resolveOwner(item)).toBe(resolveEventAgentId(item, current));
    expect(indexed.resolveOwner(history[0])).toBeUndefined();
  });

  const snapshot: WorkflowAgentSnapshot = { version: 1, capturedAt: 123, id: 'research-agent', name: '启动时研究助手', description: 'Source verification', icon: 'R',
    type: 'resident', role: 'research', parentAgentId: null,
    capabilities: { skills: ['original-skill'], tools: ['web_research'], mcpServers: ['original-mcp'] },
    constraints: { allowedTools: ['web_research'], allowedDomains: [], maxCostPerTask: 0.3, maxFissionDepth: 2, approvalMode: 'suggest' },
    card: { responsibilities: ['Research'], boundaries: ['Read only'], qualityChecks: ['Verify dates'], outputStandards: ['Sources'] } };
  const taskEvent = (type: string, taskId: string, data: Record<string, unknown> = {}, runId = 'run-test') => toWorkflowEvent({
    type, taskId, runId, timestamp: 1, agentId: 'research-agent', eventId: `${runId}-${taskId}-${type}`,
    ...(type === 'agent_spawn' ? { agentSnapshot: structuredClone(snapshot) } : {}), data,
  }, 0);

  it('keeps repeated use of a resident agent separate by task, including tools, cost, status and dependency edges', () => {
    const events = [event('task_decomposition', undefined, { tasks: [{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }] }),
      taskEvent('agent_spawn', 'a'), taskEvent('agent_spawn', 'b'),
      taskEvent('agent_tool_call', 'a', { tool: 'web_research' }), taskEvent('agent_tool_call', 'b', { tool: 'web_research' }),
      taskEvent('agent_tool_result', 'b', { tool: 'web_research', resultLength: 200 }),
      taskEvent('agent_complete', 'b', { success: true, cost: 0.2 }),
      taskEvent('agent_tool_result', 'a', { tool: 'web_research', resultLength: 100 }), taskEvent('agent_complete', 'a', { success: false, cost: 0.1 })];
    const participating = agentsForCurrentTask(agents, events);
    expect(participating.map(agent => agent.taskId)).toEqual(['a', 'b']);
    expect(new Set(participating.map(agent => agent.id)).size).toBe(2);
    expect(groupToolEvents(participating, events).map(group => [group.agentId, group.calls, group.resultLength]))
      .toEqual([[participating[0].id, 1, 100], [participating[1].id, 1, 200]]);
    expect(agentRunStatus(eventsForAgent(participating[0], events), false)).toBe('failed');
    expect(agentRunStatus(eventsForAgent(participating[1], events), false)).toBe('complete');
    expect(eventsForAgent(participating[0], events).find(event => event.type === 'agent_complete')?.cost).toBe(0.1);
    expect(taskDependencyEdges(participating, events)).toEqual([{ source: participating[0].id, target: participating[1].id }]);
  });

  it('uses saved capabilities rather than current hall configuration and marks missing legacy snapshots honestly', () => {
    const events = [taskEvent('agent_spawn', 'a')];
    const changed = [{ ...agents[0], name: 'Edited hall name', capabilities: { skills: ['new-skill'] } }];
    const participating = agentsForCurrentTask(changed, events);
    expect(participating[0]).toMatchObject({ name: snapshot.name, configurationRecorded: true, capabilities: snapshot.capabilities });
    const historical = agentsForCurrentTask(changed, [event('agent_spawn', 'research-agent', { agentName: 'Old name' })])[0];
    expect(historical).toMatchObject({ name: 'Old name', configurationRecorded: false });
    expect(historical.capabilities).toBeUndefined();
    changed[0].name = 'Another edit';
    expect(agentsForCurrentTask(changed, events)).toEqual(participating);
  });

  it('does not guess ownership of unscoped legacy tool results when the same agent has multiple tasks', () => {
    const events = [taskEvent('agent_spawn', 'a'), taskEvent('agent_spawn', 'b'), event('agent_tool_result', 'research-agent', { tool: 'read_url', resultLength: 42 })];
    const participating = agentsForCurrentTask([], events);
    expect(participating).toHaveLength(2);
    expect(groupToolEvents(participating, events)[0]).toMatchObject({ agentId: undefined, resultLength: 42 });
    expect(participating.every(agent => eventsForAgent(agent, events).every(event => event.type === 'agent_spawn'))).toBe(true);
  });

  it('does not clear a parallel task activity when another task using the same agent completes', () => {
    const events = [taskEvent('agent_spawn', 'a'), taskEvent('agent_spawn', 'b'), taskEvent('agent_tool_call', 'a', { tool: 'web_research' }),
      taskEvent('agent_stage', 'b', { stage: 'verify' }), taskEvent('agent_complete', 'b', { success: true })];
    expect([...activeWorkflowGroups(events, true)]).toEqual(['research']);
  });

  it('does not merge repeated task IDs or their tools across different runs', () => {
    const events = [taskEvent('agent_spawn', 'a', {}, 'r1'), taskEvent('agent_spawn', 'a', {}, 'r2'),
      taskEvent('agent_tool_call', 'a', { tool: 'read_url' }, 'r1'), taskEvent('agent_tool_call', 'a', { tool: 'read_url' }, 'r2')];
    const participating = agentsForCurrentTask([], events);
    expect(participating).toHaveLength(2);
    expect(eventsForAgent(participating[0], events).every(event => event.runId === 'r1')).toBe(true);
    expect(groupToolEvents(participating, events)).toHaveLength(2);
  });

  it('does not create a child for the orchestrator or a policy-only candidate', () => {
    const events = [
      event('governance', 'document-agent'),
      event('agent_spawn', 'research-agent'),
      event('agent_stage', 'orchestrator', { stage: 'verify' }),
      event('agent_failed', 'orchestrator'),
    ];
    expect(agentsForCurrentTask(agents, events).map(agent => agent.id)).toEqual(['research-agent']);
  });

  it('keeps every event in long runs, including decomposition and dispatch', () => {
    const events = [...traces.slice(0, 2).map(toWorkflowEvent), ...Array.from({ length: 140 }, (_, index) =>
      event(index % 2 ? 'agent_tool_result' : 'agent_tool_call', 'research-agent', { tool: 'web_research' }, index + 2))];
    const groups = groupFlowEvents(events);
    expect(groups.flatMap(group => group.events)).toHaveLength(events.length);
    expect(groups[0].kind).toBe('task');
    expect(groups[1].kind).toBe('dispatch');
    expect(groups[2].events).toEqual(events.slice(2));
  });

  it('counts calls separately from results and does not invent missing tool ownership', () => {
    const events = [
      event('agent_tool_call', 'research-agent', { tool: 'web_research' }),
      event('agent_tool_result', 'research-agent', { tool: 'web_research', resultLength: 120 }),
      event('agent_tool_call', 'research-agent', { tool: 'web_research' }),
      event('agent_tool_result', 'research-agent', { tool: 'web_research', resultLength: 30 }),
      event('tool_result', undefined, { tool: 'read_url', resultLength: 42 }),
      event('tool_call', 'orchestrator', { tool: 'web_research' }),
    ];
    const groups = groupToolEvents(agents, events);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ agentId: 'research-agent', calls: 2, resultLength: 150 });
    expect(groups[1]).toMatchObject({ agentId: undefined, calls: 0, resultLength: 42 });
    expect(groups[2]).toMatchObject({ agentId: 'orchestrator', calls: 1 });
    expect(eventsForAgent(agents[0], events)).toHaveLength(4);
  });

  it('keeps all tools and collision-free names, including MCP tool names', () => {
    const names = ['a.b', 'a/b', '工具', 'another', 'fifth', 'sixth', 'seventh'];
    const groups = groupToolEvents(agents, names.map(tool => event('tool_call', 'research-agent', { tool })));
    expect(groups).toHaveLength(7);
    expect(new Set(groups.map(group => group.id)).size).toBe(7);
  });

  it('uses trace parents even when the child arrives first or current cards change', () => {
    const child = { id: 'child', name: '子任务', description: '', parentAgentId: 'document-agent' };
    const events = [event('agent_spawn', 'child', { parentAgentId: 'research-agent' }), event('agent_spawn', 'research-agent')];
    const participating = agentsForCurrentTask([child, ...agents], events);
    expect(parentForAgent(child, participating, events)).toBe('research-agent');
    expect(parentForAgent(child, [child], events)).toBeUndefined();
  });

  it('distinguishes the inherited resident template from the actual dispatcher and executing parent', () => {
    const events = [
      event('agent_spawn', 'first', { parentAgentId: 'document-agent', dispatchedBy: 'orchestrator' }),
      event('agent_spawn', 'second', { parentAgentId: 'first' }),
    ];
    const participating = agentsForCurrentTask(agents, events);
    const first = participating.find(agent => agent.agentId === 'first' || agent.id === 'first')!;
    const second = participating.find(agent => agent.agentId === 'second' || agent.id === 'second')!;
    expect(participating).toHaveLength(2);
    expect(parentForAgent(first, participating, events)).toBe('orchestrator');
    expect(parentForAgent(second, participating, events)).toBe(first.id);
    expect(participating.some(agent => agent.agentId === 'document-agent' || agent.id === 'document-agent')).toBe(false);
  });

  it('does not treat a tool result or a verification stage as agent completion', () => {
    const events = [event('agent_spawn', 'research-agent'), event('agent_tool_result', 'research-agent'), event('agent_stage', 'research-agent', { stage: 'verify' })];
    expect(agentRunStatus(events, true)).toBe('running');
    expect(agentRunStatus(events, false)).toBe('pending');
    expect(agentRunStatus([...events, event('agent_complete', 'research-agent', { success: false })], false)).toBe('failed');
  });

  it('corrects misleading legacy completion statuses without claiming success', () => {
    const failed = toWorkflowEvent({ type: 'complete', status: 'complete', summary: '任务完成', timestamp: 1, data: { success: false } }, 0);
    expect(failed.status).toBe('failed');
    expect(failed.summary).toContain('未通过验收');
    expect(runPresentation([failed], true)).toEqual({ active: false, label: '已结束 · 未通过验收' });
    expect(runPresentation([event('complete')], false).label).toBe('运行已结束');
    expect(runPresentation([], false).label).toBe('未记录结束状态');
    expect(runPresentation([event('complete', undefined, { success: true })], false).label).toBe('任务完成');
  });

  it('tracks parallel active categories and clears activity when the run ends', () => {
    const events = [event('task_decomposition'), event('agent_spawn', 'research-agent'), event('agent_spawn', 'document-agent'),
      event('tool_call', 'research-agent', { tool: 'web_research' }), event('agent_stage', 'document-agent', { stage: 'verify' })];
    expect([...activeWorkflowGroups(events, true)].sort()).toEqual(['governance', 'research']);
    expect(activeWorkflowGroups([...events, event('agent_complete', 'research-agent', { success: true })], true).has('research')).toBe(false);
    expect(activeWorkflowGroups([...events, event('complete', undefined, { success: false })], true).size).toBe(0);
    expect(activeWorkflowGroups(events, false).size).toBe(0);
  });

  it('shows recovered interruption and storage failure without resuming activity or labelling them cancelled', () => {
    for (const [termination, label] of [['interrupted', '服务中断 · 已恢复材料'], ['storage_failure', '保存失败 · 已停止']]) {
      const events = [event('agent_spawn', 'research-agent'), event('complete', undefined, { success: false, termination })];
      expect(runPresentation(events, true)).toEqual({ active: false, label });
      expect(activeWorkflowGroups(events, true).size).toBe(0);
    }
  });

  it('normalizes legacy zero timestamps deterministically', () => {
    const first = event('agent_spawn', 'research-agent');
    expect(first).toEqual(event('agent_spawn', 'research-agent'));
    expect(first.timestamp).toBe(0);
  });

  it('connects task dependencies using actual assignments, not role keywords or unexecuted tasks', () => {
    const events = [event('task_decomposition', undefined, { tasks: [
      { id: 't1', agentRole: 'research', dependsOn: [] },
      { id: 't2', agentRole: 'document', dependsOn: ['t1'] },
      { id: 'not-executed', agentRole: 'data', dependsOn: ['t1'] },
    ] }), event('agent_spawn', 'document-agent', { taskId: 't2' }), event('agent_spawn', 'research-agent', { taskId: 't1' })];
    expect(taskDependencyEdges(agents, events)).toEqual([{ source: 'research-agent', target: 'document-agent' }]);
    expect(taskDependencyEdges(agents, [events[0], events[1]])).toEqual([]);
  });
});
