import { describe, expect, it } from 'vitest';
import { summaryPending, summaryStatus, validSummaryConsent, validSummaryView } from '../session-summary';
import type { Session } from '../conversations';
import type { SummaryForkView } from '@tagent/core';

const messages: Session['messages'] = [{ id: 'u', role: 'user', content: '预算1200元🚀', traces: [] }, { id: 'a', role: 'assistant', content: '尚未执行', traces: [] }];
const consent = () => ({ id: 'sumfork-00000000-0000-0000-0000-000000000000', token: 'confirmation', expiresAt: Date.now() + 300000,
  preview: { version: 1, sourceHash: 'a'.repeat(64), provider: 'fixture', model: 'model', endpoint: 'http://127.0.0.1', inputMessageIds: ['a'], preservedMessageIds: ['u'],
    inputBytes: 500, preservedCharacters: 9, maxModelCalls: 1, maxOutputTokens: 2048, estimatedCost: null, requiresConfirmation: true, willWrite: false, willExecute: false } });
const view = () => { const value = consent(); return { record: { id: value.id, workspaceId: 'w', sourceSessionId: 's', targetSessionId: value.id.replace('sumfork-', 'sess-summary-'),
  preview: value.preview, startedAt: Date.now(), status: 'running', usage: { input: 0, output: 0, knownCost: 0, unsettledRequests: 1, pricingKnown: false } }, persisted: true, canRetrySave: false } as SummaryForkView; };
describe('summary-fork UI contracts', () => {
  it('accepts only matching scope, ordered selections and explicit preview safety', () => {
    const value = consent(); expect(validSummaryConsent(value, messages, ['u'])).toBe(true);
    for (const change of [{ willExecute: true }, { willWrite: true }, { requiresConfirmation: false }, { inputMessageIds: ['u', 'a'] }, { preservedMessageIds: [] }, { estimatedCost: -1 }]) {
      expect(validSummaryConsent({ ...value, preview: { ...value.preview, ...change } }, messages, ['u'])).toBe(false);
    }
    expect(validSummaryConsent({ ...value, expiresAt: 1 }, messages, ['u'])).toBe(false);
  });
  it('rejects mismatched operations, corrupt costs and falsely persisted failures', () => {
    const value = view(); expect(validSummaryView(value, 'w', 's')).toBe(true);
    expect(validSummaryView(value, 'foreign', 's')).toBe(false);
    expect(validSummaryView({ ...value, canRetrySave: true }, 'w', 's')).toBe(false);
    expect(validSummaryView({ ...value, record: { ...value.record, usage: { ...value.record.usage, knownCost: NaN } } }, 'w', 's')).toBe(false);
    expect(validSummaryView({ ...value, record: { ...value.record, targetSessionId: 'somewhere-else' } }, 'w', 's')).toBe(false);
  });
  it('stops automatic polling at a storage failure and does not call it completed', () => {
    const value = view(); expect(summaryPending(value)).toBe(true);
    const unsaved: SummaryForkView = { ...value, persisted: false, canRetrySave: true, record: { ...value.record, status: 'ready' } };
    expect(summaryPending(unsaved)).toBe(false); expect(summaryStatus(unsaved)).toBe('保存未完成');
    expect(summaryStatus({ ...value, record: { ...value.record, status: 'completed' } })).toBe('分支已保存');
  });
});
