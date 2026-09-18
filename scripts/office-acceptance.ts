import { createHash } from 'node:crypto';
import type { TableAnalysisReceipt } from '../packages/tagent-core/src/tools/table-analysis.js';

export interface AcceptanceEvent { type: string; args: unknown[] }
export const officeTable = '月份,收入\n1月,100\n2月,120\n3月,90';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function assertUnusedOfficeReview(value: unknown, expected: { sha256: string; originalArtifact: string }) {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const accounting = record.acceptance && typeof record.acceptance === 'object'
    ? record.acceptance as Record<string, unknown> : {};
  if (record.mode !== 'single_pass_office_review' || !['finished', 'not_dispatched'].includes(String(record.state))
    || record.sha256 !== expected.sha256 || record.originalArtifact !== expected.originalArtifact
    || !['calls', 'recordedCost', 'activeCalls', 'reservedCost', 'unsettledRequests'].every(key => accounting[key] === 0)) {
    throw new Error('Resume requires a matching terminal review with zero dispatched requests and complete zero-use accounting.');
  }
}

/** Checks actual local calculation receipts, not model claims or numbers in prose. */
export function checkOfficeTable(task: string, events: AcceptanceEvent[]) {
  const lines = task.split('\n');
  const start = lines.indexOf('月份,收入') + 1;
  const receipts = events.flatMap(event => {
    if (event.type !== 'onAgentToolResult' || event.args[0] !== 'data-agent'
      || event.args[1] !== 'analyze_table') return [];
    const receipt = event.args[4] as TableAnalysisReceipt | undefined;
    if (!receipt || receipt.action !== 'aggregate' || receipt.version !== 1
      || receipt.localOnly !== true || receipt.executedCode !== false) return [];
    const source = receipt.provenance;
    if (!start || source.sourceId !== 'current' || source.sourceSha256 !== sha256(task)
      || source.startLine !== start || source.endLine !== start + 3
      || source.selectionSha256 !== sha256(officeTable) || source.rows !== 3 || source.format !== 'csv'
      || JSON.stringify(source.columns) !== JSON.stringify(['月份', '收入'])) return [];
    return [receipt];
  });
  const monthly = receipts.filter(receipt => receipt.groupBy.length === 1 && receipt.groupBy[0] === '月份'
    && receipt.groups.length === 3 && ['1月', '2月', '3月'].every((month, index) => {
      const group = receipt.groups.find(item => item.key.length === 1 && item.key[0] === month);
      return group?.rows === 1 && group.metrics.some(metric => metric.column === '收入' && metric.operation === 'sum'
        && metric.value === ['100', '120', '90'][index] && metric.valid === 1 && metric.missing === 0 && metric.invalid === 0);
    }));
  const comparison = (baseline: string, current: string, difference: string, percentChange: string) => monthly.some(receipt => {
    const value = receipt.comparison;
    const metric = value && receipt.metrics[value.metric];
    return value?.status === 'computed' && value.partial === false && metric?.column === '收入' && metric.operation === 'sum'
      && JSON.stringify(value.baseline) === JSON.stringify([baseline]) && JSON.stringify(value.current) === JSON.stringify([current])
      && value.difference === difference && value.percentChange === percentChange;
  });
  return [
    { pattern: 'data agent reads the original input', passed: events.some(event => event.type === 'onAgentToolCall'
      && event.args[0] === 'data-agent' && event.args[1] === 'read_data_source') },
    { pattern: 'complete original table, monthly sums 100/120/90 (total 310)', passed: monthly.length > 0 },
    { pattern: 'January to February: +20, +20%', passed: comparison('1月', '2月', '20', '20') },
    { pattern: 'February to March: -30, -25%', passed: comparison('2月', '3月', '-30', '-25') },
  ];
}
