import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rename, rm, rmdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as reservationServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fixtureOfficeReview } from './fixtures/office-review.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tagent-cancellation-'));
const serveMode = process.argv.includes('--serve');
const controlPath = `/stop-${randomUUID()}`;
const stats = { calls: 0, waiting: 0, aborted: 0, completed: 0 };
const pending = new Set();
let child, logs = '', cleaned = false;
const modelServer = createServer(async (request, response) => {
  if (request.url === controlPath && request.method === 'POST') {
    response.end('Stopping fixture'); void cleanup(); return;
  }
  if (request.url === '/stats') { response.end(JSON.stringify(stats)); return; }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  stats.calls++;
  const system = String(body.messages[0]?.content || '');
  const task = body.messages.map(item => item.content || '').join('\n');
  const planning = system.includes('你是任务编排器');
  const synthesis = system.includes('你是办公交付助手');
  const hasToolResult = body.messages.some(item => item.role === 'tool');
  const wait = task.includes('cancel-decompose') || task.includes('deadline-case')
    || task.includes('disconnect-case') || task.includes('ui-cancel-case')
    || (task.includes('cancel-after-tool') && hasToolResult)
    || (task.includes('cancel-verification') && system.includes('你是办公交付核对器'))
    || (task.includes('cancel-synthesis') && synthesis);
  if (wait) {
    stats.waiting++;
    pending.add(response);
    response.on('close', () => { pending.delete(response); if (!response.writableEnded) stats.aborted++; });
    return;
  }
  let content = 'Local fixture final answer: supplied office notes retained.';
  let toolCalls;
  if (system.includes('你是办公交付核对器')) content = fixtureOfficeReview(body.messages);
  else if (planning) content = task.includes('cancel-synthesis')
    ? JSON.stringify([{ id: 'notes', agentRole: 'document', objective: 'Summarize supplied office notes for cancel-synthesis' },
      { id: 'actions', agentRole: 'project', objective: 'List actions from supplied notes for cancel-synthesis', dependsOn: ['notes'] }]) : '[]';
  else if (task.includes('cancel-after-tool') && !hasToolResult) toolCalls = [{ id: randomUUID(), type: 'function',
    function: { name: 'read_url', arguments: JSON.stringify({ url: 'http://127.0.0.1:9/blocked-fixture' }) } }];
  stats.completed++;
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
    id: randomUUID(), object: 'chat.completion', model: 'deepseek-chat',
    choices: [{ index: 0, message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  }));
});
modelServer.listen(0, '127.0.0.1');
await once(modelServer, 'listening');
const modelBase = `http://127.0.0.1:${modelServer.address().port}`;
const reservation = reservationServer().listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(done => reservation.close(done));
const base = `http://127.0.0.1:${port}`;

async function until(predicate, label, timeout = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await predicate()) return; await delay(25); }
  throw new Error(`Timed out: ${label}; ${logs}`);
}
async function start(deadline = 2000) {
  child = spawn(process.execPath, [join(root, 'packages/tagent-server/dist/index.js')], {
    cwd: temporaryRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), TAGENT_HOST: '127.0.0.1', NODE_ENV: 'test',
      TAGENT_WORKSPACE_ROOT: temporaryRoot, TAGENT_ENV_FILE: '', DATABASE_URL: '', REDIS_URL: '',
      DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'local-cancellation-fixture-only',
      OPENAI_BASE_URL: `${modelBase}/v1`, TAGENT_LLM_PROVIDER: 'openai', TAGENT_LLM_MODEL: 'deepseek-chat',
      TAGENT_LLM_TIMEOUT_MS: '10000', TAGENT_RUN_TIMEOUT_MS: String(deadline), TAGENT_SEARCH_PROVIDER: 'auto',
      TAVILY_API_KEY: '', JINA_API_KEY: '', TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '',
      TAGENT_WEB_ORIGINS: 'http://127.0.0.1:3000',
    },
  });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-4000); });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(logs);
    try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(300) })).ok; } catch { return false; }
  }, 'backend startup');
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const ended = once(child, 'exit'); child.kill(); await ended;
}
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await stop();
  for (const response of pending) response.destroy();
  modelServer.closeAllConnections();
  await new Promise(done => modelServer.close(done));
  const rel = relative(tmpdir(), temporaryRoot);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(temporaryRoot, { recursive: true, force: true });
}
async function json(path, body) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
async function launch(endpoint, workspaceId, message) {
  const controller = new AbortController();
  const response = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, message }), signal: controller.signal });
  assert.equal(response.status, 200);
  const events = [];
  const finished = (async () => {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const lines = block.split('\n');
          events.push({ type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(),
            data: JSON.parse(lines.find(line => line.startsWith('data:')).slice(5)) });
        }
      }
    } finally { reader.releaseLock(); }
  })();
  void finished.catch(() => {});
  await until(() => events.some(event => event.type === 'session'), 'session SSE');
  return { controller, finished, events, ...events.find(event => event.type === 'session').data };
}

