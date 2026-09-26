export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export interface WorkflowEvent {
  eventId: string;
  type: string;
  summary: string;
  timestamp: number | null;
  workspaceId?: string;
  sessionId?: string;
  runId?: string;
  taskId?: string;
  parentTaskId?: string;
  agentId?: string;
  parentAgentId?: string;
  callId?: string;
  toolName?: string;
  resultLength?: number;
  cost?: number;
  status?: 'pending' | 'running' | 'complete' | 'failed' | 'blocked' | 'warning' | 'passed' | 'cancelled' | 'interrupted';
  data?: JsonObject;
  agentSnapshot?: JsonObject;
}
export interface SourceLocation { inputIndex?: number; line?: number; byteOffset?: number; byteLength?: number }
export interface Diagnostic extends SourceLocation {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  eventId?: string;
  nodeId?: string;
  runKey?: string;
  relatedSources?: SourceLocation[];
  claims?: { field: string; value: JsonValue }[];
}
export interface TraceCounts { input: number; accepted: number; invalid: number; duplicates: number; conflictingIdentities: number }
declare const collectedTraceBrand: unique symbol;
/** Library-owned batch. Each property read returns a defensive copy. Do not spread/clone it for composition. */
export interface CollectedTrace {
  readonly [collectedTraceBrand]: true;
  readonly events: WorkflowEvent[];
  readonly issues: Diagnostic[];
  readonly counts: TraceCounts;
  /** Original normalized records (including replays/conflicts) and source locations. May contain private data. */
  readonly evidence: { event: WorkflowEvent | null; source: SourceLocation }[];
}
export class TraceInputError extends Error { readonly code: string; constructor(code: string, message: string) }
export const LIMITS: Readonly<{ maxEvents: number; maxFileBytes: number; maxLineBytes: number; maxDepth: number; maxFields: number; maxString: number }>;
export function normalizeEvent(input: unknown): { event: WorkflowEvent | null; issues: Diagnostic[] };
export function collectEvents(inputs: Iterable<unknown>): CollectedTrace;
export type Stage = 'understand' | 'plan' | 'dispatch' | 'research' | 'execute' | 'tools' | 'governance' | 'verify' | 'synthesize' | 'handoff' | 'complete' | 'other';
export const STAGES: readonly Stage[];
export interface StageGroup { stage: Stage; eventIds: string[] }
/** The following helpers accept already-normalized events. */
export function stageForEvent(event: WorkflowEvent): Stage;
export function groupStages(events: readonly WorkflowEvent[]): StageGroup[];
export type Outcome = 'incomplete' | 'unknown' | 'succeeded' | 'failed' | 'interrupted';
export interface RecordedOutcome { status: Outcome; terminalEventIds: string[] }
export interface TimeRange { first: number | null; last: number | null; missing: number }
export interface ToolInteraction {
  id: string;
  agentId?: string;
  taskId?: string;
  toolName?: string;
  callId?: string;
  callEventId?: string;
  resultEventId?: string;
  state: 'returned' | 'pending' | 'orphan_result' | 'ambiguous';
  correlation: 'call_id' | 'single_open_call' | 'none';
  eventIds: string[];
  durationMs: number | null;
  resultOutcome: 'unknown' | 'succeeded' | 'failed';
}
export function pairTools(events: readonly WorkflowEvent[]): { interactions: ToolInteraction[]; issues: Diagnostic[] };
export interface AgentInstance {
  id: string;
  agentId: string;
  taskId: string | null;
  name: string;
  role: string | null;
  outcome: RecordedOutcome;
  eventIds: string[];
  stages: StageGroup[];
  time: TimeRange;
  parent: { parentAgentId?: string; parentTaskId?: string } | null;
  parentAmbiguous: boolean;
}
export interface Relationship { from: string; to: string; kind: 'parent' | 'participates' }
export interface RunSummary {
  key: string;
  scope: { workspaceId: string | null; sessionId: string | null; runId: string | null };
  scopeStatus: 'identified' | 'unassigned';
  eventIds: string[];
  outcome: RecordedOutcome;
  time: TimeRange;
  stages: StageGroup[];
  agents: AgentInstance[];
  edges: Relationship[];
  tools: ToolInteraction[];
  recordedRunCost: number | null;
  costEvidence: { eventId: string; field: 'cost' | 'data.totalCost'; value: number | null }[];
  governance: { eventId: string; agentId: string | null; taskId: string | null; summary: string; result: 'passed' | 'blocked' | 'warning' | 'unknown' }[];
}
export interface TraceSummary {
  version: 1;
  counts: TraceCounts;
  runs: RunSummary[];
  issues: Diagnostic[];
  note: string;
  filtered?: boolean;
  selectedEventCount?: number;
}
/** Use summarizeTrace for raw records. modelForEvents requires sorted, deduplicated, normalized events. */
export function modelForEvents(events: readonly WorkflowEvent[]): Pick<TraceSummary, 'runs' | 'issues'>;
export function summarizeTrace(inputs: Iterable<unknown>): TraceSummary;
/** Preserves original counts/issues; filtered reports explicitly represent partial evidence. */
export function analyzeCollectedTrace(trace: CollectedTrace, filter?: TraceFilter): TraceSummary;
export type TraceFilter = Partial<Pick<WorkflowEvent, 'workspaceId' | 'sessionId' | 'runId' | 'taskId' | 'agentId' | 'type'>>;
export interface TracePage { events: WorkflowEvent[]; total: number; offset: number; nextOffset: number | null }
export interface TraceIndex {
  readonly counts: Readonly<TraceCounts>;
  issues: Diagnostic[];
  query(filter?: TraceFilter, options?: { offset?: number; limit?: number }): TracePage;
}
export function createTraceIndex(inputs: Iterable<unknown> | CollectedTrace): TraceIndex;
export interface ReadOptions { maxEvents?: number; maxFileBytes?: number; maxLineBytes?: number }
export interface JsonlRecord { line: number; byteOffset: number; byteLength: number; event: WorkflowEvent | null; issues: Diagnostic[] }
export function readJsonl(path: string | URL, options?: ReadOptions): AsyncGenerator<JsonlRecord>;
export function readTraceFile(path: string | URL, options?: ReadOptions): Promise<CollectedTrace>;
export function analyzeTraceFile(path: string | URL, options?: ReadOptions & { filter?: TraceFilter }): Promise<TraceSummary>;
export function formatText(report: TraceSummary): string;
