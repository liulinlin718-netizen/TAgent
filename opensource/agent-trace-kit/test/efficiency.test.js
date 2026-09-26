import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectEvents, createTraceIndex, modelForEvents } from '../src/index.js';
import { compileFilter, createEventSelector } from '../src/indexing.js';
import { event } from './helpers.js';

test('matching positions are reused across pages and the filter cache evicts after eight entries', () => {
  let reads = 0;
  const records = Array.from({ length: 1000 }, (_, i) => ({
    get runId() { reads++; return 'r'; },
    get agentId() { reads++; return `a-${i % 10}`; },
  }));
  // Internal selector instrumentation, not raw-input validation bypass in the public API.
  const selector = createEventSelector(records), firstFilter = compileFilter({ agentId: 'a-0', runId: 'r' });
  const first = selector.selectEntries(firstFilter), initialReads = reads;
  assert.equal(first.length, 100);
  for (let page = 0; page < 10; page++) {
    assert.equal(selector.selectEntries(compileFilter({ runId: 'r', agentId: 'a-0' })), first);
  }
  assert.equal(reads, initialReads);
  for (let i = 1; i <= 8; i++) selector.selectEntries(compileFilter({ runId: 'r', agentId: `a-${i}` }));
  const before = reads;
  assert.deepEqual(selector.selectEntries(firstFilter), first);
  assert.ok(reads > before, 'Least recently used filter must be evicted, not cached without a bound.');
});

test('filter validation is once per page and rejects accessors without invoking them', () => {
  const trace = collectEvents(Array.from({ length: 1000 }, (_, i) => event(`e-${i}`, 'custom')));
  const index = createTraceIndex(trace), entries = Object.entries;
  let entriesCalls = 0;
  Object.entries = value => { entriesCalls++; return entries(value); };
  try {
    for (let offset = 0; offset < 1000; offset += 100) {
      assert.equal(index.query({ runId: 'run-1' }, { offset, limit: 100 }).events.length, 100);
    }
    assert.equal(entriesCalls, 10);
  } finally { Object.entries = entries; }
  let invoked = false;
  assert.throws(() => index.query({ get runId() { invoked = true; return 'run-1'; } }), /filters/);
  assert.equal(invoked, false);
  const filter = { runId: 'run-1' };
  assert.equal(index.query(filter).total, 1000);
  filter.runId = 'other'; assert.equal(index.query(filter).total, 0);
});

test('terminal membership uses linear Set probes, not repeated terminal-array scans', () => {
  const probes = [];
  for (const size of [1000, 2000]) {
    const events = collectEvents(Array.from({ length: size }, (_, i) => event(`terminal-${i}`, 'complete', { cost: 0 }))).events;
    const has = Set.prototype.has, includes = Array.prototype.includes;
    let memberships = 0, arrayScans = 0;
    Set.prototype.has = function(value) {
      if (typeof value === 'string' && value.startsWith('terminal-')) memberships++;
      return has.call(this, value);
    };
    Array.prototype.includes = function(value, ...args) {
      if (typeof value === 'string' && value.startsWith('terminal-')) arrayScans++;
      return includes.call(this, value, ...args);
    };
    let model;
    try { model = modelForEvents(events); }
    finally { Set.prototype.has = has; Array.prototype.includes = includes; }
    assert.equal(arrayScans, 0); assert.equal(memberships, size);
    assert.equal(model.runs[0].recordedRunCost, 0);
    assert.equal(model.runs[0].outcome.terminalEventIds.length, size);
    probes.push(memberships);
  }
  assert.equal(probes[1], 2 * probes[0]);
});
