import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tagent-provider-'));
const serveMode = process.argv.includes('--serve');
const privateMarker = 'fixture-private-provider-body';
const artifact = '## Meeting notes\n\nThe team approved the supplied draft. The owner will confirm the delivery date; no external actions were taken.';
const scenarios = [
  { name: 'authentication', status: 401, code: 'authentication' },
  { name: 'quota', status: 429, errorType: 'insufficient_quota', code: 'quota' },
  { name: 'rate-limit', status: 429, code: 'rate_limit' },
  { name: 'upstream', status: 503, code: 'upstream' },
  { name: 'tool-protocol', status: 400, detail: 'tool_use requires tool_result', code: 'tool_protocol' },
  { name: 'malformed-json', code: 'invalid_response' },
  { name: 'stalled-body', code: 'timeout' },
  { name: 'connection-reset', code: 'connection' },
  { name: 'synthesis-failure', status: 503, code: 'upstream', after: 3 },
];
let current, providerName, calls = 0, totalCalls = 0, child, logs = '', fixtureError;
const results = [];

// The real SDK and production backend talk only to this loopback fixture.
const modelServer = createServer(async (request, response) => {
  try {
    assert.ok(current, 'A scenario must be selected before any model request');
    assert.equal(request.method, 'POST');
    assert.equal(request.url, providerName === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    assert.equal(input.stream, undefined, 'Task runtime uses the non-streaming model API');
    calls++; totalCalls++;
    if (calls <= (current.after || 0)) {
      const content = calls === 1
        ? JSON.stringify([{ id: 't1', agentRole: 'document', objective: 'Summarize only the supplied meeting notes. Do not browse.' },
          { id: 't2', agentRole: 'project', objective: 'List actions from the supplied meeting notes. Do not browse.', dependsOn: ['t1'] }])
        : artifact;
      const value = providerName === 'anthropic'
        ? { id: 'fixture', type: 'message', role: 'assistant', model: input.model,
          content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 30 } }
        : { id: 'fixture', object: 'chat.completion', model: input.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    } else if (current.name === 'stalled-body') {
      const scenario = current;
      response.on('close', () => { scenario.closed = true; });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"id":"unfinished",');
    } else if (current.name === 'connection-reset') {
      request.socket.destroy();
    } else if (current.name === 'malformed-json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{invalid-json');
    } else {
      response.writeHead(current.status, { 'content-type': 'application/json' }).end(JSON.stringify({
        error: { type: current.errorType || 'fixture_error', code: current.errorType,
          message: `${current.detail || 'provider rejected request'} ${privateMarker}` },
      }));
    }
  } catch (error) {
    fixtureError = error;
    response.writeHead(500).end();
  }
});

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return server.address().port;
}
const modelPort = await listen(modelServer);
const reservation = createServer();
const port = await listen(reservation);
await new Promise(done => reservation.close(done));
const base = `http://127.0.0.1:${port}`;

