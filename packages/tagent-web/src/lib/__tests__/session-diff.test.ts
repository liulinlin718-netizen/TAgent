import { describe, expect, it } from 'vitest';
import { commonMessageCount, validQuotePreview } from '../session-diff';
import type { SessionQuotePreview } from '@tagent/core';
const message = { id: 'same', role: 'assistant' as const, content: '共同材料', traces: [] };
const preview: SessionQuotePreview = { text: '原文', fingerprint: 'a'.repeat(64), targetSessionId: 'parent', targetTitle: '主线',
  requiresConfirmation: true, willWrite: false, willExecute: false,
  quote: { sourceSessionId: 'branch', sourceMessageId: 'm', sourceTitle: '来源', sourceHash: 'b'.repeat(64), start: 0, end: 2, quotedAt: '2026-09-13' } };
describe('session comparison contract', () => {
  it('uses message identity and role as well as content to find a shared prefix', () => {
    expect(commonMessageCount([message], [message])).toBe(1);
    expect(commonMessageCount([message], [{ ...message, id: 'different' }])).toBe(0);
    expect(commonMessageCount([message], [{ ...message, role: 'user' }])).toBe(0);
    expect(commonMessageCount([], [message])).toBe(0);
  });
  it('requires an unmodified excerpt, matching ownership and preview-only safety receipt', () => {
    const check = (value: SessionQuotePreview) => validQuotePreview(value, 'parent', 'branch', 'm', '原文');
    expect(check(preview)).toBe(true);
    for (const change of [{ text: 'new' }, { targetSessionId: 'foreign' }, { willExecute: true }, { willWrite: true }, { requiresConfirmation: false }, { fingerprint: '' },
      { quote: { ...preview.quote, sourceSessionId: 'foreign' } }]) {
      expect(check({ ...preview, ...change } as SessionQuotePreview)).toBe(false);
    }
  });
});
