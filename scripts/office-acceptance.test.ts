import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTableAnalysisTools, type TableAnalysisReceipt } from '../packages/tagent-core/src/tools/table-analysis.js';
import { assertUnusedOfficeReview, checkOfficeTable, officeTable, type AcceptanceEvent } from './office-acceptance.js';
import { fixtureOfficeCase } from './fixtures/office-review.mjs';

const task = `仅核对提供的CSV，单位万元，不联网。\n${officeTable}`;
describe('office HTTP fixture selects the current task, not conversation history', () => {
  const previous = [{ role: 'system', content: 'office-case-failed' }, { role: 'user', content: 'office-case-malformed' }];
  it('uses the latest user input', () => {
    expect(fixtureOfficeCase([...previous, { role: 'user', content: 'office-case-repair' }])).toBe('repair');
  });
  it('separates current task from reference history', () => {
    expect(fixtureOfficeCase([{ role: 'user', content: '## 会话参考材料\noffice-case-malformed\n\n## 本次用户请求\noffice-case-rows-repair' }])).toBe('rows-repair');
  });
  it('uses task from review/revision payloads instead of historical material or prior output', () => {
    expect(fixtureOfficeCase([{ role: 'user', content: JSON.stringify({ materials: [{ text: 'office-case-malformed' }],
      task: 'office-case-repair', originalOutput: 'office-case-failed' }) }])).toBe('repair');
  });
  it('does not infer a case from history when the current task has no case marker', () => {
    expect(fixtureOfficeCase([...previous, { role: 'user', content: '另一项请求' }])).toBeUndefined();
  });
});
async function actualEvents(): Promise<AcceptanceEvent[]> {
  const events: AcceptanceEvent[] = [];
  const tools = createTableAnalysisTools(task, undefined, receipt => events.push({ type: 'onAgentToolResult',
    args: ['data-agent', 'analyze_table', 100, { taskId: 'data-task' }, receipt] }));
  await tools[0].execute({});
  events.push({ type: 'onAgentToolCall', args: ['data-agent', 'read_data_source', {}] });
  for (const [baseline, current] of [['1月', '2月'], ['2月', '3月']]) {
    await tools[1].execute({ action: 'aggregate', sourceId: 'current', startLine: 2, endLine: 5, format: 'csv',
      groupBy: ['月份'], metrics: [{ column: '收入', operation: 'sum' }], compare: { baseline: [baseline], current: [current], metric: 0 } });
  }
  return events;
}

describe('manual office acceptance uses actual calculation evidence', () => {
  it('accepts original table calculations from the production local tools', async () => {
    const checks = checkOfficeTable(task, await actualEvents());
    expect(checks).toHaveLength(4);
    expect(checks.every(check => check.passed)).toBe(true);
  });
  it('does not treat prose, a tool request or an inspect receipt as successful calculation', async () => {
    const receipts: AcceptanceEvent[] = [];
    const tools = createTableAnalysisTools(task, undefined, receipt => receipts.push({ type: 'onAgentToolResult',
      args: ['data-agent', 'analyze_table', 100, undefined, receipt] }));
    await tools[1].execute({ action: 'inspect', sourceId: 'current', startLine: 2, endLine: 5, format: 'csv' });
    receipts.push({ type: 'onAgentToolCall', args: ['data-agent', 'analyze_table', {}] },
      { type: 'onAgentComplete', args: ['data-agent', { output: '310万元，20%，-25%，全部计算通过' }] });
    expect(checkOfficeTable(task, receipts).every(check => !check.passed)).toBe(true);
  });
  it.each(['source', 'selection', 'range', 'rows', 'agent', 'value', 'missing'])(
    'rejects stale, incomplete or incorrect evidence (%s)', async kind => {
      const events = await actualEvents();
      for (const event of events.filter(event => event.type === 'onAgentToolResult')) {
        const receipt = event.args[4] as Extract<TableAnalysisReceipt, { action: 'aggregate' }>;
        if (kind === 'source') receipt.provenance.sourceSha256 = 'another-input';
        if (kind === 'selection') receipt.provenance.selectionSha256 = 'changed-table';
        if (kind === 'range') receipt.provenance.endLine--;
        if (kind === 'rows') receipt.provenance.rows--;
        if (kind === 'agent') event.args[0] = 'document-agent';
        if (kind === 'value') receipt.groups[2].metrics[0].value = '900';
        if (kind === 'missing') receipt.groups[0].metrics[0].missing = 1;
      }
      expect(checkOfficeTable(task, events).slice(1).every(check => !check.passed)).toBe(true);
    });
  it.each(['baseline', 'percent', 'partial', 'missing-comparison'])('rejects an invalid second comparison (%s)', async kind => {
    const events = await actualEvents();
    const receipt = events.at(-1)!.args[4] as Extract<TableAnalysisReceipt, { action: 'aggregate' }>;
    if (kind === 'baseline') receipt.comparison!.baseline = ['1月'];
    if (kind === 'percent') receipt.comparison!.percentChange = '25';
    if (kind === 'partial') receipt.comparison!.partial = true;
    if (kind === 'missing-comparison') delete receipt.comparison;
    expect(checkOfficeTable(task, events).map(check => check.passed)).toEqual([true, true, true, false]);
  });
});

