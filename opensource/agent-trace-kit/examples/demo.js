import { fileURLToPath } from 'node:url';
import { readTraceFile, createTraceIndex, analyzeCollectedTrace } from '../src/index.js';

const loaded = await readTraceFile(fileURLToPath(new URL('./research.jsonl', import.meta.url)));
const index = createTraceIndex(loaded);
const page = index.query({ runId: 'research-run', taskId: 'research', agentId: 'researcher' });
const { runs, counts, issues } = analyzeCollectedTrace(loaded);
console.log(JSON.stringify({ counts, issues, eventsForResearchTask: page.events.length,
  runs: runs.map(run => ({ runId: run.scope.runId, outcome: run.outcome.status,
    recordedCost: run.recordedRunCost, parentEdges: run.edges.filter(edge => edge.kind === 'parent').length,
    tools: run.tools.map(tool => ({ callId: tool.callId, state: tool.state, durationMs: tool.durationMs })) })) }, null, 2));
