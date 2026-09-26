import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { collectEvents, analyzeCollectedTrace, createTraceIndex } from '../src/index.js';

// Bounded synthetic in-memory baseline; fresh process per size, no files or network.
const size = Number(process.argv[2]);
if (!process.argv[2]) {
  for (const count of [1000, 10000, 50000]) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), String(count)], { encoding: 'utf8', windowsHide: true });
    if (child.error || child.status !== 0) throw new Error(`Local benchmark failed for ${count}: ${child.stderr || child.error?.message}`);
    process.stdout.write(child.stdout);
  }
} else {
  if (![1000, 10000, 50000].includes(size)) throw new Error('Supported sizes: 1000, 10000, 50000.');
  const inputs = Array.from({ length: size }, (_, i) => ({ eventId: `terminal-${i}`, runId: 'synthetic-run',
    agentId: `agent-${i % 10}`, taskId: `task-${i % 10}`, type: 'complete', timestamp: 1,
    summary: 'Synthetic same-time terminal for a bounded local baseline.', cost: 0, data: { success: true } }));
  const bytes = Buffer.byteLength(inputs.map(input => JSON.stringify(input)).join('\n'));
  const start = performance.now(), trace = collectEvents(inputs), collected = performance.now();
  const report = analyzeCollectedTrace(trace), summarized = performance.now();
  const index = createTraceIndex(trace), indexed = performance.now();
  let rows = 0;
  for (let offset = 0; offset < size; offset += 100) rows += index.query({ runId: 'synthetic-run' }, { offset, limit: 100 }).events.length;
  const paged = performance.now();
  const ms = value => Number(value.toFixed(2));
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    cpu: cpus()[0]?.model, events: size, inputBytes: bytes, rows,
    terminalCount: report.runs[0].outcome.terminalEventIds.length,
    collectMs: ms(collected - start), summaryMs: ms(summarized - collected), indexMs: ms(indexed - summarized),
    pagesMs: ms(paged - indexed), totalMs: ms(paged - start),
    peakRssMiB: ms(process.resourceUsage().maxRSS / 1024), finalRssMiB: ms(process.memoryUsage().rss / 1024 / 1024) }));
}
