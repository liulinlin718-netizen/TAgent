import { collectEvents, compareText, ownedTrace, TraceInputError } from './events.js';

const fields = ['workspaceId', 'sessionId', 'runId', 'taskId', 'agentId', 'type'];
const maxCachedFilters = 8;

export function compileFilter(filter) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new TraceInputError('invalid_filter', 'Filter must be an object.');
  const descriptors = Object.getOwnPropertyDescriptors(filter);
  if (Object.getOwnPropertySymbols(filter).length) throw new TraceInputError('invalid_filter', 'Filter must have plain string fields.');
  const entries = [];
  for (const [key, descriptor] of Object.entries(descriptors)) {
    const value = descriptor.value;
    if (!('value' in descriptor) || !descriptor.enumerable || !fields.includes(key)
      || typeof value !== 'string' || !value.length || value.length > 256)
      throw new TraceInputError('invalid_filter', 'Only nonempty workspaceId/sessionId/runId/taskId/agentId/type filters are accepted.');
    entries.push([key, value]);
  }
  return entries.sort(([a], [b]) => compareText(a, b));
}

/** Private selector over owned events. Cache keys depend on values, never filter object identity. */
export function createEventSelector(events) {
  let indexes, all;
  const cache = new Map();
  return { selectEntries(entries) {
    if (!entries.length) return all ??= events.map((_, position) => position);
    const key = JSON.stringify(entries);
    if (cache.has(key)) {
      const matches = cache.get(key); cache.delete(key); cache.set(key, matches);
      return matches;
    }
    if (!indexes) {
      indexes = new Map(fields.map(field => [field, new Map()]));
      for (let position = 0; position < events.length; position++) {
        for (const field of fields) {
          const value = events[position][field]; if (value === undefined) continue;
          const index = indexes.get(field), list = index.get(value) || [];
          list.push(position); index.set(value, list);
        }
      }
    }
    const selected = entries.map(([field, value]) => indexes.get(field).get(value) || []).sort((a, b) => a.length - b.length);
    const matching = selected[0].filter(position => entries.every(([field, value]) => events[position][field] === value));
    cache.set(key, matching);
    if (cache.size > maxCachedFilters) cache.delete(cache.keys().next().value);
    return matching;
  } };
}

/** An in-memory projection, not a mutable log store or a security/tenancy boundary. */
export function createTraceIndex(inputs) {
  const collected = ownedTrace(inputs) ?? ownedTrace(collectEvents(inputs));
  const events = collected.events, selector = createEventSelector(events);
  return {
    counts: Object.freeze({ ...collected.counts }), issues: structuredClone(collected.issues),
    query(filter = {}, options = {}) {
      const entries = compileFilter(filter);
      const offset = options.offset ?? 0, limit = options.limit ?? 100;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new TraceInputError('invalid_page', 'Offset must be nonnegative and limit must be between 1 and 1000.');
      const matching = selector.selectEntries(entries);
      const page = matching.slice(offset, offset + limit).map(position => structuredClone(events[position]));
      return { events: page, total: matching.length, offset, nextOffset: offset + page.length < matching.length ? offset + page.length : null };
    },
  };
}
