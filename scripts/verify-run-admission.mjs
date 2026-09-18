import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tagent-admission-'));
const serveMode = process.argv.includes('--serve');
const stats = { modelCalls: 0, cancelledConnections: 0 };
let child, logs = '', fixtureError;
const owned = [];

const model = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    stats.modelCalls++;
    if (input.messages.some(message => String(message.content).includes('admission-hold'))) {
      response.on('close', () => { stats.cancelledConnections++; });
      return;
    }
    response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'local fixture authentication failure' } }));
  } catch (error) { fixtureError = error; response.writeHead(500).end(); }
});
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port;
}
const modelPort = await listen(model), reservation = createServer();
const port = await listen(reservation); await new Promise(done => reservation.close(done));
const base = `http://127.0.0.1:${port}`;

async function start() {
  child = spawn(process.execPath, [join(root, 'packages/tagent-server/dist/index.js')], {
    cwd: temporaryRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TAGENT_WORKSPACE_ROOT: temporaryRoot, TAGENT_ENV_FILE: '',
      PORT: String(port), TAGENT_HOST: '127.0.0.1', NODE_ENV: 'test', DATABASE_URL: '', REDIS_URL: '',
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', DEEPSEEK_API_KEY: 'local-admission-fixture-only',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, TAGENT_LLM_PROVIDER: 'deepseek', TAGENT_LLM_MODEL: 'deepseek-chat',
      TAGENT_LLM_TIMEOUT_MS: '300000', TAGENT_RUN_TIMEOUT_MS: '600000', TAGENT_MAX_ACTIVE_RUNS: '2', TAGENT_MAX_TASK_INPUT_BYTES: '1024',
      TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '', TAGENT_WEB_ORIGINS: 'http://127.0.0.1:3000', TAGENT_SEARCH_PROVIDER: '',
    },
  });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
  child.on('error', error => { fixtureError = error; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fixtureError) throw fixtureError;
    if (child.exitCode !== null) throw new Error(`Fixture exited: ${logs}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Readiness only. */ }
    await delay(100);
  }
  throw new Error(`Fixture startup timed out: ${logs}`);
}
async function stop() {
  const running = child; child = undefined;
  if (!running || running.exitCode !== null || running.signalCode !== null) return;
  const ended = once(running, 'exit'); running.kill(); await ended;
}
const request = (path, body, method = body === undefined ? 'GET' : 'POST') => fetch(base + path, {
  method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
});
async function json(path, body) { const response = await request(path, body); assert.ok(response.ok, path); return response.json(); }
const events = text => text.split(/\r?\n\r?\n/).map(block => {
  const lines = block.split(/\r?\n/), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
  return data ? { type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(), data: JSON.parse(data) } : undefined;
}).filter(Boolean);

async function openResponse(response) {
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let raw = '', session;
  while (!session) {
    const chunk = await reader.read(); assert.equal(chunk.done, false, 'SSE must acknowledge the run');
    raw += decoder.decode(chunk.value, { stream: true });
    const boundary = raw.lastIndexOf('\n\n');
    if (boundary >= 0) session = events(raw.slice(0, boundary + 2)).find(event => event.type === 'session')?.data;
  }
  const final = (async () => {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; raw += decoder.decode(chunk.value, { stream: true }); }
    raw += decoder.decode();
    const parsed = events(raw), terminal = parsed.filter(event => event.type === 'complete');
    assert.equal(terminal.length, 1); assert.equal(terminal[0].data.persisted, true);
    return { result: terminal[0].data, traces: parsed.filter(event => event.type === 'workflow_event').map(event => event.data) };
  })();
  void final.catch(() => {});
  const run = { ...session, final }; owned.push(run); return run;
}
async function openRun(workspaceId, sessionId, message = 'admission-hold: supplied notes only', endpoint = '/api/agent/orchestrate') {
  // An accepted SSE is intentionally longer-lived than ordinary HTTP metadata reads.
  return openResponse(await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, ...(sessionId ? { sessionId } : {}), message }) }));
}
async function cancel(run) {
  await json(`/api/runs/${run.runId}/cancel`, {});
  return run.final;
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; if (fixtureError) throw fixtureError; await delay(50); }
  throw new Error('Fixture condition timed out');
}

try {
  await start();
  const workspaceId = (await json('/api/workspaces')).workspaces[0].id;
  const session = async title => (await json(`/api/workspaces/${workspaceId}/sessions`, { title })).id;
  const a = await session('admission-A'), b = await session('admission-B');
  const first = await openRun(workspaceId, a);
  await until(() => stats.modelCalls === 1);
  const before = await json(`/api/workspaces/${workspaceId}/sessions/${a}`);
  const duplicates = await Promise.all(Array.from({ length: 12 }, (_, index) => request(index % 2 ? '/api/agent/run' : '/api/agent/orchestrate', {
    workspaceId, sessionId: a, message: `duplicate-${index}`,
  })));
  for (const response of duplicates) {
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json().then(body => [body.code, body.accepted]), ['RUN_ALREADY_ACTIVE', false]);
  }
  assert.equal(stats.modelCalls, 1);
  assert.deepEqual(await json(`/api/workspaces/${workspaceId}/sessions/${a}`), before, 'Rejected duplicates must not change messages or title');

  const second = await openRun(workspaceId, b, 'admission-hold: another workspace task', '/api/agent/run');
  await until(() => stats.modelCalls === 2);
  const sessionsBefore = await json('/api/workspaces');
  const full = await request('/api/agent/orchestrate', { workspaceId, message: 'must not create a session' });
  assert.equal(full.status, 429); assert.equal(full.headers.get('retry-after'), '5');
  assert.equal((await full.json()).accepted, false);
  assert.deepEqual(await json('/api/workspaces'), sessionsBefore, 'Capacity must be reserved before creating a new session');

  const malformed = [null, [], 1, 'text', {}, { message: '' }, { message: 123 }, { message: 'x', workspaceId: null },
    { message: 'x', sessionId: [] }, { message: 'x', mode: null }, { message: 'x', governanceTemplate: false }];
  for (const endpoint of ['/api/agent/run', '/api/agent/orchestrate']) {
    for (const body of malformed) {
      const response = await request(endpoint, body);
      assert.equal(response.status, 400); assert.equal((await response.json()).accepted, false);
    }
    for (const message of ['界'.repeat(342), 'x'.repeat(1021) + '🚀', 'x'.repeat(2 * 1024 * 1024)]) {
      const response = await request(endpoint, { workspaceId, message });
      assert.equal(response.status, 413); assert.equal((await response.json()).accepted, false);
    }
    for (const size of [2 * 1024 * 1024, 8 * 1024 * 1024]) {
      const raw = new TextEncoder().encode(JSON.stringify({ workspaceId, message: 'x'.repeat(size) }));
      let offset = 0;
      const body = new ReadableStream({ pull(controller) {
        if (offset === raw.length) return controller.close();
        const end = Math.min(offset + 16384, raw.length);
        controller.enqueue(raw.subarray(offset, end)); offset = end;
      } });
      const response = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
        body, duplex: 'half', signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 413);
      assert.equal(response.headers.get('connection'), 'close');
      assert.deepEqual(await response.json().then(result => [result.code, result.accepted]), ['BODY_TOO_LARGE', false]);
    }
  }
  assert.equal(stats.modelCalls, 2);
  assert.deepEqual(await json('/api/workspaces'), sessionsBefore);
  assert.equal((await cancel(first)).result.termination, 'cancelled');
  await until(() => stats.cancelledConnections >= 1);
  const accepted = await openRun(workspaceId, a, '界'.repeat(341) + 'a');
  const completed = await accepted.final;
  assert.equal(completed.result.success, false); // Fixture deliberately returns 401, not a model answer.
  assert.notEqual(accepted.runId, first.runId);
  assert.equal(stats.modelCalls, 3);
  await cancel(second);
  assert.equal((await json(`/api/workspaces/${workspaceId}/sessions/${a}`)).messages.length, 4);
  for (const endpoint of ['/api/agent/run', '/api/agent/orchestrate']) {
    const missing = await request(endpoint, { workspaceId, sessionId: 'missing-session', message: 'no side effects' });
    assert.equal(missing.status, 404); assert.equal((await missing.json()).accepted, false);
  }

  // Concurrent first messages must not create orphan sessions beyond capacity.
  const beforeBurst = (await json('/api/workspaces')).workspaces[0].sessions.length;
  const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(base + '/api/agent/orchestrate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId, message: 'admission-hold: burst fixture' }),
  })));
  assert.equal(responses.filter(response => response.status === 200).length, 2);
  for (const response of responses.filter(response => response.status !== 200)) {
    assert.equal(response.status, 429); assert.equal((await response.json()).accepted, false);
  }
  const admitted = [];
  for (const response of responses.filter(response => response.status === 200)) admitted.push(await openResponse(response));
  await until(() => stats.modelCalls === 5);
  assert.equal((await json('/api/workspaces')).workspaces[0].sessions.length, beforeBurst + 2);
  for (const run of admitted) await cancel(run);
  const saved = await json('/api/workspaces');
  await stop(); await start();
  assert.deepEqual(await json('/api/workspaces'), saved);
  assert.equal(stats.modelCalls, 5, 'Restart must not replay rejected or cancelled requests');
  if (fixtureError) throw fixtureError;
  console.log(JSON.stringify({ status: 'passed', fixtureOnly: true, duplicateRejections: 12, burstRejections: 10,
    malformedRejections: 22, oversizedRejections: 10, missingSessionRejections: 2, restart: true, stats, paidCalls: 0, userWrites: 0 }));

  if (serveMode) {
    const uiA = await session('admission-ui-active-A'), uiB = await session('admission-ui-active-B'), uiDraft = await session('admission-ui-draft');
    const runA = await openRun(workspaceId, uiA, 'admission-ui-active-A admission-hold');
    const runB = await openRun(workspaceId, uiB, 'admission-ui-active-B admission-hold');
    console.log(JSON.stringify({ fixtureOnly: true, base, workspaceId, uiA, uiB, uiDraft, runA: runA.runId, runB: runB.runId, temporaryRoot }));
    await new Promise(done => { process.stdin.on('data', chunk => { if (String(chunk).trim() === 'stop') done(); }); process.stdin.once('end', done); process.stdin.resume(); });
    process.stdin.pause();
  }
} catch (error) {
  console.error('Admission fixture server output:', logs);
  throw error;
} finally {
  if (child?.exitCode === null && child?.signalCode === null) {
    for (const run of owned) await cancel(run).catch(() => {});
  }
  await stop(); model.closeAllConnections(); await new Promise(done => model.close(done));
  const rel = relative(tmpdir(), temporaryRoot); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(temporaryRoot, { recursive: true, force: true });
}
