import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentPool, FilePersistence, MemoryPersistence } from '@tagent/core';
import { snapshotAgentForWorkflow } from '../workflow-snapshot.js';
import { Store, type ChatMessage } from '../store.js';

const directories: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'tagent-storage-'));
  directories.push(path);
  return path;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const message = (id: string): ChatMessage => ({
  id, role: 'user', content: '调研近 30 天 AI 🚀 / Docker? $0.01', timestamp: '2026-09-11T00:00:00.000Z',
});

describe('durable workspace lifecycle', () => {
  it('restores UTF-8 messages, title, trace and cost from disk after restart', async () => {
    const path = await root();
    const store = await Store.open(new FilePersistence(path));
    const ws = store.listWorkspaces()[0]!;
    const session = (await store.createSession(ws.id))!;
    const answer: ChatMessage = {
      ...message('answer'), role: 'assistant', content: '## 调研报告\n来源：https://example.com ✅',
      cost: 0.12, tokens: { input: 200, output: 40 },
      traces: [{ eventId: 'spawn-1', runId: 'r1', sessionId: session.id, taskId: 'a', agentId: 'research-agent', type: 'agent_spawn',
        agentSnapshot: snapshotAgentForWorkflow(new AgentPool().getAgent('research-agent')!, 'research'),
        timestamp: Date.now(), summary: '开始', data: { taskId: 'a' } },
      { eventId: 'e1', runId: 'r1', sessionId: session.id, type: 'complete',
        timestamp: Date.now(), status: 'complete', summary: '完成', data: { success: true } }],
      research: {
        assessment: { status: 'insufficient_evidence', researchDate: '2026-09-11', sourceCount: 1,
          datedSourceCount: 0, primarySourceCount: 0, independentPublisherCount: 1, issues: ['缺少日期'] },
        sources: [{ id: 'source1', url: 'https://example.com/report', title: '来源报道', query: 'AI Agent',
          retrievedAt: '2026-09-11', publication: { basis: 'unknown' }, readable: true, relevant: true,
          publisher: 'unverified', excerpt: '仍是计划，尚未确认。', passages: ['仍是计划，尚未确认。'] }],
        review: { passed: false, checks: [{ id: 'f1', status: 'rejected', reason: '来源没有证明已经发布' }], missingRequirements: [] },
      },
    };
    await store.addMessage(ws.id, session.id, message('user'));
    await store.addMessage(ws.id, session.id, answer);
    const reopened = await Store.open(new FilePersistence(path));
    expect(reopened.getSession(ws.id, session.id)).toEqual(store.getSession(ws.id, session.id));
    expect(reopened.getMessages(ws.id, session.id)).toEqual([message('user'), answer]);
    expect(reopened.getSession(ws.id, session.id)?.totalCost).toBe(0.12);
    expect(reopened.getSession(ws.id, session.id)?.title).toContain('调研近 30 天');
    expect(await readdir(join(path, '.tagent/data'))).toEqual(['workspaces.json']);
  });

  it('persists full/summary forks, quoted messages and deletions independently', async () => {
    const persistence = new MemoryPersistence();
    let store = await Store.open(persistence);
    const ws = store.listWorkspaces()[0]!;
    const session = (await store.createSession(ws.id))!;
    await store.addMessage(ws.id, session.id, message('parent'));
    const full = (await store.forkSession(ws.id, session.id, 'fork_full'))!;
    const summary = (await store.forkSession(ws.id, session.id, 'fork_summary', '结论摘要'))!;
    await store.addMessage(ws.id, full.id, message('child'));
    await store.addMessage(ws.id, session.id, { ...message('quote'), role: 'assistant', content: '[来自探索分支] 结论' });
    store = await Store.open(persistence);
    expect(store.getMessages(ws.id, full.id).map(m => m.id)).toEqual(['parent', 'child']);
    expect(store.getMessages(ws.id, session.id).map(m => m.id)).toEqual(['parent', 'quote']);
    expect(store.getMessages(ws.id, summary.id)[0]?.content).toContain('结论摘要');
    await store.deleteSession(ws.id, full.id);
    store = await Store.open(persistence);
    expect(store.getSession(ws.id, full.id)).toBeUndefined();
    await store.deleteWorkspace(ws.id);
    expect((await Store.open(persistence)).listWorkspaces()).toEqual([]);
  });

  it('serializes overlapping writes without losing messages', async () => {
    const path = await root();
    const store = await Store.open(new FilePersistence(path));
    const ws = store.listWorkspaces()[0]!;
    const session = (await store.createSession(ws.id))!;
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.addMessage(ws.id, session.id, message(String(i)))));
    const reopened = await Store.open(new FilePersistence(path));
    expect(reopened.getMessages(ws.id, session.id).map(m => m.id)).toEqual(Array.from({ length: 12 }, (_, i) => String(i)));
  });

  it('does not publish writes until saved and recovers after a storage error', async () => {
    const persistence = new MemoryPersistence();
    const store = await Store.open(persistence);
    const save = vi.spyOn(persistence, 'save');
    save.mockRejectedValueOnce(new Error('disk full'));
    await expect(store.createWorkspace('must not appear')).rejects.toThrow('disk full');
    expect(store.listWorkspaces()).toHaveLength(1);
    expect((await Store.open(persistence)).listWorkspaces()).toHaveLength(1);
    const ws = await store.createWorkspace('saved');
    expect((await Store.open(persistence)).getWorkspace(ws.id)?.name).toBe('saved');
  });

  it('does not allow returned objects or input messages to mutate stored state', async () => {
    const store = new Store();
    const ws = store.listWorkspaces()[0]!;
    ws.name = 'external edit';
    expect(store.getWorkspace(ws.id)?.name).not.toBe('external edit');
    const session = (await store.createSession(ws.id))!;
    const input = message('original');
    const pending = store.addMessage(ws.id, session.id, input);
    input.content = 'changed';
    await pending;
    expect(store.getMessages(ws.id, session.id)[0]?.content).toBe(message('original').content);
  });

  it('rejects an unknown session instead of accepting a lost message', async () => {
    const store = new Store();
    await expect(store.addMessage('missing', 'missing', message('lost'))).rejects.toThrow('Session not found');
  });

  it('refuses damaged or invalid stored data without overwriting it', async () => {
    const path = await root();
    const directory = join(path, '.tagent/data');
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'workspaces.json');
    for (const content of ['{broken', '{"not":"workspaces"}', '[{"id":"broken"}]']) {
      await writeFile(file, content, 'utf8');
      await expect(Store.open(new FilePersistence(path))).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(content);
    }
  });

  it('rejects path traversal storage keys', async () => {
    const persistence = new FilePersistence(await root());
    await expect(persistence.save('../outside', {})).rejects.toThrow('Invalid persistence key');
    await expect(persistence.load('../outside', {})).rejects.toThrow('Invalid persistence key');
  });
});