async function start() {
  logs = '';
  child = spawn(process.execPath, [join(root, 'packages/tagent-server/dist/index.js')], {
    cwd: temporaryRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TAGENT_WORKSPACE_ROOT: temporaryRoot, TAGENT_ENV_FILE: '',
      PORT: String(port), TAGENT_HOST: '127.0.0.1', NODE_ENV: 'test', DATABASE_URL: '', REDIS_URL: '',
      DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
      [`${providerName.toUpperCase()}_API_KEY`]: 'local-provider-fixture-only',
      [`${providerName.toUpperCase()}_BASE_URL`]: `http://127.0.0.1:${modelPort}${providerName === 'anthropic' ? '' : '/v1'}`,
      TAGENT_LLM_PROVIDER: providerName, TAGENT_LLM_MODEL: providerName === 'anthropic' ? 'claude-sonnet-4-20250514' : 'deepseek-chat',
      TAGENT_LLM_TIMEOUT_MS: '1000', TAGENT_RUN_TIMEOUT_MS: '10000',
      // This suite intentionally sends dozens of failures rapidly; rate admission has a separate real-HTTP gate.
      TAGENT_API_EXTERNAL_PER_MINUTE: '100',
      TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '', TAGENT_WEB_ORIGINS: 'http://127.0.0.1:3000', TAGENT_SEARCH_PROVIDER: '',
    },
  });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
  child.on('error', error => { fixtureError = error; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fixtureError) throw fixtureError;
    if (child.exitCode !== null) throw new Error(`Fixture backend exited: ${logs}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; }
    catch { /* Readiness only; this never calls a model. */ }
    await delay(100);
  }
  throw new Error(`Fixture startup timed out: ${logs}`);
}

async function stop() {
  const running = child;
  child = undefined;
  if (!running || running.exitCode !== null || running.signalCode !== null) return;
  const ended = once(running, 'exit'); running.kill(); await ended;
}

async function json(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, path);
  return response.json();
}

async function assertNoPrivateBodies(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertNoPrivateBodies(path);
    else if (entry.isFile()) assert.ok(!(await readFile(path, 'utf8')).includes(privateMarker), `Raw provider body was persisted to ${entry.name}`);
  }
}

try {
  for (providerName of ['deepseek', 'anthropic']) {
    await start();
    const workspaceId = (await json('/api/workspaces')).workspaces[0].id;
    for (const endpoint of ['/api/agent/orchestrate', '/api/agent/run']) {
      for (const scenario of scenarios) {
        current = { ...scenario }; calls = 0;
        const prompt = `provider-fixture-${providerName}-${scenario.name}: Only summarize these supplied meeting notes, without any tools or browsing: the team approved the draft; delivery date is unconfirmed. 中文编码 🚀`;
        const began = Date.now();
        const response = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId, message: prompt }), signal: AbortSignal.timeout(15000) });
        assert.equal(response.status, 200);
        const text = await response.text();
        if (fixtureError) throw fixtureError;
        assert.ok(Date.now() - began < 10000, `${scenario.name}: failed task must settle before the run deadline`);
        assert.ok(!text.includes(privateMarker), 'Raw provider response must not enter the SSE or output');
        const events = text.split(/\r?\n\r?\n/).map(block => {
          const lines = block.split(/\r?\n/);
          const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          return data ? { type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(), data: JSON.parse(data) } : undefined;
        }).filter(Boolean);
        const complete = events.filter(event => event.type === 'complete');
        assert.equal(complete.length, 1, `${scenario.name}: exactly one final result`);
        const final = complete[0].data;
        assert.equal(final.success, false);
        assert.equal(final.persisted, true);
        assert.ok(final.output.trim());
        assert.equal(final.termination, undefined, 'A provider failure is not user cancellation or total run timeout');
        assert.equal(calls, (scenario.after || 0) + 1, 'A provider failure must not cause hidden SDK retries');
        const traces = events.filter(event => event.type === 'workflow_event').map(event => event.data);
        assert.equal(traces.filter(trace => trace.type === 'complete').length, 1);
        assert.equal(traces.at(-1).status, 'failed');
        assert.ok(traces.every(trace => trace.runId === final.runId && trace.sessionId === final.sessionId));
        assert.ok(JSON.stringify(traces).includes(`[${scenario.code}`), 'Trace must retain the safe actionable error');
        if (scenario.after) {
          assert.ok(final.output.includes(artifact), 'Failed synthesis must preserve completed work');
          assert.ok(final.output.includes(`[${scenario.code}`), 'The final report must explain why synthesis failed');
          assert.deepEqual(final.totalTokens, { input: 300, output: 90 });
          assert.ok(final.totalCost > 0, 'Previously received usage must not be reset on a later error');
        } else {
          assert.ok(final.output.includes(`[${scenario.code}`), 'Early failures must show the actionable cause');
          assert.deepEqual(final.totalTokens, { input: 0, output: 0 });
          assert.equal(final.totalCost, 0, 'Do not invent usage for an incomplete response');
        }
        if (scenario.name === 'stalled-body') {
          for (let attempt = 0; attempt < 20 && !current.closed; attempt++) await delay(25);
          assert.equal(current.closed, true, 'Timed-out provider connection must be released');
        }
        const sessionPath = `/api/workspaces/${workspaceId}/sessions/${final.sessionId}`;
        const saved = await json(sessionPath);
        assert.equal(saved.messages.length, 2);
        assert.equal(saved.messages[0].content, prompt);
        assert.equal(saved.messages[1].content, final.output);
        assert.deepEqual(saved.messages[1].traces, traces);
        assert.deepEqual(saved.messages[1].tokens, final.totalTokens);
        assert.equal(saved.messages[1].run.status, 'finished');
        assert.deepEqual(await json(`/api/runs/${final.runId}`).then(run => [run.status, run.persisted]), ['finished', true]);
        results.push({ provider: providerName, scenario: scenario.name, endpoint, sessionPath, saved });
      }
    }
    const skillsBefore = await json('/api/skills');
    for (const scenario of scenarios.filter(item => !item.after)) {
      current = { ...scenario }; calls = 0;
      const response = await fetch(base + '/api/skills/suggest', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskDescription: 'Prepare a skill draft using supplied meeting notes.' }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, scenario.code === 'timeout' ? 504 : 502, 'Provider auth errors must not trigger a TAgent login expiry');
      const body = await response.json();
      assert.equal(body.code, `model_${scenario.code}`);
      assert.ok(body.error.includes(`[${scenario.code}`));
      assert.equal(body.draft, undefined);
      assert.ok(!JSON.stringify(body).includes(privateMarker));
      assert.equal(calls, 1);
    }
    assert.deepEqual(await json('/api/skills'), skillsBefore, 'Failed suggestions never create or save a skill');
    await stop(); await start();
    const before = totalCalls;
    for (const result of results) assert.deepEqual(await json(result.sessionPath), result.saved, 'Restart must restore the same messages and trace');
    assert.equal(totalCalls, before, 'Restart must not rerun failed model requests');
    assert.ok(!logs.includes(privateMarker));
    await stop();
  }
  await assertNoPrivateBodies(temporaryRoot);
  console.log(JSON.stringify({ status: 'passed', fixtureOnly: true, cases: results.length, localModelCalls: totalCalls,
    managementCases: 16, providers: ['deepseek', 'anthropic'], restart: true, providerTimeoutMs: 1000, userWrites: 0, paidCalls: 0 }));
  if (serveMode) {
    providerName = 'deepseek'; current = { ...scenarios[0] }; calls = 0;
    await start();
    console.log(JSON.stringify({ fixtureOnly: true, base, temporaryRoot, command: 'Send stop on stdin to clean up.' }));
    await new Promise(done => {
      const onData = chunk => { if (String(chunk).trim() === 'stop') done(); };
      process.stdin.on('data', onData); process.stdin.once('end', done);
      process.stdin.resume();
    });
    process.stdin.pause();
    if (fixtureError) throw fixtureError;
  }
} finally {
  await stop();
  modelServer.closeAllConnections();
  await new Promise(done => modelServer.close(done));
  const rel = relative(tmpdir(), temporaryRoot);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(temporaryRoot, { recursive: true, force: true });
}
