import { describe, expect, it } from 'vitest';
import { AgentPool } from '../agent-pool.js';
import { BENCHMARK_DIMENSIONS, estimateAgentBenchmarkProfile, fingerprintAgentConfiguration, getBenchmarkSuites, profileFromBenchmarkRun, runAgentBenchmark } from '../benchmark.js';
import type { AgentRunEvidenceInput } from '../benchmark-evidence.js';
import type { WorkflowEvent } from '../protocol.js';

const agent = () => structuredClone(new AgentPool().getAgent('research-agent')!);
function input(): AgentRunEvidenceInput {
  const card = agent();
  const event = (type: string, data: Record<string, unknown> = {}): WorkflowEvent => ({
    type, eventId: `event-${type}`, sessionId: 'session-1', runId: 'run-1', taskId: 'task-1', agentId: card.id,
    summary: '来源日期 URL 可验证性 https://example.com 2026-09-13', timestamp: 1, data,
  });
  const spawn = event('agent_spawn', { objective: 'Compare the supplied notes' });
  spawn.agentSnapshot = { ...card, version: 1, capturedAt: 1, role: 'research', card: card.card };
  const call = event('agent_tool_call', { tool: 'web_research' }); call.toolName = 'web_research';
  return {
    source: { workspaceId: 'workspace-1', sessionId: 'session-1', runId: 'run-1', completedAt: '2026-09-13T00:00:00Z', title: '来源任务' },
    events: [spawn, call, event('agent_tool_result', { tool: 'web_research', resultLength: 100 }),
      event('agent_complete', { success: true, outputSummary: '已保存的交接摘要' }), event('complete', { success: true })],
  };
}

