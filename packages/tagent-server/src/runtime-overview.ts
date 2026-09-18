import type { RuntimeOverview, AgentCard } from '@tagent/core';
import type { WorkflowCatalog } from './workflow-catalog.js';

const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** Read the same committed/live events as the workflow, without creating a second accounting ledger. */
export function runtimeOverview(catalog: WorkflowCatalog, residents: AgentCard[], now = Date.now()): RuntimeOverview {
  const overview: RuntimeOverview = { recordedRuns: 0, finishedRuns: 0, failedRuns: 0, unknownOutcomes: 0,
    activeRuns: 0, knownCost: 0, runsWithoutCost: 0, totalTokens: { input: 0, output: 0 }, agents: [], tools: [], costTrend: [],
    note: '基于当前保留的任务记录；费用只含已知模型回执，不含未知用量或搜索账单。长时间无事件不等于服务离线。' };
  const agents = new Map<string, RuntimeOverview['agents'][number]>(residents.map(agent => [agent.id, {
    id: agent.id, name: agent.name, status: 'not_used', activeRuns: 0, completed: 0, failed: 0, unknown: 0,
  }]));
  const tools = new Map<string, { name: string; calls: number; results: number; duration: number; paired: number }>();
  const days = new Map<string, RuntimeOverview['costTrend'][number]>();
  for (const run of catalog.list()) {
    if (run.traces.some(event => event.type === 'complete' && event.data?.mode === 'research_smoke')) continue;
    overview.recordedRuns++;
    const terminal = [...run.traces].reverse().find(event => event.type === 'complete');
    const active = !run.persisted;
    if (active) overview.activeRuns++;
    else {
      overview.finishedRuns++;
      if (terminal?.data?.success === false || run.message.run?.status === 'interrupted') overview.failedRuns++;
      else if (terminal?.data?.success !== true) overview.unknownOutcomes++;
      if (typeof run.cost === 'number' && Number.isFinite(run.cost)) overview.knownCost += amount(run.cost);
      else overview.runsWithoutCost++;
      overview.totalTokens.input += amount(run.message.tokens?.input);
      overview.totalTokens.output += amount(run.message.tokens?.output);
      const date = Number.isFinite(Date.parse(run.message.timestamp))
        ? new Date(run.message.timestamp).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '日期未记录';
      const day = days.get(date) || { date, cost: 0, runs: 0 };
      day.cost += amount(run.cost); day.runs++; days.set(date, day);
    }
    const involved = new Map<string, typeof run.traces>();
    const starts = new Map<string, number[]>();
    for (const event of run.traces) {
      const id = event.agentId || (typeof event.data?.agentId === 'string' ? event.data.agentId : undefined);
      if (id) {
        if (!agents.has(id)) agents.set(id, { id, name: event.agentSnapshot?.name || id, status: 'not_used', activeRuns: 0, completed: 0, failed: 0, unknown: 0 });
        const list = involved.get(id) || []; list.push(event); involved.set(id, list);
      }
      const name = event.toolName || (typeof event.data?.tool === 'string' ? event.data.tool : undefined);
      if (!name || !['agent_tool_call', 'agent_tool_result'].includes(event.type)) continue;
      const tool = tools.get(name) || { name, calls: 0, results: 0, duration: 0, paired: 0 };
      const key = JSON.stringify([id, event.taskId || event.data?.taskId, name]), queue = starts.get(key) || [];
      if (event.type === 'agent_tool_call') { tool.calls++; queue.push(event.timestamp); }
      else {
        tool.results++;
        const start = queue.shift();
        if (start !== undefined && event.timestamp >= start) { tool.paired++; tool.duration += event.timestamp - start; }
      }
      starts.set(key, queue); tools.set(name, tool);
    }
    for (const [id, events] of involved) {
      const agent = agents.get(id)!;
      const last = events.reduce((latest, event) => Math.max(latest, event.timestamp), 0);
      agent.lastEventAt = Math.max(agent.lastEventAt || 0, last);
      const tasks = new Map<string, boolean>();
      const outcomes = new Map<string, (typeof events)[number]>();
      for (const event of events) {
        const task = event.taskId || String(event.data?.taskId || 'main');
        if (event.type === 'agent_complete' || event.type === 'agent_failed') {
          tasks.set(task, true); outcomes.set(task, event);
        } else if (event.type === 'agent_spawn') {
          tasks.set(task, false); outcomes.delete(task);
        } else if (!tasks.has(task)) tasks.set(task, false);
      }
      const completed = [...outcomes.values()];
      for (const event of completed) {
        if (event.type === 'agent_failed' || event.data?.success === false) agent.failed++;
        else if (event.data?.success === true) agent.completed++;
        else agent.unknown++;
      }
      if (active && [...tasks.values()].some(complete => !complete)) {
        agent.activeRuns++;
        const approval = [...events].reverse().find(event => event.type === 'governance' && event.data?.approval);
        const waiting = (approval?.data?.approval as { status?: string } | undefined)?.status === 'pending';
        const status = waiting ? 'waiting' : now - last > 120000 ? 'stalled' : 'running';
        if (agent.status !== 'running' || status === 'running') agent.status = status;
      } else {
        if (agent.activeRuns === 0) agent.status = 'idle';
        if (!completed.length) agent.unknown++;
      }
    }
  }
  overview.agents = [...agents.values()];
  overview.tools = [...tools.values()].map(tool => ({ name: tool.name, calls: tool.calls, results: tool.results,
    ...(tool.paired ? { averageMs: Math.round(tool.duration / tool.paired) } : {}) }));
  overview.costTrend = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
  return overview;
}
