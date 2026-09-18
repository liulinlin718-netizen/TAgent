import { collectEvents, TraceInputError } from './events.js';

const fields = ['workspaceId', 'sessionId', 'runId', 'taskId', 'agentId', 'type'];

/** An in-memory projection, not a mutable log store or a security/tenancy boundary. */
export function createTraceIndex(inputs) {
  const collected = collectEvents(inputs), events = collected.events;
  const indexes = new Map(fields.map(field => [field, new Map()]));
  for (let position = 0; position < events.length; position++) {
    for (const field of fields) {
      const value = events[position][field]; if (value === undefined) continue;
      const index = indexes.get(field), list = index.get(value) || [];
      list.push(position); index.set(value, list);
    }
  }
  return {
    counts: Object.freeze({ ...collected.counts }), issues: structuredClone(collected.issues),
    query(filter = {}, options = {}) {
      if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new TraceInputError('invalid_filter', 'Filter must be an object.');
      const offset = options.offset ?? 0, limit = options.limit ?? 100;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new TraceInputError('invalid_page', 'Offset must be nonnegative and limit must be between 1 and 1000.');
      const selected = [];
      for (const [key, value] of Object.entries(filter)) {
        if (!fields.includes(key) || typeof value !== 'string' || !value.length || value.length > 256)
          throw new TraceInputError('invalid_filter', 'Only nonempty workspaceId/sessionId/runId/taskId/agentId/type filters are accepted.');
        selected.push(indexes.get(key).get(value) || []);
      }
      selected.sort((a, b) => a.length - b.length);
      const base = selected.length ? selected[0] : events.map((_, position) => position);
      const matching = base.filter(position => Object.entries(filter).every(([key, value]) => events[position][key] === value));
      const page = matching.slice(offset, offset + limit).map(position => structuredClone(events[position]));
      return { events: page, total: matching.length, offset, nextOffset: offset + page.length < matching.length ? offset + page.length : null };
    },
  };
}
