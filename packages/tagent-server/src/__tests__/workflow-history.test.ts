import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { FilePersistence, type WorkflowEvent } from '@tagent/core';
import { Store } from '../store.js';
import { WorkflowCatalog, type WorkflowSource } from '../workflow-catalog.js';
import { WorkflowIndex, WorkflowIndexRecorder, removeWorkflowIndexes } from '../workflow-index.js';
import { createWorkflowHistoryRoutes } from '../workflow-history.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const rel = relative(tmpdir(), root);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Unsafe cleanup');
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture(count = 85) {
  const root = await fs.mkdtemp(join(tmpdir(), 'tagent-trace-')); roots.push(root);
  const persistence = new FilePersistence(root), store = await Store.open(persistence);
  const workspaceId = store.listWorkspaces()[0].id, sessionId = (await store.createSession(workspaceId))!.id, runId = 'run-trace';
  await store.beginRun(workspaceId, sessionId, runId, '中文 / emoji 🚀 / symbols <>&');
  const event = (i: number): WorkflowEvent => ({ eventId: `e-${i}`, runId, sessionId, timestamp: 1000 + i,
    agentId: i % 2 ? 'research-agent' : 'document-agent', type: i % 3 ? 'agent_tool_result' : 'governance',
    summary: `中文执行记录 ${i} 🚀`, data: { tool: 'web_research', detail: `多行\nUTF-8 ${i}` } });
  const traces = Array.from({ length: count }, (_, i) => event(i));
  const catalog = new WorkflowCatalog(store, () => [{ workspaceId, sessionId, runId, traces }]);
  const index = new WorkflowIndex(root), app = createWorkflowHistoryRoutes(store, catalog, index);
  const source = () => catalog.find(workspaceId, sessionId, runId)!;
  const finish = async () => {
    const message = store.findRun(runId)!.message;
    await store.finishRun(workspaceId, sessionId, runId, { ...message, content: '最终报告 🚀',
      traces: traces.map(e => ({ ...e, data: e.data || {} })), run: { ...message.run!, status: 'finished' } });
  };
  const dir = join(root, '.tagent', 'workflow-index');
  const files = async () => (await fs.readdir(dir)).map(name => join(dir, name));
  return { root, persistence, store, workspaceId, sessionId, runId, event, traces, source, finish, index, app, catalog, dir, files,
    url: `/workspaces/${workspaceId}/sessions/${sessionId}/traces/${runId}` };
}

