import { normalizeEvent, summarizeTrace, readTraceFile, readJsonl, createTraceIndex, modelForEvents, pairTools,
  stageForEvent, groupStages, formatText, TraceInputError, collectEvents, analyzeCollectedTrace, analyzeTraceFile,
  type WorkflowEvent, type TraceSummary } from '../src/index.js';

// Node may discover this file as a runtime test. Type examples must never execute.
function checkPublicTypes() {
  const normalized = normalizeEvent({ eventId: 'x', type: 'complete', summary: 'Fixture.', timestamp: 1 });
  const events: WorkflowEvent[] = normalized.event ? [normalized.event] : [];
  const report: TraceSummary = summarizeTrace(events);
  const text: string = formatText(report);
  const index = createTraceIndex(events);
  const page = index.query({ runId: 'run', agentId: 'agent' }, { limit: 5 });
  const duration: number | null | undefined = pairTools(page.events).interactions[0]?.durationMs;
  const groups = groupStages(events);
  const model = modelForEvents(events);
  if (events[0]) stageForEvent(events[0]);
  const reader: Promise<unknown> = readTraceFile('not-executed.jsonl');
  const stream: AsyncGenerator<unknown> = readJsonl(new URL('file:///not-executed.jsonl'));
  const error: string = new TraceInputError('fixture', 'Fixture.').code;
  void [text, duration, groups, model, reader, stream, error];

  // @ts-expect-error Filters are an explicit public contract.
  index.query({ command: 'anything' });
  // @ts-expect-error Timestamps are numbers or null, never locale strings.
  const wrong: WorkflowEvent = { eventId: 'x', type: 'complete', summary: 'Fixture.', timestamp: 'yesterday' };
  void wrong;

  const batch = collectEvents(events);
  const composed: TraceSummary = analyzeCollectedTrace(batch, { runId: 'run' });
  const batchIndex = createTraceIndex(batch);
  const fileSummary: Promise<TraceSummary> = analyzeTraceFile('not-executed.jsonl', { maxEvents: 100, filter: { agentId: 'agent' } });
  const offset: number | undefined = batch.evidence[0]?.source.byteOffset;
  // @ts-expect-error Plain objects cannot impersonate validated batches.
  analyzeCollectedTrace({ events, counts: batch.counts, issues: [], evidence: [] });
  // @ts-expect-error File filters have the same explicit contract as index filters.
  analyzeTraceFile('not-executed.jsonl', { filter: { command: 'anything' } });
  void [composed, batchIndex, fileSummary, offset];
}

void checkPublicTypes;
