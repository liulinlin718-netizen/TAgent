import type { SessionQuotePreview } from '@tagent/core';
import type { Session } from './conversations';

export function commonMessageCount(parent: Session['messages'], branch: Session['messages']) {
  let count = 0;
  while (count < parent.length && count < branch.length && parent[count].id === branch[count].id
    && parent[count].role === branch[count].role && parent[count].content === branch[count].content) count++;
  return count;
}

export function validQuotePreview(value: SessionQuotePreview, target: string, source: string, message: string, text: string) {
  return value && value.requiresConfirmation === true && value.willWrite === false && value.willExecute === false
    && value.targetSessionId === target && typeof value.targetTitle === 'string' && value.text === text
    && /^[a-f0-9]{64}$/.test(value.fingerprint) && value.quote?.sourceSessionId === source
    && value.quote.sourceMessageId === message && /^[a-f0-9]{64}$/.test(value.quote.sourceHash);
}
