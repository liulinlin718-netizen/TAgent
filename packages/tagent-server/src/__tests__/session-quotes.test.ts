import { describe, expect, it, vi } from 'vitest';
import { MemoryPersistence } from '@tagent/core';
import { Store, type ChatMessage } from '../store.js';
import { createSessionQuoteRoutes, previewSessionQuote } from '../session-quotes.js';

const message = (id: string, content: string, role: ChatMessage['role'] = 'assistant'): ChatMessage => ({ id, content, role, timestamp: new Date().toISOString() });
async function fixture() {
  const persistence = new MemoryPersistence(), store = await Store.open(persistence), ws = store.listWorkspaces()[0].id;
  const parent = (await store.createSession(ws))!.id;
  await store.addMessage(ws, parent, message('user', '原始限制：预算1200元。', 'user'));
  const branch = (await store.forkSession(ws, parent, 'fork_full'))!.id;
  await store.addMessage(ws, branch, message('reply', '未核实计划\n中文🚀 / Docker: $0.01\n仅建议，未授权执行。'));
  const app = createSessionQuoteRoutes(store), path = `/workspaces/${ws}/sessions/${branch}`;
  const input = { messageId: 'reply', text: '中文🚀 / Docker: $0.01' };
  const post = (suffix: string, body: unknown) => app.request(path + suffix, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { persistence, store, ws, parent, branch, app, path, input, post };
}
describe('manual session excerpts and durable context admission', () => {
  it('previews without writes, requires consent, and saves one original excerpt with provenance across restart', async () => {
    const f = await fixture(), save = vi.spyOn(f.persistence, 'save');
    const before = f.store.getSession(f.ws, f.branch);
    const previewResponse = await f.post('/quote-preview', f.input);
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({ text: f.input.text, requiresConfirmation: true, willWrite: false, willExecute: false });
    expect(save).not.toHaveBeenCalled();
    expect((await f.post('/merge-to-parent', {})).status).toBe(400);
    expect((await f.post('/merge-to-parent', { ...f.input, fingerprint: preview.fingerprint })).status).toBe(400);
    const confirmed = { ...f.input, fingerprint: preview.fingerprint, confirmed: true };
    expect((await (await f.post('/merge-to-parent', confirmed)).json()).created).toBe(true);
    expect((await (await f.post('/merge-to-parent', confirmed)).json()).created).toBe(false);
    const reopened = await Store.open(f.persistence), messages = reopened.getMessages(f.ws, f.parent);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ content: f.input.text, role: 'assistant', quote: { sourceSessionId: f.branch, sourceMessageId: 'reply' } });
    expect(reopened.getSession(f.ws, f.branch)).toEqual(before);
    const context = await reopened.beginRun(f.ws, f.parent, 'run-followup', '按刚才的预算整理');
    expect(context.items.map(item => item.kind)).toEqual(['user_input', 'quoted_excerpt']);
    expect(context.items[0].content).toContain('1200元');
    expect(JSON.stringify(reopened.findRun('run-followup')?.message.run?.context)).not.toContain(f.input.text);
    context.items[0].content = 'mutation';
    expect(reopened.getMessages(f.ws, f.parent)[0].content).toContain('1200元');
  });
  it.each([
    [{ messageId: 'user', text: '原始限制' }, 409],
    [{ messageId: 'reply', text: 'fabricated' }, 409],
    [{ messageId: 'reply', text: '' }, 400],
    [{ messageId: 'reply', text: 'x'.repeat(8001) }, 413],
    [{ messageId: 'reply', text: '\ud83d' }, 400],
  ])('rejects invalid excerpt %# without saving', async (input, status) => {
    const f = await fixture(), save = vi.spyOn(f.persistence, 'save');
    expect((await f.post('/quote-preview', input)).status).toBe(status); expect(save).not.toHaveBeenCalled();
  });
  it('rejects stale fingerprints, unknown sources and unrelated parents', async () => {
    const f = await fixture();
    expect((await f.post('/merge-to-parent', { ...f.input, fingerprint: '0'.repeat(64), confirmed: true })).status).toBe(409);
    expect(() => previewSessionQuote(f.store.getSession(f.ws, f.branch), { ...f.store.getSession(f.ws, f.parent)!, id: 'other' }, f.input)).toThrow('不存在');
    expect((await f.app.request('/workspaces/other/sessions/missing/quote-preview', { method: 'POST', body: JSON.stringify(f.input), headers: { 'content-type': 'application/json' } })).status).toBe(404);
  });
  it.each(['parent', 'branch'] as const)('blocks quotes and forks while %s is running', async side => {
    const f = await fixture();
    await f.store.beginRun(f.ws, f[side], 'run-active', 'next');
    expect((await f.post('/quote-preview', f.input)).status).toBe(409);
    await expect(f.store.forkSession(f.ws, f[side], 'fork_full')).rejects.toThrow('运行');
  });
  it('does not leak parent updates or other sessions into a branch or blank conversation', async () => {
    const f = await fixture();
    await f.store.addMessage(f.ws, f.parent, message('private', 'PARENT_LATER_ONLY'));
    const context = await f.store.beginRun(f.ws, f.branch, 'run-branch', '继续');
    expect(JSON.stringify(context)).not.toContain('PARENT_LATER_ONLY');
    const blank = (await f.store.createSession(f.ws))!.id;
    expect((await f.store.beginRun(f.ws, blank, 'run-blank', '继续')).items).toEqual([]);
    const summary = (await f.store.forkSession(f.ws, f.parent, 'fork_summary', '摘要材料'))!.id;
    expect((await f.store.beginRun(f.ws, summary, 'run-summary', '继续')).items[0].kind).toBe('fork_summary');
  });
  it('serializes quote with run admission and keeps state intact on disk failure', async () => {
    const f = await fixture();
    const preview = await (await f.post('/quote-preview', f.input)).json();
    const selection = { ...f.input, fingerprint: preview.fingerprint, confirmed: true };
    vi.spyOn(f.persistence, 'save').mockRejectedValueOnce(new Error('disk full'));
    await expect(f.store.quoteToParent(f.ws, f.branch, selection)).rejects.toThrow('disk full');
    expect(f.store.getMessages(f.ws, f.parent)).toHaveLength(1);
    const quoting = f.store.quoteToParent(f.ws, f.branch, selection);
    const running = f.store.beginRun(f.ws, f.parent, 'run-ordered', '继续');
    await quoting;
    expect((await running).items.some(item => item.kind === 'quoted_excerpt')).toBe(true);
  });
});
