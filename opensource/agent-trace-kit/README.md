# Agent Trace Kit

A small offline JavaScript library and CLI for making agent execution logs understandable without pretending they prove more than they do.

Give it canonical `WorkflowEvent` records or a local UTF-8 JSONL file. It validates and deduplicates events, separates runs and agent task instances, groups execution stages, resolves recorded parent relationships, correlates tool calls, and reports missing or ambiguous evidence. No model, database, server, framework, install script or network connection is required.

This is a source project extracted from TAgent, not a published npm package or a complete observability product.

Source repository: [liulinlin718-netizen/agent-trace-kit](https://github.com/liulinlin718-netizen/agent-trace-kit).

## Run in One Minute

Requires Node.js 22 or newer. No dependency installation is needed. From this directory:

```sh
node bin/agent-trace.js summary examples/research.jsonl
node bin/agent-trace.js summary examples/research.jsonl --json
node bin/agent-trace.js events examples/research.jsonl --run research-run --agent researcher --limit 3 --json
node bin/agent-trace.js validate examples/research.jsonl --json
node examples/demo.js
node --test test/*.test.js
```

The synthetic demo has two runs: one completed report and one interruption. Two calls to the same search tool finish in reverse order. A replayed event is counted once. The completed run has one recorded parent edge and cost `0.003`; the interrupted run retains an unmatched tool call and **unknown** cost. The example values are fictional.

## Library

```js
import {
  readTraceFile, createTraceIndex, modelForEvents, summarizeTrace,
} from './src/index.js';

const trace = await readTraceFile('./examples/research.jsonl');
if (trace.issues.some(issue => issue.severity === 'error')) {
  console.error('Trace contains invalid or conflicting records:', trace.issues);
}

const index = createTraceIndex(trace.events);
const page = index.query(
  { sessionId: 'demo-session', runId: 'research-run', taskId: 'research' },
  { offset: 0, limit: 100 },
);

// File reader returns normalized, sorted, deduplicated records.
const model = modelForEvents(trace.events);
console.log(model.runs[0].agents, model.runs[0].edges);

// Raw in-memory records: validate and deduplicate before building the model.
const report = summarizeTrace([
  { eventId: 'done', runId: 'example', type: 'complete', timestamp: 1000,
    summary: 'Producer reports completion.', data: { success: true } },
]);
```

ESM exports and TypeScript declarations are included. There are no `@tagent/*` imports or runtime dependencies. The source folder can be used independently of the TAgent monorepo.

## Input Contract

One JSON object per line:

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

- Required: nonempty `eventId`, supported-shape `type` string, and string `summary`. Unknown event **types** are retained as `other`, not treated as success.
- `timestamp` is a nonnegative integer Unix time in milliseconds. Missing/null stays `null` with a warning. Invalid numbers are rejected. No time or identity is synthesized.
- Optional identity: `workspaceId`, `sessionId`, `runId`, `taskId`, `parentTaskId`, `agentId`, `parentAgentId`, `callId`. They are case-sensitive opaque strings, never paths or commands.
- Event identity is `(workspaceId, sessionId, runId, eventId)`. Explicitly provide scope when combining exports; absent scope is not assumed to mean the same real task.
- TAgent compatibility: identity fields, `toolName`/`tool`, `callId`/`toolCallId`, and `resultLength` can come from `data`. Conflicting root/data identities are rejected. Existing TAgent logs often lack `callId`; see correlation rules below.
- Optional `status`, `cost`, `resultLength`, `data` and `agentSnapshot` are retained after bounded JSON validation. Unknown top-level fields are excluded from the canonical projection; put extension metadata in `data`.
- `data.success` must be a boolean when present. A `complete` event without explicit success is completion with **unknown outcome**, not success. `error` by itself is not a terminal event.
- Cycles, accessors, non-plain objects, sparse arrays, non-JSON values and `__proto__`/`constructor`/`prototype` keys anywhere are rejected. Direct JavaScript callers must supply ordinary data objects, not adversarial Proxies.

### Deduplication and Ordering

Equivalent canonical records deduplicate regardless of JSON property order. Conflicting records with the same identity are **both excluded**, with an error. Neither the first nor the last version silently wins.

Events sort by scope, timestamp and event ID. Missing times sort last. Event-ID tie breaking is only a stable display order, not evidence of real temporal order. Source diagnostics retain input indices or file line numbers.

### Tool Correlation

1. Prefer `callId`. Pair exactly one call and one result in the same run/session/workspace, agent and task scope. Reused IDs or tool-name disagreement remain ambiguous. Out-of-order file records can still correlate; missing/backwards times give unknown duration.
2. Legacy records without `callId` may pair only when one earlier call is open for the same **run + task + agent + tool**. Every such association is marked `single_open_call` with a warning.
3. Overlapping anonymous calls are not FIFO-guessed. Missing/tied anonymous timestamps are ambiguous. Missing run/agent scope is unpaired. An explicit-ID call is never matched to an anonymous result.

`state: "returned"` means a corresponding result record exists. `resultOutcome` remains `unknown` unless the producer explicitly records success/failure. Neither field establishes that a webpage is factual, an email was sent, or an artifact is correct.

### Stages and Relationships

The fixed stage vocabulary is `understand`, `plan`, `dispatch`, `research`, `execute`, `tools`, `governance`, `verify`, `synthesize`, `handoff`, `complete`, `other`. Stages map from event type or `agent_stage.data.stage`, not guessed from free text. Stage groups are categories, not chronological dependency edges; consult event timestamps for sequence.

Agent nodes represent `(run scope, agentId, taskId)` execution instances. Governance-only mentions do not create phantom agents. An event without `taskId` stays in a separate unknown-task instance, never attached to a convenient existing task.

`parent` edges require a unique observed parent in the same run, using `parentTaskId` when supplied. Ambiguous/missing parents, conflicting parent claims and cycles are reported, not drawn as invented relationships. `participates` edges connect the run to its observed agents and mean **membership**, not delegation. This release does not infer parallelism, dependencies or a hidden Orchestrator.

### Outcomes and Cost

Explicit terminal types are `complete`, `run_failed`, `run_interrupted`, `run_cancelled`, and the corresponding `agent_complete`, `agent_failed`, `agent_cancelled`. No terminal record means `incomplete`, which can mean still running, interrupted, or missing telemetry. Conflicting incomparable terminal claims yield `unknown`.

`recordedRunCost` reads only the final run-level `cost` or `data.totalCost`, never adds tool/agent totals to it. Missing/conflicting cost stays `null`. Amounts retain the producer's units; no exchange rate, search charges, missing invoices or independent billing total is inferred.

## API Reference

| Export | Purpose |
| --- | --- |
| `normalizeEvent(unknown)` | Canonical event or `null`, plus diagnostics. |
| `collectEvents(iterable)` | Validate, deduplicate, quarantine conflicts, sort, count. |
| `summarizeTrace(iterable)` | Full validated run/stage/agent/relationship/tool summary. |
| `readJsonl(path, options?)` | Async records with original byte offsets, line numbers and diagnostics. |
| `readTraceFile(path, options?)` | Read a stable local file, then collect/deduplicate. |
| `createTraceIndex(iterable)` | In-memory indexes; exact filters and offset pagination. |
| `modelForEvents(events)` | Build a model from already normalized/sorted/deduplicated events. |
| `stageForEvent`, `groupStages`, `pairTools` | Helpers for normalized events. |
| `formatText(report)` | Terminal-friendly summary; escapes control and bidi characters. |

Index filters are `workspaceId`, `sessionId`, `runId`, `taskId`, `agentId`, `type`. They combine with AND. Queries return defensive event copies and `{total, offset, nextOffset}`; page limit is 1-1000. Indexes are ephemeral and do not write sidecar files. Filtering changes the visible evidence; the CLI labels filtered summaries explicitly.

## CLI Behavior

Use `node bin/agent-trace.js --help` for flags. All commands read only the explicitly supplied local file and write to stdout/stderr. `events` omits raw `data` and Agent snapshots; library consumers still receive them. The CLI never fetches URLs, discovers private files, runs commands contained in logs, creates an account or sends telemetry.

Exit codes:

- `0`: structurally valid trace; warnings and producer-reported failed tasks are allowed.
- `2`: invalid/conflicting records were reported. Valid records can still be inspected, but the input is not clean.
- `1`: usage, file access/change or resource-limit error.

UTF-8 is strict. A first-line BOM, CRLF, blank lines and valid final lines without a newline are supported. Malformed trailing JSON is reported rather than repaired. Symbolic links and non-regular files are rejected. Streaming consumers should wait for iteration to finish before treating a file as stable; the reader detects normal size/mtime changes but is not an atomic filesystem snapshot.

## Limits and Non-Goals

- Maximum 50,000 input events, 32 MiB per file/aggregate canonical input, 256 KiB per line/event, 8,192-character summary, 32,768-character JSON string, 12 levels of nesting and 4,096 fields per event. Reader options can lower, not raise, built-in limits.
- Log analysis only: no execution, orchestration, repair/replay, live-tail server, persistent database or web UI.
- Not a security sandbox, permission system, multi-tenant authorization boundary, secret scanner, independent fact checker or quality benchmark.
- Ordinary JSONL is **not tamper-proof audit evidence**. File metadata checks and deduplication are not signatures or proofs of provenance. A producer can lie or omit events.
- Logs and summaries can contain private data or secrets. Omitting raw tool arguments and escaping terminal controls is not comprehensive redaction. Review exports before sharing.
- Cancellation cannot undo external side effects. An unmatched call does not prove that its action did not happen.
- Use unique run/task/call IDs. Reusing task IDs for separate execution attempts can collapse their histories; emit a new task ID for each attempt.

## Development and Provenance

```sh
node --test test/*.test.js
```

Tests use only Node built-ins and synthetic material. Temporary files are created under `test/.tmp` in this project and removed afterward, not on the system drive. Coverage includes call interleaving, scope collisions, unknown timestamps, duplicate conflicts, malformed/hostile JSON, UTF-8, interrupted logs, index pagination, parent cycles, terminal escaping and a 3,000-node parent chain.

Derived from TAgent's canonical workflow event and task-instance trace design, rewritten as standalone ESM without TAgent services or dependencies. See [NOTICE](./NOTICE) for source design references and [LICENSE](./LICENSE) for MIT terms. No external repository, third-party runtime source or real conversation is bundled. The GitHub repository is the source distribution; npm package-name availability and npm publication remain outside this deliverable.
