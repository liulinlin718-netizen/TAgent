export const LIMITS = Object.freeze({ maxEvents: 50000, maxFileBytes: 32 * 1024 * 1024,
  maxLineBytes: 256 * 1024, maxDepth: 12, maxFields: 4096, maxString: 32768 });

const statuses = new Set(['pending', 'running', 'complete', 'failed', 'blocked', 'warning', 'passed', 'cancelled', 'interrupted']);
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const identifiers = ['workspaceId', 'sessionId', 'runId', 'taskId', 'parentTaskId', 'agentId', 'parentAgentId', 'callId'];
const controls = /[\u0000-\u001f\u007f-\u009f]/;

export class TraceInputError extends Error {
  constructor(code, message) { super(message); this.name = 'TraceInputError'; this.code = code; }
}

export function issue(code, severity, message, extra = {}) { return { code, severity, message, ...extra }; }

// Inspect descriptors before reading values: direct JS callers must not execute getters.
function jsonCopy(value, state, depth = 0) {
  if (++state.fields > LIMITS.maxFields || depth > LIMITS.maxDepth) throw new Error('structure_limit');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > LIMITS.maxString) throw new Error('string_limit');
    state.bytes += Buffer.byteLength(value, 'utf8');
    if (state.bytes > LIMITS.maxLineBytes) throw new Error('byte_limit');
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || state.seen.has(value)) throw new Error('non_json');
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (array && value.length > LIMITS.maxFields) throw new Error('structure_limit');
  if (!array && proto !== Object.prototype && proto !== null) throw new Error('non_plain_object');
  state.seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value), result = array ? [] : {};
  if (Object.getOwnPropertySymbols(value).length) throw new Error('non_json');
  for (const key of Object.keys(descriptors)) {
    if (array && key === 'length') continue;
    const descriptor = descriptors[key];
    state.bytes += Buffer.byteLength(key, 'utf8') + 4;
    if (state.bytes > LIMITS.maxLineBytes) throw new Error('byte_limit');
    if (forbidden.has(key) || key.length > 256 || controls.test(key)) throw new Error('unsafe_key');
    if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('accessor_or_hidden_field');
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new Error('non_json_array');
    result[key] = jsonCopy(descriptor.value, state, depth + 1);
  }
  if (array && Object.keys(descriptors).length - 1 !== value.length) throw new Error('sparse_array');
  state.seen.delete(value);
  return result;
}

function id(value) { return typeof value === 'string' && !!value.trim() && value.length <= 256 && !controls.test(value); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function field(input, name, alias, errors) {
  if (alias && input.data?.[name] !== undefined && input.data?.[alias] !== undefined && input.data[name] !== input.data[alias]) errors.push(`conflicting_${name}`);
  const primary = input[name], fallback = input.data?.[name] ?? (alias ? input.data?.[alias] : undefined);
  if (primary !== undefined && fallback !== undefined && primary !== fallback) errors.push(`conflicting_${name}`);
  return primary ?? fallback;
}

/** Missing timestamps stay null. Missing identity is rejected, never randomly synthesized. */
export function normalizeEvent(input) {
  const issues = [];
  let raw;
  try { raw = jsonCopy(input, { fields: 0, bytes: 0, seen: new Set() }); }
  catch { return { event: null, issues: [issue('unsafe_event', 'error', 'Event must be bounded plain JSON without unsafe keys, cycles or accessors.')] }; }
  if (!record(raw)) return { event: null, issues: [issue('invalid_event', 'error', 'Event must be an object.')] };
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > LIMITS.maxLineBytes)
    return { event: null, issues: [issue('event_too_large', 'error', 'Event exceeds the byte limit.')] };
  const errors = [];
  if (!id(raw.eventId)) errors.push('eventId');
  if (typeof raw.type !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/.test(raw.type)) errors.push('type');
  if (typeof raw.summary !== 'string' || raw.summary.length > 8192) errors.push('summary');
  if (raw.data !== undefined && !record(raw.data)) errors.push('data');
  if (raw.agentSnapshot !== undefined && !record(raw.agentSnapshot)) errors.push('agentSnapshot');
  if (raw.status !== undefined && !statuses.has(raw.status)) errors.push('status');
  if (raw.timestamp !== undefined && raw.timestamp !== null
    && (!Number.isSafeInteger(raw.timestamp) || raw.timestamp < 0 || raw.timestamp > 8640000000000000)) errors.push('timestamp');
  const event = { eventId: raw.eventId, type: raw.type, summary: raw.summary, timestamp: raw.timestamp ?? null };
  for (const name of identifiers) {
    const value = field(raw, name, name === 'callId' ? 'toolCallId' : undefined, errors);
    if (value === null && name.startsWith('parent')) continue;
    if (value !== undefined) { if (!id(value)) errors.push(name); else event[name] = value; }
  }
  const tool = field(raw, 'toolName', 'tool', errors), length = field(raw, 'resultLength', undefined, errors);
  if (tool !== undefined) { if (!id(tool)) errors.push('toolName'); else event.toolName = tool; }
  if (length !== undefined) { if (!Number.isSafeInteger(length) || length < 0) errors.push('resultLength'); else event.resultLength = length; }
  if (raw.cost !== undefined) { if (typeof raw.cost !== 'number' || !Number.isFinite(raw.cost) || raw.cost < 0) errors.push('cost'); else event.cost = raw.cost; }
  if (raw.data?.success !== undefined && typeof raw.data.success !== 'boolean') errors.push('data.success');
  if (raw.data?.isError !== undefined && typeof raw.data.isError !== 'boolean') errors.push('data.isError');
  if (raw.status !== undefined) event.status = raw.status;
  if (raw.data !== undefined) event.data = raw.data;
  if (raw.agentSnapshot !== undefined) event.agentSnapshot = raw.agentSnapshot;
  if (errors.length) return { event: null, issues: [issue('invalid_event', 'error', `Invalid or conflicting fields: ${[...new Set(errors)].join(', ')}.`)] };
  if (event.timestamp === null) issues.push(issue('missing_timestamp', 'warning', 'Timestamp is unknown; no wall-clock time was invented.', { eventId: event.eventId }));
  if (!event.runId) issues.push(issue('missing_run_id', 'warning', 'Run identity is unknown; relationships, tool pairs and aggregate outcomes cannot be established.', { eventId: event.eventId }));
  return { event, issues };
}