describe('canonical JSONL trace index', () => {
  it('preserves UTF-8 and uses byte offsets to paginate without duplicates after restart', async () => {
    const s = await fixture(); await s.finish();
    const page1 = await s.index.query(s.source());
    expect(page1.events).toEqual(s.traces.slice(0, 40)); expect(page1.total).toBe(85); expect(page1.persisted).toBe(true);
    const reopened = new WorkflowIndex(s.root), catalog = new WorkflowCatalog(await Store.open(s.persistence));
    const source = catalog.find(s.workspaceId, s.sessionId, s.runId)!;
    const page2 = await reopened.query(source, { cursor: page1.nextCursor! });
    const page3 = await reopened.query(source, { cursor: page2.nextCursor! });
    expect([...page1.events, ...page2.events, ...page3.events]).toEqual(s.traces); expect(page3.nextCursor).toBeNull();
    const file = (await s.files()).find(file => file.endsWith('.jsonl'))!;
    expect((await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual(s.traces);
  });
  it('filters by Agent and type, and pins pagination to its initial upper bound while a run grows', async () => {
    const s = await fixture();
    const first = await s.index.query(s.source(), { agentId: 'research-agent', type: 'governance', limit: 2 });
    const original = s.traces.filter(e => e.agentId === 'research-agent' && e.type === 'governance');
    s.traces.push(s.event(99)); await s.index.append(s.source(), s.event(99));
    const all = [...first.events]; let cursor = first.nextCursor;
    while (cursor) {
      const next = await s.index.query(s.source(), { agentId: 'research-agent', type: 'governance', cursor, limit: 2 });
      expect(next.total).toBe(original.length); expect(next.available).toBe(86); all.push(...next.events); cursor = next.nextCursor;
    }
    expect(all).toEqual(original);
    expect((await s.index.query(s.source(), { agentId: 'research-agent', type: 'governance' })).total).toBe(original.length + 1);
    await expect(s.index.query(s.source(), { cursor: first.nextCursor!, agentId: 'document-agent' })).rejects.toMatchObject({ status: 400 });
    await expect(s.index.query(s.source(), { cursor: 'bad' })).rejects.toMatchObject({ status: 400 });
  });
  it('appends only new event bytes, rejects conflicting IDs and repairs a partial uncommitted tail', async () => {
    const s = await fixture(1); await s.index.append(s.source(), s.traces[0]);
    const file = (await s.files()).find(file => file.endsWith('.jsonl'))!, prefix = await fs.readFile(file);
    await s.index.append(s.source(), s.traces[0]); expect(await fs.readFile(file)).toEqual(prefix);
    await expect(s.index.append(s.source(), { ...s.traces[0], summary: 'changed' })).rejects.toMatchObject({ status: 409 });
    await fs.appendFile(file, '{"partial":');
    const reopened = new WorkflowIndex(s.root);
    s.traces.push(s.event(1)); await reopened.append(s.source(), s.traces[1]);
    const data = await fs.readFile(file); expect(data.subarray(0, prefix.length)).toEqual(prefix);
    expect((await reopened.query(s.source())).events).toEqual(s.traces);
  });
  it.each(['metadata', 'missing-data'])('rebuilds a damaged %s index from saved events without editing the source', async damage => {
    const s = await fixture(); await s.finish(); const first = await s.index.query(s.source());
    const before = await fs.readFile(join(s.root, '.tagent', 'data', 'workspaces.json'));
    const files = await s.files();
    if (damage === 'metadata') await fs.writeFile(files.find(file => file.endsWith('.index.json'))!, '{bad');
    else await fs.rm(files.find(file => file.endsWith('.jsonl'))!);
    const reopened = new WorkflowIndex(s.root), repaired = await reopened.query(s.source());
    expect(repaired.events).toEqual(s.traces.slice(0, 40)); expect(repaired.rebuilt).toBe(true);
    await expect(reopened.query(s.source(), { cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(join(s.root, '.tagent', 'data', 'workspaces.json'))).toEqual(before);
    expect((await s.files()).filter(file => file.endsWith('.jsonl'))).toHaveLength(1);
  });
  it('detects changed event bytes, then explicitly refreshes from the source', async () => {
    const s = await fixture(2); await s.finish(); await s.index.query(s.source());
    const file = (await s.files()).find(file => file.endsWith('.jsonl'))!, bytes = await fs.readFile(file);
    bytes[10] ^= 1; await fs.writeFile(file, bytes);
    await expect(s.index.query(s.source())).rejects.toMatchObject({ status: 503 });
    const repaired = await s.index.query(s.source()); expect(repaired.rebuilt).toBe(true); expect(repaired.events).toEqual(s.traces);
  });
  it('rejects conflicting source events and wrong session ownership', async () => {
    const s = await fixture(1);
    await expect(s.index.query({ ...s.source(), traces: [{ ...s.traces[0], sessionId: 'foreign' }] })).rejects.toMatchObject({ status: 409 });
    await expect(s.index.query({ ...s.source(), traces: [...s.traces, { ...s.traces[0], summary: 'conflict' }] })).rejects.toMatchObject({ status: 409 });
    const page = await s.index.query({ ...s.source(), traces: [...s.traces, s.traces[0]] }); expect(page.events).toHaveLength(1);
  });
  it('does not replace an unsaved longer index with a running placeholder', async () => {
    const s = await fixture(2); await s.index.append(s.source(), s.traces[0]); await s.index.append(s.source(), s.traces[1]);
    await expect(s.index.query({ ...s.source(), traces: [] })).rejects.toMatchObject({ status: 503 });
    expect((await s.index.query(s.source())).events).toEqual(s.traces);
  });
  it('reconciles live terminal corrections even when the event array length is unchanged', async () => {
    const s = await fixture(2); const first = await s.index.query(s.source());
    s.traces[1].summary = '最终保存失败，需要核对原始记录'; s.traces[1].status = 'failed';
    const corrected = await s.index.query(s.source());
    expect(corrected.rebuilt).toBe(true); expect(corrected.events[1].summary).not.toBe(first.events[1].summary);
    expect(corrected.events[1].status).toBe('failed');
  });
  it('caps invalid queries and event sizes without overwriting original messages', async () => {
    const s = await fixture(1);
    for (const limit of [0, 101, NaN, 1.1]) await expect(s.index.query(s.source(), { limit })).rejects.toMatchObject({ status: 400 });
    await expect(s.index.query(s.source(), { cursor: 'x'.repeat(1025) })).rejects.toMatchObject({ status: 400 });
    await expect(s.index.append(s.source(), { ...s.event(1), summary: 'x'.repeat(512 * 1024) })).rejects.toMatchObject({ status: 413 });
    expect(s.store.findRun(s.runId)!.message.traces).toBeUndefined();
  });
  it('allows concurrent different-run index creation without mkdir races', async () => {
    const s = await fixture(2);
    const others: WorkflowSource[] = [s.source(), { ...s.source(), runId: 'run-other', traces: s.traces.map(e => ({ ...e, runId: 'run-other' })) }];
    const results = await Promise.all(others.map(source => s.index.query(source)));
    expect(results.map(page => page.events.length)).toEqual([2, 2]);
    await s.index.remove(others[0]); expect((await s.index.query(others[1])).events).toEqual(others[1].traces);
  });
  it('fails closed on a linked index directory and never writes through it', async () => {
    const s = await fixture(1), outside = await fs.mkdtemp(join(tmpdir(), 'tagent-trace-link-')); roots.push(outside);
    await fs.symlink(outside, s.dir, 'junction');
    await expect(s.index.query(s.source())).rejects.toMatchObject({ status: 503 });
    expect(await fs.readdir(outside)).toEqual([]);
    await fs.unlink(s.dir);
    expect((await s.index.query(s.source())).events).toEqual(s.traces);
  });
  it('pauses background writes at a bounded backlog, with on-demand backfill preserving every event', async () => {
    const s = await fixture(90), warning = vi.fn(), recorder = new WorkflowIndexRecorder(s.index, s.source(), warning);
    for (const event of s.traces) recorder.record(event);
    await recorder.flush(); expect(warning).toHaveBeenCalledTimes(1);
    expect((await s.index.query(s.source(), { limit: 100 })).events).toEqual(s.traces);
  }, 30000);
  it('contains background failures and keeps the authoritative task readable', async () => {
    const s = await fixture(2); await fs.mkdir(s.dir); const warning = vi.fn();
    vi.spyOn(s.index, 'append').mockRejectedValueOnce(new Error('Disk IO failure'));
    const recorder = new WorkflowIndexRecorder(s.index, s.source(), warning); recorder.record(s.traces[0]);
    await recorder.flush(); expect(warning).toHaveBeenCalledOnce();
    expect((await s.index.query(s.source())).events).toEqual(s.traces);
  });
});

describe('trace scope API and shared catalog', () => {
  it('does not create files for unknown IDs, encoded paths, or cross-workspace runs', async () => {
    const s = await fixture(1);
    for (const url of ['/trace/%2e%2e%2fprivate', s.url.replace(s.workspaceId, 'other'), s.url.replace(s.runId, 'run-other'), '/trace/unknown']) {
      expect((await s.app.request(url)).status).toBe(404);
    }
    await expect(fs.stat(s.dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('supports canonical and legacy APIs with explicit run selection', async () => {
    const s = await fixture(3); await s.finish();
    const page = await (await s.app.request(s.url + '?limit=2')).json(); expect(page.events).toEqual(s.traces.slice(0, 2));
    expect((await s.app.request(s.url + '?limit=bad')).status).toBe(400);
    const legacy = await (await s.app.request(`/trace/${s.sessionId}?runId=${s.runId}`)).json(); expect(legacy.entries).toEqual(s.traces);
    const list = await (await s.app.request(s.url.slice(0, s.url.lastIndexOf('/')))).json(); expect(list.runs).toHaveLength(1);
    await s.store.beginRun(s.workspaceId, s.sessionId, 'run-second', 'another question');
    expect((await s.app.request(`/trace/${s.sessionId}`)).status).toBe(400);
  });
  it('caches only committed workspace versions, preserves legacy history and excludes fork copies', async () => {
    const s = await fixture(3); await s.finish(); const scan = vi.spyOn(s.store, 'listWorkspaces');
    s.catalog.list(); s.catalog.list(); s.catalog.find(s.workspaceId, s.sessionId, s.runId); expect(scan).toHaveBeenCalledTimes(1);
    await s.store.forkSession(s.workspaceId, s.sessionId, 'fork_full');
    expect(s.catalog.list()).toHaveLength(1); expect(scan).toHaveBeenCalledTimes(2);
    const previous = s.catalog.list(); vi.spyOn(s.persistence, 'save').mockRejectedValueOnce(new Error('Write failed'));
    await expect(s.store.createSession(s.workspaceId)).rejects.toThrow('Write failed'); expect(s.catalog.list()).toEqual(previous);
    expect(scan).toHaveBeenCalledTimes(2);
  });
  it('deletes only scoped copies and refuses requests once the source is removed', async () => {
    const s = await fixture(); await s.finish(); await s.index.query(s.source());
    await fs.writeFile(join(s.dir, 'unrelated.txt'), 'keep');
    const source = s.source(); await s.store.deleteSession(s.workspaceId, s.sessionId);
    expect(await removeWorkflowIndexes(s.index, [source])).toEqual([]);
    expect(await fs.readdir(s.dir)).toEqual(['unrelated.txt']); expect((await s.app.request(s.url)).status).toBe(404);
  });
  it('reports cleanup failures rather than claiming private copies are removed', async () => {
    const s = await fixture(1); vi.spyOn(s.index, 'remove').mockRejectedValueOnce(new Error('denied'));
    expect(await removeWorkflowIndexes(s.index, [s.source()])).toEqual([expect.stringContaining('清理失败')]);
  });
});
