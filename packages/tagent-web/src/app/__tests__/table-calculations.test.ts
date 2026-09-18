import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTableAnalysisTools } from '../../../../tagent-core/src/tools/table-analysis';
import type { TableAnalysisReceipt } from '@tagent/core';
import type { TraceEvent } from '../WorkflowDrawer.logic';
import type { ChatMessage } from '../../lib/conversations';
import { matchTableSource, parseTableReceipt, receiptNeedsAttention, sourceCandidate, tableEntries } from '../../components/TableCalculations.logic';

const input = '分析下表😀\r\n月份,收入\r\n1月,0.1\r\n1月,0.2\r\n2月,0.6';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
async function receipt(action: 'inspect' | 'aggregate' = 'aggregate', text = input): Promise<TableAnalysisReceipt> {
  const [, tool] = createTableAnalysisTools(text);
  return JSON.parse(await tool.execute({ sourceId: 'current', startLine: 2, endLine: 5, format: 'csv', action,
    ...(action === 'aggregate' ? { groupBy: ['月份'], metrics: [{ column: '收入', operation: 'sum' }], compare: { baseline: ['1月'], current: ['2月'], metric: 0 } } : {}) }));
}
const event = (value: unknown, extra: Partial<TraceEvent> = {}): TraceEvent => ({ type: 'agent_tool_result', toolName: 'analyze_table', runId: 'run-fixture',
  eventId: 'e1', timestamp: 1, data: { tableAnalysis: value }, ...extra });
const messages = (): ChatMessage[] => [{ id: 'run-fixture-user', role: 'user', content: input, traces: [] },
  { id: 'run-fixture-assistant', role: 'assistant', content: '结果', traces: [], run: { id: 'run-fixture', status: 'finished' } }];

describe('readable calculation receipt validation and provenance', () => {
  it.each(['inspect', 'aggregate'] as const)('accepts actual %s tool receipts without converting precise strings', async action => {
    const value = await receipt(action);
    expect(parseTableReceipt(value)).toEqual(value);
    expect(receiptNeedsAttention(value)).toBe(false);
    if (value.action === 'aggregate') expect(value.groups[0].metrics[0].value).toBe('0.3');
  });
  it('matches UTF-8 original and exact CRLF selected range using browser-compatible hashes', async () => {
    const value = await receipt();
    const result = await matchTableSource(value.provenance, input);
    expect(result.matched).toBe(true); expect(result.text).toBe(input.split('\r\n').slice(1).join('\r\n'));
    expect(result.reason).toContain('不代表');
    expect((await matchTableSource(value.provenance, input.replace(/\r\n/g, '\n'))).matched).toBe(false);
  });
  it.each(['missing', 'changed', 'selection', 'range', 'oversized'])('does not present %s source material as verified', async mode => {
    const value = await receipt();
    if (mode === 'selection') value.provenance.selectionSha256 = sha('other');
    if (mode === 'range') value.provenance.endLine = 999;
    const candidate = mode === 'missing' ? undefined : mode === 'changed' ? input.replace('0.1', '99') : mode === 'oversized' ? '字'.repeat(30000) : input;
    const result = await matchTableSource(value.provenance, candidate);
    expect(result.matched).toBe(false); expect(result.text).toBeUndefined();
  });
  it('preserves invalid and missing statuses, including unavailable comparisons', async () => {
    for (const text of [input.replace('0.1', '=1+2'), input.replace('0.1', ''), input.replace('0.1', '-0.1').replace('0.2', '-0.2')]) {
      const value = await receipt('aggregate', text);
      expect(parseTableReceipt(value)).toEqual(value); expect(receiptNeedsAttention(value)).toBe(true);
      if (text.includes('=') && value.action === 'aggregate') expect(value.groups[0].metrics[0].value).toBeNull();
    }
  });
  it.each(['version', 'rows', 'metric', 'group', 'count', 'numeric', 'status', 'comparison', 'duplicate-group', 'overflow', 'profile'])('rejects malformed %s data instead of guessing or crashing', async mode => {
    const value = await receipt(mode === 'profile' ? 'inspect' : 'aggregate');
    if (mode === 'version') value.version = 99 as 1;
    if (mode === 'rows') value.provenance.rows = -1;
    if (mode === 'profile' && value.action === 'inspect') value.profile[0].numeric = 99;
    if (value.action === 'aggregate') {
      if (mode === 'metric') value.groups[0].metrics[0].column = 'unknown';
      if (mode === 'group') value.groupBy = ['unknown'];
      if (mode === 'count') value.groups[0].metrics[0].valid = 100;
      if (mode === 'numeric') value.groups[0].metrics[0].value = 'NaN';
      if (mode === 'status') value.groups[0].metrics[0].status = 'made-up';
      if (mode === 'comparison') value.comparison!.metric = 30;
      if (mode === 'duplicate-group') value.groups.push(value.groups[0]);
      if (mode === 'overflow') value.groups[0].key[0] = 'x'.repeat(2001);
    }
    expect(parseTableReceipt(value)).toBeUndefined();
  });
  it('ignores foreign runs and forged tool payloads; repeated events are not repeated calculations', async () => {
    const value = await receipt();
    const events = [event(value), event(value), event(value, { eventId: 'other', runId: 'foreign' }),
      event(value, { eventId: 'mcp', toolName: 'mcp_spreadsheet' }), event({}, { eventId: 'bad' })];
    const entries = tableEntries(events, 'run-fixture');
    expect(entries.map(entry => entry.eventId)).toEqual(['e1', 'bad']);
    expect(entries[0].receipt).toEqual(value); expect(entries[1].receipt).toBeUndefined();
  });
  it('locates the exact run user message, not the nearest message or another assistant', async () => {
    const list = messages(), value = await receipt(), entry = tableEntries([event(value)])[0];
    expect(sourceCandidate(entry, list[1], list)).toBe(input);
    list[0].role = 'assistant'; expect(sourceCandidate(entry, list[1], list)).toBeUndefined();
    list[0].role = 'user'; list[0].id = 'different-run-user';
    expect(sourceCandidate(entry, list[1], list)).toBeUndefined();
    value.provenance.sourceId = 'history:different-run-user';
    const history = tableEntries([event(value)])[0];
    expect(sourceCandidate(history, list[1], list)).toBe(input);
    list[0].contextKind = 'fork_summary'; expect(sourceCandidate(history, list[1], list)).toBeUndefined();
    list[0].contextKind = undefined;
    expect(sourceCandidate(history, list[1], [...list].reverse())).toBeUndefined();
  });
});
