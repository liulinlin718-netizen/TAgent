import type { SummaryForkConsent, SummaryForkPreview, SummaryForkView } from '@tagent/core';
import type { Session } from './conversations';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === 'string') && new Set(value).size === value.length;
function validPreview(value: unknown): value is SummaryForkPreview {
  return object(value) && value.version === 1 && typeof value.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(value.sourceHash)
    && ['provider', 'model', 'endpoint'].every(key => typeof value[key] === 'string')
    && ids(value.inputMessageIds) && ids(value.preservedMessageIds)
    && value.maxModelCalls === 1 && value.maxOutputTokens === 2048 && finite(value.inputBytes) && value.inputBytes <= 64000
    && finite(value.preservedCharacters) && value.preservedCharacters <= 8000
    && (value.estimatedCost === null || finite(value.estimatedCost))
    && value.requiresConfirmation === true && value.willWrite === false && value.willExecute === false;
}
export function validSummaryConsent(value: unknown, messages: Session['messages'], selected: string[]): value is SummaryForkConsent {
  if (!object(value) || typeof value.id !== 'string' || !/^sumfork-[a-f0-9-]{36}$/.test(value.id)
    || typeof value.token !== 'string' || !value.token || !finite(value.expiresAt) || value.expiresAt <= Date.now() || !validPreview(value.preview)) return false;
  return JSON.stringify(value.preview.preservedMessageIds) === JSON.stringify(messages.filter(message => selected.includes(message.id)).map(message => message.id))
    && JSON.stringify(value.preview.inputMessageIds) === JSON.stringify(messages.filter(message => !selected.includes(message.id) && message.content.trim()).map(message => message.id));
}
export function validSummaryView(value: unknown, workspaceId: string, sessionId: string): value is SummaryForkView {
  if (!object(value) || typeof value.persisted !== 'boolean' || typeof value.canRetrySave !== 'boolean' || value.persisted === value.canRetrySave || !object(value.record)) return false;
  const record = value.record, usage = record.usage;
  return record.workspaceId === workspaceId && record.sourceSessionId === sessionId && typeof record.id === 'string'
    && /^sumfork-[a-f0-9-]{36}$/.test(record.id) && record.targetSessionId === record.id.replace('sumfork-', 'sess-summary-')
    && ['running', 'ready', 'completed', 'failed', 'interrupted'].includes(String(record.status)) && finite(record.startedAt)
    && validPreview(record.preview) && object(usage) && ['input', 'output', 'knownCost', 'unsettledRequests'].every(key => finite(usage[key]))
    && typeof usage.pricingKnown === 'boolean' && (usage.unsettledRequests as number) <= 1
    && [record.error, record.output, record.rawOutput].every(item => item === undefined || typeof item === 'string');
}
export const summaryPending = (view: SummaryForkView) => view.persisted && ['running', 'ready'].includes(view.record.status);
export const summaryStatus = (view: SummaryForkView) => !view.persisted ? '保存未完成'
  : ({ running: '正在提取摘要', ready: '正在保存分支', completed: '分支已保存', failed: '摘要未通过', interrupted: '已停止或中断' })[view.record.status];