try {
  await start();
  const workspaceId = (await json('/api/workspaces')).workspaces[0].id;
  let savedSessionId, savedMessage;
  for (const [endpoint, task, termination] of [
    ['/api/agent/run', 'cancel-decompose', 'cancelled'],
    ['/api/agent/orchestrate', 'cancel-after-tool', 'cancelled'],
    ['/api/agent/orchestrate', 'cancel-synthesis', 'cancelled'],
    ['/api/agent/orchestrate', 'cancel-verification', 'cancelled'],
    ['/api/agent/run', 'disconnect-case', 'disconnected'],
    ['/api/agent/orchestrate', 'deadline-case', 'deadline'],
  ]) {
    const before = { ...stats };
    const run = await launch(endpoint, workspaceId, task);
    await until(() => stats.waiting > before.waiting, 'real model request pending');
    if (termination === 'cancelled') {
      const reply = await json(`/api/runs/${run.runId}/cancel`, {});
      assert.equal(reply.status, 'stopping');
      assert.equal(reply.termination, termination);
      assert.equal((await json(`/api/runs/${run.runId}/cancel`, {})).termination, termination);
    } else if (termination === 'disconnected') run.controller.abort();
    if (termination === 'disconnected') await assert.rejects(run.finished);
    else await run.finished;
    await until(async () => (await json(`/api/runs/${run.runId}`)).status === 'finished', 'cleanup and persistence');
    await until(() => stats.aborted === before.aborted + 1, 'upstream HTTP socket actually closed');
    const status = await json(`/api/runs/${run.runId}`);
    assert.equal(status.termination, termination); assert.equal(status.persisted, true);
    const session = await json(`/api/workspaces/${workspaceId}/sessions/${run.sessionId}`);
    const message = session.messages.at(-1);
    assert.equal(message.role, 'assistant');
    assert.match(message.content, /任务已停止/);
    assert.equal(message.traces.filter(event => event.type === 'complete').length, 1);
    assert.ok(message.traces.every(event => event.runId === run.runId));
    assert.equal(message.traces.at(-1).data.termination, termination);
    if (termination !== 'disconnected') {
      const terminal = run.events.filter(event => event.type === 'complete');
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0].data.output, message.content);
      assert.equal(terminal[0].data.totalCost, message.cost);
      assert.equal(terminal[0].data.persisted, true);
      assert.deepEqual(run.events.filter(event => event.type === 'workflow_event').map(event => event.data), message.traces);
    }
    if (task === 'cancel-after-tool') { assert.ok(message.cost > 0); assert.match(message.content, /拦截|禁止/); }
    if (task === 'cancel-synthesis') { assert.ok(message.cost > 0); assert.match(message.content, /Local fixture final answer/); }
    if (task === 'cancel-verification') {
      assert.ok(message.cost > 0); assert.match(message.content, /Local fixture final answer/);
      assert.equal(message.deliveryReview.status, 'unverified');
      assert.deepEqual(message.deliveryReview.checks, []);
      assert.deepEqual(message.deliveryReview.coverage, { expectedBlocks: 1, checkedBlocks: 0 });
      assert.equal(message.deliveryReview.receipt.status, 'request_failed');
      assert.equal(message.deliveryReview.receipt.unsettledRequests, 1);
      assert.equal(message.deliveryReview.receipt.rawOutput, undefined);
      assert.equal(message.deliveryReview.revisionAttempt, undefined);
      assert.equal(stats.calls - before.calls, 3, 'Plan, draft and interrupted review only');
      assert.deepEqual(run.events.find(event => event.type === 'complete').data.deliveryReview, message.deliveryReview);
      assert.ok(message.traces.some(event => event.data.stage === 'verify'));
    }
    const calls = stats.calls; await delay(100); assert.equal(stats.calls, calls, 'No model retries or synthesis after cancellation');
    savedSessionId = run.sessionId; savedMessage = message;
    console.log(JSON.stringify({ endpoint, task, termination, upstreamClosed: true, uniqueTerminal: true, persisted: true, knownCost: message.cost }));
  }
  const normal = await launch('/api/agent/orchestrate', workspaceId, 'Summarize the supplied office notes.');
  await normal.finished;
  assert.equal(normal.events.filter(event => event.type === 'complete').length, 1);
  assert.equal(normal.events.find(event => event.type === 'complete').data.success, true);
  const beforeFault = stats.waiting;
  const fault = await launch('/api/agent/orchestrate', workspaceId, 'cancel-decompose save-failure');
  await until(() => stats.waiting > beforeFault, 'pending request before storage fault');
  const dataFile = join(temporaryRoot, '.tagent/data/workspaces.json');
  const backup = dataFile + '.fixture-backup';
  for (const target of [dataFile, backup]) {
    const rel = relative(temporaryRoot, target);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  }
  await rename(dataFile, backup);
  try {
    // An empty directory at the file destination forces the real atomic rename to fail.
    await mkdir(dataFile);
    await json(`/api/runs/${fault.runId}/cancel`, {});
    await fault.finished;
    const terminals = fault.events.filter(event => event.type === 'complete');
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].data.persisted, false);
    assert.match(terminals[0].data.persistenceError, /保存失败/);
    assert.match(terminals[0].data.output, /任务已停止/);
    const trace = fault.events.filter(event => event.type === 'workflow_event' && event.data.type === 'complete');
    assert.equal(trace.length, 1);
    assert.equal(trace[0].data.data.persistence, 'failed');
    const state = await json(`/api/workspaces/${workspaceId}/sessions/${fault.sessionId}`);
    assert.equal(state.messages.at(-1).run.status, 'running', 'Do not publish an unsaved final answer as persisted state');
    assert.equal(state.messages.at(-1).content, '任务已接收，尚未生成最终结果。');
    console.log(JSON.stringify({ storageFault: true, uniqueTerminal: true, outputRetained: true, persisted: false }));
  } finally { await rmdir(dataFile); await rename(backup, dataFile); }
  await stop(); await start(serveMode ? 600_000 : 2000);
  const restored = await json(`/api/workspaces/${workspaceId}/sessions/${savedSessionId}`);
  assert.deepEqual(restored.messages.at(-1), savedMessage, 'Stopped result survives actual server restart');
  console.log(JSON.stringify({ passed: true, stats, restartPreserved: true, realModelCost: 0, userDataWrites: 0 }));
  if (serveMode) {
    console.log(JSON.stringify({ base, modelBase, controlPath, workspaceId, pid: child.pid }));
    await new Promise(done => modelServer.once('close', done));
  }
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await cleanup(); }
