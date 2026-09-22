# Agent Trace Kit

Agent Trace Kit is a zero-dependency Node.js library and CLI for validating, organizing, and inspecting agent workflow traces stored as JSONL.

It turns raw execution events into a bounded, explicit model of runs, agent task instances, stages, parent relationships, tool interactions, outcomes, and recorded cost. Missing or ambiguous evidence stays visible instead of being guessed.

## What It Does

- Validates canonical workflow events and quarantines conflicting identities.
- Deduplicates replayed events without hiding conflicting payloads.
- Separates work by workspace, session, run, task, and agent scope.
- Groups events into stable execution stages.
- Builds parent and participation relationships from recorded evidence.
- Correlates tool calls and results, including out-of-order records.
- Reports incomplete runs, ambiguous outcomes, unmatched tool calls, and unknown cost.
- Provides exact filters and offset pagination for local trace inspection.

The toolkit reads local data only. It does not call a model, fetch URLs, run tools, replay workflows, or send telemetry.

## Quick Start

Requires Node.js 22 or newer. No dependency installation or build step is required.

```sh
git clone https://github.com/liulinlin718-netizen/agent-trace-kit.git
cd agent-trace-kit

node bin/agent-trace.js summary examples/research.jsonl
node bin/agent-trace.js validate examples/research.jsonl --json
node bin/agent-trace.js events examples/research.jsonl --run research-run --limit 20 --json
```

The bundled example is synthetic and demonstrates completed and interrupted runs, replayed events, parent relationships, and unmatched tool calls.

## Library Usage

```js
import {
  readTraceFile,
  createTraceIndex,
  modelForEvents,
  summarizeTrace,
} from './src/index.js';

const trace = await readTraceFile('./examples/research.jsonl');
const model = modelForEvents(trace.events);

const index = createTraceIndex(trace.events);
const page = index.query(
  { sessionId: 'demo-session', runId: 'research-run' },
  { offset: 0, limit: 100 },
);

console.log(model.runs);
console.log(page.events);

const report = summarizeTrace([
  {
    eventId: 'done',
    runId: 'example',
    type: 'complete',
    timestamp: 1770000000000,
    summary: 'Producer reports completion.',
    data: { success: true },
  },
]);
```

ESM exports and TypeScript declarations are included.

## Event Shape

Each JSONL line contains one JSON object:

```json
{
  "eventId": "event-4",
  "sessionId": "session-1",
  "runId": "run-1",
  "taskId": "research-1",
  "agentId": "researcher",
  "type": "agent_tool_call",
  "timestamp": 1770000000000,
  "summary": "Read a public page.",
  "toolName": "read_url",
  "callId": "call-7"
}
```

Required fields are `eventId`, `type`, and `summary`. Scope fields are case-sensitive opaque identifiers. Optional status, cost, result length, structured data, and agent snapshots are retained after bounded JSON validation.

Event identity is `(workspaceId, sessionId, runId, eventId)`. Conflicting records with the same identity are excluded and reported; neither first-write nor last-write silently wins.

## Tool Correlation

Tool calls are paired within the same run, task, agent, and tool scope:

1. `callId` is preferred and must identify exactly one call and one result.
2. Legacy records without `callId` pair only when one earlier anonymous call is open.
3. Overlapping anonymous calls, reused IDs, missing scope, and conflicting tool names remain ambiguous.

A returned result proves only that a result event exists. It does not prove that an external action succeeded or that returned content is correct.

## Relationships and Outcomes

Parent edges require a unique observed parent in the same run. Missing parents, conflicting claims, and cycles are reported instead of rendered as invented relationships. Participation edges mean run membership, not delegation.

Terminal outcomes come from explicit completion, failure, interruption, or cancellation events. A trace without a terminal event is `incomplete`; conflicting terminal evidence is `unknown`.

Recorded cost is read from explicit run-level fields. The toolkit does not infer provider billing, exchange rates, or missing charges.

## Public API

| Export | Purpose |
| --- | --- |
| `normalizeEvent` | Validate and project one event into the canonical shape. |
| `collectEvents` | Validate, deduplicate, quarantine conflicts, and sort events. |
| `summarizeTrace` | Build a complete trace report from raw records. |
| `readJsonl` / `readTraceFile` | Read strict UTF-8 JSONL with line and byte diagnostics. |
| `createTraceIndex` | Create an in-memory exact-filter index with pagination. |
| `modelForEvents` | Build runs, stages, agents, edges, tools, outcomes, and cost. |
| `stageForEvent` / `groupStages` | Map normalized events to the fixed stage vocabulary. |
| `pairTools` | Correlate tool calls and results conservatively. |
| `formatText` | Produce a terminal-safe summary. |

## CLI

```text
agent-trace summary <file> [filters] [--json]
agent-trace validate <file> [--json]
agent-trace events <file> [filters] [--offset N] [--limit N] [--json]
```

Filters include workspace, session, run, task, agent, and event type. The CLI reads only the supplied local file and writes to stdout/stderr.

Exit codes:

- `0`: structurally valid trace; producer-reported failed tasks may still be present.
- `2`: invalid or conflicting records were reported.
- `1`: usage, file access, file change, or resource-limit error.

## Safety and Limits

- Maximum 50,000 events and 32 MiB input by default.
- Strict UTF-8; malformed JSON is reported, not repaired.
- Symbolic links and non-regular files are rejected by the CLI reader.
- Unknown timestamps, identities, outcomes, and costs remain unknown.
- Logs may contain private data or secrets; review exports before sharing.
- JSONL is not tamper-proof audit evidence and producers can omit or misstate events.

This package is a trace analysis component, not an orchestrator, executor, sandbox, authorization system, fact checker, or quality benchmark.

## Tests

```sh
node --test test/*.test.js
```

Tests use synthetic local data and Node built-ins only.

## License

MIT. The design was extracted from TAgent's canonical workflow event and task-instance model and rewritten as a standalone package. See [NOTICE](./NOTICE) for provenance.
