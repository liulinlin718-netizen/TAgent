import { createHash } from 'node:crypto';
import type { SessionQuote, SessionQuotePreview } from '@tagent/core';
import type { Session, Store } from './store.js';
import { Hono } from 'hono';

export class SessionQuoteError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413) { super(message); }
}
export interface QuoteSelection { messageId?: unknown; text?: unknown; fingerprint?: unknown; confirmed?: unknown }
export function previewSessionQuote(source: Session | undefined, parent: Session | undefined, selection: QuoteSelection): SessionQuotePreview {
  if (!source || !parent || source.parentSessionId !== parent.id || source.workspaceId !== parent.workspaceId) throw new SessionQuoteError('来源分支或主线不存在。', 404);
  if ([source, parent].some(session => session.messages.some(message => message.run?.status === 'running')
    || session.summaryForks?.some(record => ['running', 'ready'].includes(record.status)))) throw new SessionQuoteError('请等待来源分支和主线任务或摘要保存结束后再引用。', 409);
  if (!selection || typeof selection.messageId !== 'string' || typeof selection.text !== 'string' || !selection.text.trim()) throw new SessionQuoteError('请选择一条分支回复及需要引用的原文。', 400);
  if (Array.from(selection.text).length > 8000) throw new SessionQuoteError('单次引用最多8000字，请选择需要的段落。', 413);
  if (Array.from(selection.text).some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff)) throw new SessionQuoteError('引用文本包含不完整字符，请重新选择。', 400);
  const message = source.messages.find(message => message.id === selection.messageId && message.role === 'assistant');
  const start = message?.content.indexOf(selection.text) ?? -1;
  if (!message || start < 0) throw new SessionQuoteError('所选文本不再与来源回复一致，请重新加载并选择原文。', 409);
  const quote: SessionQuote = { sourceSessionId: source.id, sourceMessageId: message.id, sourceTitle: source.title,
    sourceHash: createHash('sha256').update(message.content).digest('hex'), start, end: start + selection.text.length, quotedAt: new Date().toISOString() };
  const fingerprint = createHash('sha256').update(JSON.stringify([source.workspaceId, source.id, parent.id, message.id, quote.sourceHash, start, quote.end])).digest('hex');
  return { text: selection.text, quote, fingerprint, targetSessionId: parent.id, targetTitle: parent.title,
    requiresConfirmation: true as const, willWrite: false as const, willExecute: false as const };
}

export function createSessionQuoteRoutes(store: Store) {
  const app = new Hono();
  app.post('/workspaces/:wsId/sessions/:sessId/quote-preview', async c => {
    const input = await c.req.json<QuoteSelection>().catch(() => null);
    if (!input) return c.json({ error: '请选择需要引用的原文。' }, 400);
    const workspaceId = c.req.param('wsId'), source = store.getSession(workspaceId, c.req.param('sessId'));
    try { return c.json(previewSessionQuote(source, source?.parentSessionId ? store.getSession(workspaceId, source.parentSessionId) : undefined, input)); }
    catch (error) { if (error instanceof SessionQuoteError) return c.json({ error: error.message }, error.status); throw error; }
  });
  app.post('/workspaces/:wsId/sessions/:sessId/merge-to-parent', async c => {
    const input = await c.req.json<QuoteSelection>().catch(() => null);
    if (!input || input.confirmed !== true || typeof input.fingerprint !== 'string') return c.json({ error: '引用必须先预览原文，再由用户明确确认；不会自动生成或合并内容。' }, 400);
    try { return c.json(await store.quoteToParent(c.req.param('wsId'), c.req.param('sessId'), input)); }
    catch (error) { if (error instanceof SessionQuoteError) return c.json({ error: error.message }, error.status); throw error; }
  });
  return app;
}
