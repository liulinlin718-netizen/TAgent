import type { TableAnalysisReceipt, TableProvenance } from '@tagent/core';
import type { TraceEvent } from '../app/WorkflowDrawer.logic';
import type { ChatMessage } from '../lib/conversations';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const count = (value: unknown, max = 5000): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max;
const strings = (value: unknown, max: number, width: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(item => text(item, width));
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const decimal = (value: unknown): value is string | null => value === null || (text(value, 170) && /^-?\d+(?:\.\d+)?$/.test(value));
const operations = ['sum', 'mean', 'min', 'max', 'count'];

/** Validate saved/UI data before displaying it; this is not an independent arithmetic audit. */
export function parseTableReceipt(value: unknown): TableAnalysisReceipt | undefined {
  if (!object(value) || value.version !== 1 || value.localOnly !== true || value.executedCode !== false || !object(value.provenance)) return;
  const p = value.provenance;
  if (!text(p.sourceId, 300) || !(p.sourceId === 'current' || /^history:.+/.test(p.sourceId))
    || !digest(p.sourceSha256) || !digest(p.selectionSha256) || !count(p.startLine, 65536) || p.startLine < 1
    || !count(p.endLine, 65536) || p.endLine < p.startLine || !count(p.rows) || p.rows < 1
    || !strings(p.columns, 64, 120) || !p.columns.length || p.columns.some(column => !column.trim()) || new Set(p.columns).size !== p.columns.length
    || !['csv', 'tsv', 'semicolon', 'markdown'].includes(String(p.format)) || !text(p.scope, 300)) return;
  const headers = p.columns, rowCount = p.rows;
  if (value.action === 'inspect') {
    if (!Array.isArray(value.profile) || value.profile.length !== headers.length || !value.profile.every((column, index) => object(column)
      && column.column === headers[index] && count(column.missing) && count(column.numeric) && count(column.nonNumeric)
      && column.missing + column.numeric + column.nonNumeric === rowCount)
      || !Array.isArray(value.sample) || value.sample.length > 5 || !value.sample.every((row, index) => object(row)
        && row.record === index + 1 && strings(row.values, headers.length, 160) && row.values.length === headers.length)
      || !text(value.sampleNote, 500)) return;
  } else if (value.action === 'aggregate') {
    if (!strings(value.groupBy, 3, 120) || new Set(value.groupBy).size !== value.groupBy.length || value.groupBy.some(column => !headers.includes(column))
      || !['reject', 'exclude'].includes(String(value.invalidValues)) || !Array.isArray(value.metrics) || !value.metrics.length || value.metrics.length > 8
      || !value.metrics.every(metric => object(metric) && headers.includes(String(metric.column)) && operations.includes(String(metric.operation)))
      || !Array.isArray(value.groups) || !value.groups.length || value.groups.length > 100 || !object(value.semantics)) return;
    const metrics = value.metrics, groupBy = value.groupBy;
    if (!['count', 'missing', 'numeric', 'grouping', 'rounding'].every(key => text((value.semantics as Record<string, unknown>)[key], 500))) return;
    let rows = 0;
    const keys = new Set<string>();
    for (const group of value.groups) {
      if (!object(group) || !strings(group.key, groupBy.length, 2000) || group.key.length !== groupBy.length
        || !count(group.rows) || group.rows < 1 || !Array.isArray(group.metrics) || group.metrics.length !== metrics.length) return;
      const key = JSON.stringify(group.key); if (keys.has(key)) return; keys.add(key); rows += group.rows;
      for (let i = 0; i < metrics.length; i++) {
        const metric = group.metrics[i];
        if (!object(metric) || metric.column !== metrics[i].column || metric.operation !== metrics[i].operation || !decimal(metric.value)
          || !count(metric.valid) || !count(metric.missing) || !count(metric.invalid) || metric.valid + metric.missing + metric.invalid !== group.rows
          || !Array.isArray(metric.invalidExamples) || metric.invalidExamples.length > 5 || metric.invalidExamples.length > metric.invalid
          || !metric.invalidExamples.every(example => object(example) && count(example.record, rowCount) && example.record > 0 && text(example.value, 160))) return;
        const expected = metric.invalid > 0 && value.invalidValues === 'reject' ? 'invalid_values'
          : metric.valid === 0 && metric.operation !== 'count' ? 'no_numeric_values'
            : metric.invalid || (metric.missing && metric.operation !== 'count') ? 'partial' : 'computed';
        if (metric.status !== expected || (metric.value === null) !== ['invalid_values', 'no_numeric_values'].includes(expected)
          || (metric.operation === 'count' && metric.invalid !== 0)) return;
      }
    }
    if (rows !== rowCount) return;
    if (value.comparison !== undefined) {
      const c = value.comparison;
      if (!object(c) || !strings(c.baseline, groupBy.length, 2000) || !strings(c.current, groupBy.length, 2000)
        || c.baseline.length !== groupBy.length || c.current.length !== groupBy.length || !keys.has(JSON.stringify(c.baseline))
        || !keys.has(JSON.stringify(c.current)) || JSON.stringify(c.baseline) === JSON.stringify(c.current)
        || !count(c.metric, metrics.length - 1) || metrics[c.metric].operation === 'mean'
        || !decimal(c.difference) || !decimal(c.percentChange) || typeof c.partial !== 'boolean' || !text(c.formula, 500)
        || !['computed', 'unavailable', 'non_positive_baseline'].includes(String(c.status))
        || (c.status === 'computed' ? c.difference === null || c.percentChange === null
          : c.percentChange !== null || (c.status === 'unavailable') !== (c.difference === null))) return;
    }
  } else return;
  return value as TableAnalysisReceipt;
}

export type CalculationEntry = { eventId: string; runId: string; agentId?: string; taskId?: string; receipt?: TableAnalysisReceipt };
export function tableEntries(traces: TraceEvent[], runId?: string): CalculationEntry[] {
  const expectedRun = runId || traces.find(trace => trace.runId)?.runId;
  if (!expectedRun) return [];
  const seen = new Set<string>();
  return traces.flatMap(trace => {
    if (trace.type !== 'agent_tool_result' || (trace.toolName || trace.data?.tool) !== 'analyze_table'
      || trace.runId !== expectedRun || !trace.eventId || seen.has(trace.eventId) || !Object.hasOwn(trace.data || {}, 'tableAnalysis')) return [];
    seen.add(trace.eventId);
    return [{ eventId: trace.eventId, runId: expectedRun, agentId: trace.agentId, taskId: trace.taskId,
      receipt: parseTableReceipt(trace.data.tableAnalysis) }];
  });
}

export function receiptNeedsAttention(receipt: TableAnalysisReceipt): boolean {
  return receipt.action === 'inspect' ? receipt.profile.some(column => column.missing > 0)
    : receipt.groups.some(group => group.metrics.some(metric => metric.status !== 'computed' || metric.missing > 0))
      || !!receipt.comparison && (receipt.comparison.status !== 'computed' || receipt.comparison.partial);
}

export function sourceCandidate(entry: CalculationEntry, owner: ChatMessage, messages: ChatMessage[]): string | undefined {
  if (!entry.receipt) return;
  const sourceId = entry.receipt.provenance.sourceId;
  const id = sourceId === 'current' ? `${entry.runId}-user` : sourceId.slice('history:'.length);
  const position = messages.findIndex(message => message.id === id), ownerPosition = messages.findIndex(message => message.id === owner.id);
  const message = messages[position];
  if (position < 0 || ownerPosition < 0 || position >= ownerPosition || message.role !== 'user' || message.quote || message.contextKind === 'fork_summary') return;
  return message.content;
}

export async function matchTableSource(provenance: TableProvenance, candidate?: string): Promise<{ matched: boolean; reason: string; text?: string }> {
  if (candidate === undefined) return { matched: false, reason: '当前会话未保留这份完整用户原文，无法核对。' };
  const bytes = new TextEncoder().encode(candidate);
  if (bytes.length > 65536) return { matched: false, reason: '当前原文超出回执的材料上限，未核对。' };
  const sha = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (await sha(bytes) !== provenance.sourceSha256) return { matched: false, reason: '当前消息与计算时的原文指纹不一致，不显示为已核对原表。' };
  const lines: { start: number; end: number }[] = [];
  let start = 0;
  for (const match of candidate.matchAll(/\r\n|\n|\r/g)) { lines.push({ start, end: match.index! }); start = match.index! + match[0].length; }
  lines.push({ start, end: candidate.length });
  const from = lines[provenance.startLine - 1], to = lines[provenance.endLine - 1];
  if (!from || !to || provenance.endLine < provenance.startLine) return { matched: false, reason: '回执行范围超出原文，无法核对。' };
  const text = candidate.slice(from.start, to.end);
  if (await sha(new TextEncoder().encode(text)) !== provenance.selectionSha256) return { matched: false, reason: '所选原文与回执指纹不一致，无法核对。' };
  return { matched: true, reason: '所选原文与计算回执指纹一致；不代表数据来源或业务结论已核实。', text };
}

export const operationLabels: Record<string, string> = { sum: '合计', mean: '均值', min: '最小值', max: '最大值', count: '非空计数' };
export const metricLabels: Record<string, string> = { computed: '已计算', partial: '部分数据', invalid_values: '含无效值，未计算', no_numeric_values: '无有效数值' };
export const groupLabel = (values: string[]) => values.length ? values.map(value => value.trim() ? value : '（空白分组）').join(' / ') : '全部选中数据';
