import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { FilePersistence, type WorkflowEvent } from '@tagent/core';
import { GovernanceStore } from '../governance-store.js';
import { Store } from '../store.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const rel = relative(tmpdir(), root);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Unsafe cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tagent-governance-')); roots.push(root);
  const persistence = new FilePersistence(root), store = await Store.open(persistence);
  const workspaceId = store.listWorkspaces()[0].id, sessionId = (await store.createSession(workspaceId))!.id, runId = 'run-governance';
  await store.beginRun(workspaceId, sessionId, runId, '治理记录：中文 / emoji 🚀');
  const traces: WorkflowEvent[] = [];
  const governance = new GovernanceStore(store, () => [{ workspaceId, sessionId, runId, traces }]);
  const event = (id: string, timestamp: number, data: Record<string, unknown> = {}): WorkflowEvent => ({
    eventId: id, sessionId, runId, taskId: 't-one', agentId: 'document-agent', type: 'governance', timestamp,
    summary: '工具执行确认', data: { policyType: 'approval', ruleName: 'tool_approval', result: 'warning', message: '等待用户确认 🚀', ...data },
  });
  const finish = async () => {
    const message = store.findRun(runId)!.message;
    await store.finishRun(workspaceId, sessionId, runId, { ...message, content: '已返回最终结果', cost: .125,
      traces: traces.map(trace => ({ ...trace, data: trace.data || {} })), run: { ...message.run!, status: 'finished' } });
  };
  return { persistence, store, workspaceId, sessionId, runId, traces, governance, event, finish };
}
describe('canonical governance history', () => {
  it('projects live events once, then restores the identical UTF-8 records and real cost after restart', async () => {
    const s = await fixture();
    s.traces.push(s.event('event-pending', 100), s.event('event-decision', 200, { result: 'passed' }));
    s.traces.push(s.traces[0]);
    expect(s.governance.query().events).toHaveLength(2);
    expect(s.governance.query().events.every(event => !event.persisted)).toBe(true);
    expect(s.governance.query().stats.costTimeline).toEqual([]);
    await s.finish();
    const saved = s.governance.query();
    expect(saved.events.every(event => event.persisted)).toBe(true);
    expect(saved.stats.costTimeline).toEqual([{ runId: s.runId, cost: .125, timestamp: Date.parse(s.store.findRun(s.runId)!.message.timestamp) }]);
    s.traces.push(s.event('late-live-must-not-replace-saved', 300));
    const reopened = new GovernanceStore(await Store.open(s.persistence), () => []);
    expect(reopened.query()).toEqual(saved);
    expect(s.governance.query()).toEqual(saved);
  });
  it('uses stable cursors, filters scopes and does not invent per-Agent costs', async () => {
    const s = await fixture();
    s.traces.push(s.event('a', 100), s.event('b', 100), s.event('c', 200, { result: 'blocked' }));
    const first = s.governance.query({ limit: 2 });
    expect(first.events.map(e => e.id)).toEqual(['c', 'b']);
    s.traces.push(s.event('newer', 300));
    const second = s.governance.query({ limit: 2, before: first.nextCursor! });
    expect(second.events.map(e => e.id)).toEqual(['a']);
    expect(second.nextCursor).toBeNull(); expect(second.stats.totalChecks).toBe(4);
    expect(s.governance.query({ sessionId: 'other' }).events).toEqual([]);
    expect(s.governance.query({ runId: 'run-other' }).events).toEqual([]);
    expect(s.governance.query({ agentId: 'research-agent' }).events).toEqual([]);
    await s.finish();
    expect(s.governance.query({ agentId: 'document-agent' }).stats.costTimeline).toEqual([]);
    expect(() => s.governance.query({ before: 'bad-cursor' })).toThrow('Invalid governance cursor');
  });
  it('ignores wrong run/session events and handles arbitrary policy labels safely', async () => {
    const s = await fixture();
    s.traces.push({ ...s.event('foreign', 10), runId: 'another' }, { ...s.event('foreign2', 20), sessionId: 'another' },
      s.event('constructor', 30, { policyType: 'constructor' }), s.event('proto', 40, { policyType: '__proto__' }));
    const result = s.governance.query(); expect(result.events).toHaveLength(2);
    expect(result.stats.byPolicyType.constructor).toEqual({ checks: 1, blocked: 0 });
    expect(result.stats.byPolicyType.__proto__).toEqual({ checks: 1, blocked: 0 });
    expect(result.events.every(event => event.message.includes('🚀'))).toBe(true);
  });
  it('does not count forked copies as new decisions or billed tasks; deletion removes the derived history', async () => {
    const s = await fixture(); s.traces.push(s.event('original', 100)); await s.finish();
    await s.store.forkSession(s.workspaceId, s.sessionId, 'fork_full');
    expect(s.governance.query().events).toHaveLength(1); expect(s.governance.query().stats.costTimeline).toHaveLength(1);
    await s.store.deleteSession(s.workspaceId, s.sessionId);
    expect(new GovernanceStore(await Store.open(s.persistence), () => []).query().events).toEqual([]);
  });
  it('reads old canonical traces without run receipts, excludes forks and never treats unknown verdicts as passed', async () => {
    const s = await fixture(), legacy = (await s.store.createSession(s.workspaceId))!;
    await s.store.addMessage(s.workspaceId, legacy.id, { id: 'legacy-answer', role: 'assistant', content: '旧版治理报告', cost: .08,
      timestamp: '2026-06-14T00:00:00.000Z', traces: [{ ...s.event('old-record', 100, { result: 'unknown' }), runId: 'run-old', sessionId: legacy.id, data: { result: 'unknown' } }] });
    await s.store.forkSession(s.workspaceId, legacy.id, 'fork_full');
    const result = new GovernanceStore(await Store.open(s.persistence), () => []).query();
    expect(result.events).toHaveLength(1); expect(result.events[0].sessionId).toBe(legacy.id); expect(result.events[0].persisted).toBe(true);
    expect(result.stats.totalChecks).toBe(1); expect(result.stats.totalPassed).toBe(0);
    expect(result.stats.costTimeline).toEqual([{ runId: 'run-old', cost: .08, timestamp: Date.parse('2026-06-14T00:00:00.000Z') }]);
  });
});