describe('manual live scripts require a single explicit execution flag', () => {
  it.each([
    ['verify-office-delivery.mts', 'Select at least one explicitly authorized office role'],
    ['verify-research-report.mts', 'Supply exactly one captured live-task artifact'],
    ['verify-office-review.mts', 'Pass the original project acceptance artifact.'],
  ])('requires an explicit acceptance target before loading %s', (script, reason) => {
    const bootstrap = `globalThis.fetch = () => { console.error('NETWORK FORBIDDEN'); process.exit(99); };
      const { pathToFileURL } = await import('node:url'); await import(pathToFileURL(process.argv[1]).href);`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', bootstrap,
      fileURLToPath(new URL(script, import.meta.url)), '--live', '--max-calls', '1', '--max-recorded-cost', '.01'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 15000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(reason);
    expect(result.stderr).not.toContain('NETWORK FORBIDDEN');
    expect(result.stdout).toBe('');
  });
  it.each(['verify-live-task.mjs', 'verify-office-delivery.mts', 'verify-research-report.mts', 'verify-office-review.mts'].flatMap(script =>
    [[], ['--live', '--live'], ...(script === 'verify-live-task.mjs' ? [] : [['--live']])].map(args => ({ script, args }))))(
    'refuses accidental execution of $script with $args', ({ script, args }) => {
      const bootstrap = `globalThis.fetch = () => { console.error('NETWORK FORBIDDEN'); process.exit(99); };
        const { pathToFileURL } = await import('node:url'); await import(pathToFileURL(process.argv[1]).href);`;
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', bootstrap,
        fileURLToPath(new URL(script, import.meta.url)), ...args],
      { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 15000, windowsHide: true });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(args.length === 1 ? 'requires explicit limits' : 'Pass --live once');
      expect(result.stderr).not.toContain('NETWORK FORBIDDEN');
      expect(result.stdout).toBe('');
  });
});

describe('explicit single-review resumption never resets spent or uncertain calls', () => {
  const expected = { sha256: 'fixture-hash', originalArtifact: 'fixture-project.json' };
  const unused = () => ({ ...expected, mode: 'single_pass_office_review', state: 'finished',
    acceptance: { calls: 0, recordedCost: 0, activeCalls: 0, reservedCost: 0, unsettledRequests: 0 } });
  it('allows only a terminal zero-dispatch record tied to the same original', () => {
    expect(() => assertUnusedOfficeReview(unused(), expected)).not.toThrow();
    expect(() => assertUnusedOfficeReview({ ...unused(), state: 'not_dispatched' }, expected)).not.toThrow();
  });
  it.each(['calls', 'recordedCost', 'activeCalls', 'reservedCost', 'unsettledRequests'] as const)(
    'rejects nonzero or missing accounting: %s', field => {
      const changed = unused(); changed.acceptance[field] = 1;
      expect(() => assertUnusedOfficeReview(changed, expected)).toThrow('zero');
      expect(() => assertUnusedOfficeReview({ ...unused(), acceptance: { ...unused().acceptance, [field]: undefined } }, expected)).toThrow('zero');
    });
  it.each(['state', 'mode', 'sha256', 'originalArtifact'] as const)('rejects a mismatched or incomplete record: %s', field => {
    expect(() => assertUnusedOfficeReview({ ...unused(), [field]: 'another' }, expected)).toThrow('matching');
  });
  it('does not infer zero dispatch from absent accounting', () => {
    for (const value of [null, {}, { ...unused(), acceptance: undefined }]) {
      expect(() => assertUnusedOfficeReview(value, expected)).toThrow('accounting');
    }
  });
});
