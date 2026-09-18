import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, rmdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tagent-model-connection-'));
const serveMode = process.argv.includes('--serve');
const nonce = randomUUID(), stopPath = `/stop-${nonce}`, resetPath = `/reset-${nonce}`, repairPath = `/repair-${nonce}`;
let scenario = 'success', providerName = 'deepseek', workspace, child, logs = '', calls = 0, fixtureError, stopFixture, brokenStorage = false;
const stopped = new Promise(resolve => { stopFixture = resolve; });

function storagePaths() {
  const file = resolve(workspace, '.tagent/data/model-checks.json');
  const rel = relative(temporaryRoot, file);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Storage fault must stay inside the owned fixture');
  return { file, backup: file + '.before-fault' };
}
async function breakStorage() {
  const { file, backup } = storagePaths();
  await rename(file, backup); await mkdir(file); brokenStorage = true;
}
async function repairStorage() {
  if (!brokenStorage) return;
  const { file, backup } = storagePaths();
  await rmdir(file); await rename(backup, file); brokenStorage = false;
}

const model = createServer(async (request, response) => {
  try {
    if (request.method === 'POST' && request.url === stopPath) { response.end('stopping'); stopFixture(); return; }
    if (request.method === 'GET' && request.url === `/stats-${nonce}`) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ calls })); return; }
    if (serveMode && request.method === 'POST' && request.url === repairPath) { await repairStorage(); response.end('repaired'); return; }
    if (serveMode && request.method === 'POST' && request.url === resetPath) {
      let text = ''; for await (const chunk of request) text += chunk;
      const next = JSON.parse(text).scenario;
      assert.ok(['success', 'authentication', 'stalled', 'final-storage'].includes(next));
      assert.ok(!(await json('/api/model-connection')).activeId, 'Cannot reset an active check');
      await stop(); await repairStorage(); scenario = next;
      workspace = await mkdtemp(join(temporaryRoot, 'ui-'));
      await start(); response.end('ready'); return;
    }
    assert.equal(request.method, 'POST');
    assert.equal(request.url, providerName === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    assert.equal(input.max_tokens, 64);
    assert.equal(input.tools, undefined);
    assert.equal(input.messages.length, 1);
    const content = input.messages[0].content;
    assert.ok(JSON.stringify(content).includes('Reply with exactly TAGENT_CONNECTION_OK.'));
    assert.ok(!raw.includes('private-user-document'));
    calls++;
    if (scenario === 'authentication') {
      response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'private-fixture-credential-body' } }));
    } else if (scenario === 'stalled') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"pending":');
    } else {
      if (scenario === 'final-storage') await breakStorage();
      const value = providerName === 'anthropic'
        ? { id: 'fixture', type: 'message', role: 'assistant', model: input.model, content: [{ type: 'text', text: 'TAGENT_CONNECTION_OK' }],
          stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 4 } }
        : { id: 'fixture', object: 'chat.completion', model: input.model, choices: [{ index: 0, message: { role: 'assistant', content: 'TAGENT_CONNECTION_OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    }
  } catch (error) { fixtureError = error; response.writeHead(500).end('fixture assertion failed'); }
});
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
const modelPort = await listen(model), reservation = createServer(), port = await listen(reservation);
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`, control = `http://127.0.0.1:${modelPort}`;

async function start() {
  logs = '';
  child = spawn(process.execPath, [join(root, 'packages/tagent-server/dist/index.js')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      TAGENT_WORKSPACE_ROOT: workspace, TAGENT_ENV_FILE: '', PORT: String(port), TAGENT_HOST: '127.0.0.1', NODE_ENV: 'test',
      DATABASE_URL: '', REDIS_URL: '', DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
      [`${providerName.toUpperCase()}_API_KEY`]: 'local-model-fixture-only',
      [`${providerName.toUpperCase()}_BASE_URL`]: `${control}${providerName === 'anthropic' ? '' : '/v1'}`,
      TAGENT_LLM_PROVIDER: providerName, TAGENT_LLM_MODEL: providerName === 'anthropic' ? 'claude-sonnet-4-20250514' : 'deepseek-chat',
      TAGENT_LLM_TIMEOUT_MS: serveMode ? '10000' : '1000', TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '',
      TAGENT_WEB_ORIGINS: 'http://127.0.0.1:3000', TAGENT_SEARCH_PROVIDER: '',
    },
  });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
  child.on('error', error => { fixtureError = error; });
  for (let i = 0; i < 100; i++) {
    if (fixtureError) throw fixtureError;
    if (child.exitCode !== null) throw new Error(`Backend exited: ${logs}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Readiness only. */ }
    await delay(100);
  }
  throw new Error(`Backend readiness timeout: ${logs}`);
}
async function stop() {
  const current = child; child = undefined;
  if (!current || current.exitCode !== null || current.signalCode !== null) return;
  const ended = once(current, 'exit'); current.kill(); await ended;
}
async function request(path, body) {
  return fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
}
async function json(path, body) { const response = await request(path, body); assert.ok(response.ok, `${path}: ${response.status}`); return response.json(); }

try {
  let cases = 0;
  for (providerName of ['deepseek', 'anthropic']) for (scenario of ['success', 'authentication', 'stalled', 'final-storage']) {
    workspace = await mkdtemp(join(temporaryRoot, 'case-'));
    await start(); const before = calls;
    const usersBefore = await json('/api/workspaces');
    assert.equal((await json('/api/model-connection')).checks.length, 0);
    const preview = await json('/api/model-connection/preview', {});
    assert.equal(preview.requiresConfirmation, true); assert.equal(preview.willWrite, false); assert.equal(preview.willExecute, false);
    assert.equal(calls, before);
    const body = { id: preview.id, token: preview.token, confirmed: true };
    assert.equal((await request('/api/model-connection/test', { ...body, confirmed: false })).status, 400);
    await json('/api/model-connection/test', body);
    let view;
    for (let i = 0; i < 160; i++) { view = await json('/api/model-connection'); if (!view.activeId) break; await delay(100); }
    assert.ok(!view.activeId, 'Check must terminate');
    let result = view.checks[0];
    assert.equal(result.persisted, scenario !== 'final-storage');
    assert.equal(result.status, ['success', 'final-storage'].includes(scenario) ? 'succeeded' : 'failed');
    if (scenario === 'final-storage') {
      assert.deepEqual(result.tokens, { input: 12, output: 4 });
      assert.equal((await request('/api/model-connection/preview', {})).status, 503);
      assert.equal((await request(`/api/model-connection/${result.id}/retry-save`, {})).status, 503);
      await repairStorage();
      result = (await json(`/api/model-connection/${result.id}/retry-save`, {})).checks[0];
      assert.equal(result.persisted, true);
      assert.equal(calls, before + 1, 'Saving must never rerun the model');
    } else if (scenario !== 'success') {
      assert.ok(result.error.includes(scenario === 'stalled' ? '[timeout' : '[authentication'));
      assert.equal(result.estimatedCost, null); assert.equal(result.unsettled, true);
    }
    assert.ok(!JSON.stringify(view).includes('private-fixture-credential-body'));
    assert.deepEqual(await json('/api/workspaces'), usersBefore, 'Diagnostic must not create or change a conversation');
    await json('/api/model-connection/test', body);
    assert.equal(calls, before + 1);
    await stop(); await start();
    assert.deepEqual((await json('/api/model-connection/test', body)).checks[0], result);
    assert.equal(calls, before + 1, 'Restart and duplicate confirmation must not rerun a request');
    const stored = await readFile(join(workspace, '.tagent/data/model-checks.json'), 'utf8');
    assert.ok(!stored.includes('local-model-fixture-only') && !stored.includes('private-fixture-credential-body') && !stored.includes(preview.token));
    await stop(); cases++;
  }
  if (fixtureError) throw fixtureError;
  console.log(JSON.stringify({ passed: true, cases, localModelCalls: calls, paidCalls: 0, userDataWrites: 0, sdkProviders: ['deepseek', 'anthropic'] }));
  if (serveMode) {
    scenario = 'success'; providerName = 'deepseek'; workspace = await mkdtemp(join(temporaryRoot, 'ui-')); await start();
    console.log(JSON.stringify({ base, resetUrl: control + resetPath, repairUrl: control + repairPath, stopUrl: control + stopPath, statsUrl: control + `/stats-${nonce}`, backendPid: child.pid, controlPid: process.pid, fixtureOnly: true }));
    await stopped;
  }
} finally {
  await stop(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  const rel = relative(tmpdir(), temporaryRoot); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(temporaryRoot, { recursive: true, force: true });
}
