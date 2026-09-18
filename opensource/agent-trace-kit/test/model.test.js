import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTrace } from '../src/index.js';
import { event } from './helpers.js';

test('only observed execution agents appear; governance mentions are not phantom nodes', () => {
  const result = summarizeTrace([event('a', 'agent_spawn'), event('b', 'governance', { agentId: 'never-ran', data: { result: 'passed' } })]);
  assert.deepEqual(result.runs[0].agents.map(agent => agent.agentId), ['agent-1']);
  assert.equal(result.runs[0].governance[0].result, 'passed');
  assert.equal(result.runs[0].outcome.status, 'incomplete');
});

test('stages, graph and ordering are deterministic across input permutations', () => {
  const data = [event('a', 'agent_spawn', { timestamp: 1, taskId: 'parent' }),
    event('b', 'agent_spawn', { timestamp: 2, agentId: 'child', parentAgentId: 'agent-1', parentTaskId: 'parent' }),
    event('c', 'agent_stage', { timestamp: 3, agentId: 'child', data: { stage: 'verify' } }),
    event('d', 'synthesis_start', { timestamp: 4, agentId: 'orchestrator' }),
    event('e', 'complete', { timestamp: 5, data: { success: true } })];
  const report = summarizeTrace(data);
  assert.deepEqual(report, summarizeTrace([...data].reverse()));
  assert.deepEqual(report.runs[0].stages.map(group => group.stage), ['dispatch', 'verify', 'synthesize', 'complete']);
  const parents = report.runs[0].edges.filter(edge => edge.kind === 'parent');
  assert.equal(parents.length, 1); assert.equal(report.runs[0].outcome.status, 'succeeded');
  assert.equal(report.runs[0].agents.find(agent => agent.agentId === 'child').parent.parentTaskId, 'parent');
});

test('agent task instances stay separate; missing task identity is not attached to a random instance', () => {
  const unscoped = event('u', 'agent_progress'); delete unscoped.taskId;
  const result = summarizeTrace([event('a', 'agent_spawn', { taskId: 'one' }), event('b', 'agent_spawn', { taskId: 'two' }), unscoped]);
  assert.equal(result.runs[0].agents.length, 3);
  assert.deepEqual(result.runs[0].agents.find(agent => agent.taskId === null).eventIds, ['u']);
});

test('ambiguous parent agent and absent cross-run parent never generate guessed relationships', () => {
  const report = summarizeTrace([event('a', 'agent_spawn', { taskId: 'one' }), event('b', 'agent_spawn', { taskId: 'two' }),
    event('c', 'agent_spawn', { agentId: 'child', parentAgentId: 'agent-1' }),
    event('d', 'agent_spawn', { runId: 'other', agentId: 'another-child', parentAgentId: 'agent-1' })]);
  assert.equal(report.runs.flatMap(run => run.edges.filter(edge => edge.kind === 'parent')).length, 0);
  assert.equal(report.issues.some(item => item.code === 'ambiguous_parent'), true);
  assert.equal(report.issues.some(item => item.code === 'missing_parent'), true);
});

test('conflicting parents, self references and cycles are disclosed and excluded', () => {
  const report = summarizeTrace([event('a', 'agent_spawn', { agentId: 'a', parentAgentId: 'b' }),
    event('b', 'agent_spawn', { agentId: 'b', parentAgentId: 'a' }),
    event('c', 'agent_spawn', { agentId: 'c', parentAgentId: 'c' }),
    event('d', 'agent_spawn', { agentId: 'd', parentAgentId: 'a' }),
    event('e', 'agent_progress', { agentId: 'd', parentAgentId: 'b' })]);
  assert.equal(report.runs[0].edges.filter(edge => edge.kind === 'parent').length, 0);
  assert.equal(report.issues.filter(item => item.code === 'parent_cycle').length, 3);
  assert.equal(report.issues.some(item => item.code === 'conflicting_parent'), true);
});

test('unknown completion and interrupted traces never become successful by convention', () => {
  for (const [type, data, status] of [['complete', {}, 'unknown'], ['complete', { success: false }, 'failed'],
    ['run_interrupted', {}, 'interrupted'], ['future_complete', { success: true }, 'incomplete'], ['error', {}, 'incomplete']]) {
    const result = summarizeTrace([event('end', type, { status: 'complete', data })]);
    assert.equal(result.runs[0].outcome.status, status);
  }
  const contradictory = summarizeTrace([event('end', 'complete', { status: 'failed', data: { success: true } })]);
  assert.equal(contradictory.runs[0].outcome.status, 'failed');
});

test('incomparable terminal claims stay unknown rather than choosing array order', () => {
  const result = summarizeTrace([event('ok', 'complete', { timestamp: 1, data: { success: true } }),
    event('missing-time', 'complete', { timestamp: null, data: { success: false } })]);
  assert.equal(result.runs[0].outcome.status, 'unknown');
  assert.equal(result.issues.some(item => item.code === 'ambiguous_terminal'), true);
});

test('agent costs are not added to run totals and missing usage is not zero', () => {
  const data = [event('agent', 'agent_complete', { cost: 0.02, data: { success: true } }),
    event('run', 'complete', { timestamp: 2, data: { success: true, totalCost: 0.02 } })];
  assert.equal(summarizeTrace(data).runs[0].recordedRunCost, 0.02);
  assert.equal(summarizeTrace(data.slice(0, 1)).runs[0].recordedRunCost, null);
});

test('post-completion governance does not turn an agent back into running', () => {
  const result = summarizeTrace([event('a', 'agent_complete', { timestamp: 1, data: { success: true } }),
    event('b', 'governance', { timestamp: 2, data: { result: 'warning' } })]);
  assert.equal(result.runs[0].agents[0].outcome.status, 'succeeded');
});

test('a large parent chain is iterative rather than recursive', () => {
  const data = Array.from({ length: 3000 }, (_, i) => event(`e-${i}`, 'agent_spawn', {
    agentId: `a-${i}`, taskId: `t-${i}`, ...(i ? { parentAgentId: `a-${i - 1}`, parentTaskId: `t-${i - 1}` } : {}) }));
  const result = summarizeTrace(data);
  assert.equal(result.runs[0].agents.length, 3000);
  assert.equal(result.runs[0].edges.filter(edge => edge.kind === 'parent').length, 2999);
});