describe('configuration scores and recorded run evidence', () => {
  it('never labels configuration as measured, and generates collision-resistant IDs', () => {
    const card = agent(), first = runAgentBenchmark(card), second = runAgentBenchmark(card);
    expect(first.runId).not.toBe(second.runId);
    expect(profileFromBenchmarkRun(first).source).toBe('estimated');
    expect(first.mode).toBe('static_capability'); expect(first.evidenceReview).toBeUndefined();
    expect(first.totalScore).toBe(estimateAgentBenchmarkProfile(card).totalScore);
  });
  it('keeps observations separate from points and does not interpret keywords as verified facts', () => {
    const card = agent(), run = runAgentBenchmark(card, undefined, input());
    expect(run.mode).toBe('trace_aware'); expect(run.totalScore).toBe(runAgentBenchmark(card).totalScore);
    expect(profileFromBenchmarkRun(run).source).toBe('estimated');
    expect(run.evidenceReview?.checks.find(check => check.id === 'tool-requests')).toMatchObject({ status: 'passed', eventIds: ['event-agent_tool_call'] });
    expect(run.evidenceReview?.checks.find(check => check.id === 'source-quality')?.status).toBe('unobserved');
    expect(run.evidenceReview?.checks.find(check => check.id === 'deliverable-quality')?.status).toBe('unobserved');
  });
  it('isolates other agents and uses captured permissions instead of the current card', () => {
    const history = input(), card = agent(); history.events[1]!.agentId = 'document-agent';
    expect(runAgentBenchmark(card, undefined, history).evidenceReview?.checks.find(check => check.id === 'tool-requests')?.status).toBe('unobserved');
    history.events[1]!.agentId = card.id; history.events[0]!.agentSnapshot!.constraints = { ...card.constraints, allowedTools: [] };
    expect(runAgentBenchmark(card, undefined, history).evidenceReview?.checks.find(check => check.id === 'tool-policy')?.status).toBe('failed');
  });
  it.each(['run', 'agent', 'duplicate', 'unfinished'])('rejects mismatched or incomplete %s evidence', variant => {
    const history = input();
    if (variant === 'run') history.events[1]!.runId = 'another-run';
    if (variant === 'agent') history.events[0]!.agentSnapshot = undefined;
    if (variant === 'duplicate') history.events.push(history.events[1]!);
    if (variant === 'unfinished') history.events.pop();
    expect(() => runAgentBenchmark(agent(), undefined, history)).toThrow();
  });
  it('reports agent failures even if the outer task has a successful terminal', () => {
    const history = input(); history.events[3]!.data!.success = false;
    expect(runAgentBenchmark(agent(), undefined, history).evidenceReview?.checks.find(check => check.id === 'task-outcome')?.status).toBe('failed');
  });
  it('does not grant tool permissions from either declaration alone', () => {
    const card = agent(), before = runAgentBenchmark(card); card.constraints.allowedTools = [];
    const after = runAgentBenchmark(card); expect(after.totalScore).toBeLessThan(before.totalScore);
    expect(after.results.find(result => result.taskId === 'research-freshness-001')?.missingCapabilities).toContain('web_research');
  });
  it('gives no fixed base points to an empty configuration', () => {
    const card = agent(); card.capabilities = { skills: [], tools: [], mcpServers: [] };
    Object.assign(card.card, { soul: '', responsibilities: [], boundaries: [], qualityChecks: [], outputStandards: [], fallbackStrategy: '', exampleTasks: [] });
    expect(runAgentBenchmark(card).results.find(result => result.taskId === 'universal-brief-001')?.score).toBeLessThan(30);
  });
  it('retains role-specific checks for a copied template', () => {
    const original = agent(), copied = agent(); copied.id = 'custom-research';
    expect(runAgentBenchmark(copied).results.map(result => result.taskId)).toEqual(runAgentBenchmark(original).results.map(result => result.taskId));
    expect(runAgentBenchmark(copied).totalScore).toBe(runAgentBenchmark(original).totalScore);
  });
  it('fingerprints config changes but ignores live stats and self-reported scores', () => {
    const card = agent(), digest = fingerprintAgentConfiguration(card); card.stats.totalCost++; card.card.scoreProfile.research = 1;
    expect(fingerprintAgentConfiguration(card)).toBe(digest); card.card.soul += ' updated';
    expect(fingerprintAgentConfiguration(card)).not.toBe(digest);
  });
  it('does not let repeated handoffs fill in another missing task', () => {
    const history = input();
    history.events.splice(1, 0, { ...structuredClone(history.events[0]!), eventId: 'second-spawn', taskId: 'task-2' });
    history.events.splice(-1, 0, { ...structuredClone(history.events[4]!), eventId: 'duplicate-completion' });
    const review = runAgentBenchmark(agent(), undefined, history).evidenceReview!;
    expect(review.checks.find(check => check.id === 'task-outcome')?.status).toBe('failed');
    expect(review.checks.find(check => check.id === 'handoff-record')?.status).toBe('unobserved');
  });
  it('rejects duplicate task snapshots even with different event IDs', () => {
    const history = input(); history.events.push({ ...history.events[0]!, eventId: 'duplicate-spawn' });
    expect(() => runAgentBenchmark(agent(), undefined, history)).toThrow(/重复/);
  });
  it('applies task dimension weights instead of averaging equally', () => {
    const suite = structuredClone(getBenchmarkSuites()[0]!);
    suite.tasks = [
      { id: 'present', title: 'Present', description: '', type: 'rubric', dimensions: { tool_use: 0.9 } },
      { id: 'missing', title: 'Missing', description: '', type: 'tool_trace', dimensions: { tool_use: 0.1 }, requiredTools: ['nonexistent'] },
    ];
    const run = runAgentBenchmark(agent(), suite);
    expect(run.dimensionScores.tool_use).toBe(Math.round(run.results[0]!.score * 0.9 + run.results[1]!.score * 0.1));
  });
  it('normalizes role weights so complete coverage can reach 100 for every role', () => {
    const suite = structuredClone(getBenchmarkSuites()[0]!);
    suite.tasks = [{ id: 'all', title: 'All', description: '', type: 'rubric',
      dimensions: Object.fromEntries(BENCHMARK_DIMENSIONS.map(dimension => [dimension.id, 1 / 7])) }];
    for (const card of new AgentPool().getResidentAgents()) expect(runAgentBenchmark(card, suite).totalScore).toBe(100);
  });
});