export function scopeKey(event) { return JSON.stringify([event.workspaceId ?? null, event.sessionId ?? null, event.runId ?? null]); }
export function eventKey(event) { return JSON.stringify([scopeKey(event), event.eventId]); }
export const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function compareEvents(a, b) {
  return compareText(scopeKey(a), scopeKey(b)) || (a.timestamp === b.timestamp ? 0 : a.timestamp === null ? 1 : b.timestamp === null ? -1 : a.timestamp - b.timestamp)
    || compareText(a.eventId, b.eventId);
}

export function stableJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  return `{${Object.keys(value).sort(compareText).map(key => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
}

// Only library-owned batches may bypass normalization. Public views always return copies.
const batches = new WeakMap();
export function ownedTrace(value) { return batches.get(value); }

function exposeTrace(snapshot) {
  const view = {};
  for (const key of ['events', 'issues', 'counts', 'evidence']) {
    Object.defineProperty(view, key, { enumerable: true, get: () => structuredClone(snapshot[key]) });
  }
  batches.set(view, snapshot);
  return Object.freeze(view);
}

function semanticEvent(event) {
  const projected = { ...event };
  if (event.data) {
    const data = { ...event.data };
    for (const name of [...identifiers, 'toolName', 'resultLength']) {
      if (data[name] === event[name] || (name.startsWith('parent') && data[name] === null && event[name] === undefined)) delete data[name];
    }
    if (data.tool === event.toolName) delete data.tool;
    if (data.toolCallId === event.callId) delete data.toolCallId;
    if (Object.keys(data).length) projected.data = data; else delete projected.data;
  }
  return projected;
}

/** Internal collector: accepts freshly normalized records, never caller-controlled batches. */
export function createCollector() {
  const found = new Map(), signatures = new Map(), conflicts = new Set(), issues = [];
  const evidence = [], firstSources = new Map();
  let inputCount = 0, invalidCount = 0, duplicateCount = 0, bytes = 0;
  return { add(normalized, location = {}) {
    if (++inputCount > LIMITS.maxEvents) throw new TraceInputError('event_limit', 'Trace exceeds the event limit.');
    const source = { ...location, inputIndex: inputCount - 1 };
    const raw = normalized.event;
    evidence.push({ source, event: raw });
    issues.push(...normalized.issues.map(item => ({ ...item, ...source,
      ...(raw ? { eventId: raw.eventId, runKey: scopeKey(raw) } : {}) })));
    if (!raw) { invalidCount++; return; }
    // Account for original metadata too, not just the smaller semantic fingerprint.
    bytes += Buffer.byteLength(JSON.stringify(raw), 'utf8');
    if (bytes > LIMITS.maxFileBytes) throw new TraceInputError('byte_limit', 'Trace exceeds the aggregate event byte limit.');
    const event = semanticEvent(raw), key = eventKey(event), signature = stableJSON(event);
    const variants = signatures.get(key);
    if (!variants) {
      signatures.set(key, new Set([signature])); found.set(key, event); firstSources.set(key, source);
    } else if (variants.has(signature)) duplicateCount++;
    else {
      variants.add(signature);
      if (!conflicts.has(key)) {
        conflicts.add(key); found.delete(key);
        issues.push(issue('conflicting_duplicate', 'error', 'Conflicting versions of the same event identity were excluded.',
          { eventId: event.eventId, runKey: scopeKey(event), ...source, relatedSources: [firstSources.get(key)] }));
      }
    }
  }, finish() {
    const events = [...found.values()].sort(compareEvents);
    return exposeTrace({ events, issues, evidence, counts: { input: inputCount, accepted: events.length, invalid: invalidCount,
      duplicates: duplicateCount, conflictingIdentities: conflicts.size } });
  } };
}

/** Conflicting identities quarantine all versions; neither first nor last version wins. */
export function collectEvents(inputs) {
  if (!inputs || typeof inputs[Symbol.iterator] !== 'function') throw new TraceInputError('invalid_trace', 'Expected an iterable of raw events.');
  const collector = createCollector();
  for (const input of inputs) {
    collector.add(normalizeEvent(input));
  }
  return collector.finish();
}
