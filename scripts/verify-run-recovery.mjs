import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as reservationServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fixtureOfficeReview } from './fixtures/office-review.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const userFile = join(root, '.tagent/data/workspaces.json');
const beforeUserData = await stat(userFile).catch(() => null);
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tagent-recovery-'));
const serveMode = process.argv.includes('--serve');
const controlPath = `/control-${randomUUID()}`;
let finishServing;
const serving = new Promise(done => { finishServing = done; });
const stats = { calls: 0, waiting: 0, completed: 0 };
const pending = new Set();
const artifact = '子任务完整材料 🚀 / 已知信息待核验。\n'.repeat(160);
let child, logs = '';
const modelServer = createServer(async (request, response) => {
  if (serveMode && request.url === controlPath && request.method === 'POST') {
    await kill(); await start();
    response.end(JSON.stringify({ restarted: true })); return;
  }
  if (serveMode && request.url === `${controlPath}/stop` && request.method === 'POST') {
    response.end('stopping'); finishServing(); return;
  }
  if (serveMode && request.url === '/stats') { response.end(JSON.stringify(stats)); return; }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  stats.calls++;
  const system = String(body.messages[0]?.content || '');
  const task = body.messages.map(item => item.content || '').join('\n');
  const planning = system.includes('你是任务编排器');
  const synthesis = system.includes('你是办公交付助手');
  const officePhase = task.match(/office-stop-(review|revision|recheck)/)?.[1];
  const officeReview = system.includes('你是办公交付核对器');
  const officeRevision = system.includes('你是办公交付修订器');
  const revised = officeReview && JSON.parse(body.messages[1].content).blocks.some(block => block.text.includes('REVISED_OFFICE_DRAFT'));
  const hasToolResult = body.messages.some(item => item.role === 'tool');
  if (task.includes('crash-planning') || (task.includes('crash-tool') && hasToolResult)
    || (task.includes('crash-synthesis') && synthesis)
    || (officePhase === 'review' && officeReview)
    || (officePhase === 'revision' && officeRevision)
    || (officePhase === 'recheck' && officeReview && revised)) {
    stats.waiting++;
    pending.add(response);
    response.on('close', () => pending.delete(response));
    return;
  }
  let content = artifact;
  let toolCalls;
  if (officeReview) {
    const review = JSON.parse(fixtureOfficeReview(body.messages));
    if (officePhase && !revised) { review.areas[0].status = 'failed'; review.areas[0].reason = 'OFFICE_CHECK_RETAINED：需要修订原稿。'; }
    content = JSON.stringify(review);
  }
  else if (officeRevision) content = 'REVISED_OFFICE_DRAFT：已返回的修订正文，等待重新核对。';
  else if (planning) content = task.includes('crash-synthesis')
    ? JSON.stringify([{ id: 'notes', agentRole: 'document', objective: 'Summarize supplied office notes for crash-synthesis' }]) : '[]';
  else if (task.includes('crash-tool') && !hasToolResult) toolCalls = [{ id: randomUUID(), type: 'function',
    function: { name: 'read_url', arguments: JSON.stringify({ url: 'http://127.0.0.1:9/blocked-fixture' }) } }];
  else if (officePhase) content = 'ORIGINAL_OFFICE_DRAFT：已返回的办公正文。';
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

async function until(predicate, label, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await predicate()) return; await delay(25); }
  throw new Error(`Timed out: ${label}; ${logs}`);
}
async function start() {
  child = spawn(process.execPath, [join(root, 'packages/tagent-server/dist/index.js')], {
    cwd: temporaryRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), TAGENT_HOST: '127.0.0.1', NODE_ENV: 'test',
      TAGENT_WORKSPACE_ROOT: temporaryRoot, TAGENT_ENV_FILE: '', DATABASE_URL: '', REDIS_URL: '',
      DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'local-recovery-fixture-only',
      OPENAI_BASE_URL: `${modelBase}/v1`, TAGENT_LLM_PROVIDER: 'openai', TAGENT_LLM_MODEL: 'deepseek-chat',
      TAGENT_LLM_TIMEOUT_MS: '60000', TAGENT_RUN_TIMEOUT_MS: '60000', TAGENT_SEARCH_PROVIDER: 'auto',
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
async function kill() {
  if (!child || child.exitCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
}
async function json(path, body) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
async function launch(endpoint, workspaceId, message) {
  const response = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, message }) });
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
  return { finished, events, ...events.find(event => event.type === 'session').data };
}

try {
  await start();
  const workspaceId = (await json('/api/workspaces')).workspaces[0].id;
  for (const [endpoint, task] of [
    ['/api/agent/run', 'crash-planning'],
    ['/api/agent/orchestrate', 'crash-tool'],
    ['/api/agent/orchestrate', 'crash-synthesis'],
  ]) {
    const before = { ...stats };
    const message = `整理办公笔记 🚀 / ${task}`;
    const run = await launch(endpoint, workspaceId, message);
    await until(() => stats.waiting > before.waiting, 'real model request pending');
    const accepted = await json(`/api/workspaces/${workspaceId}/sessions/${run.sessionId}`);
    assert.equal(accepted.messages[0].content, message);
    assert.equal(accepted.messages[1].run.status, 'running');
    const deletion = await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${run.sessionId}`, {
      method: 'DELETE', headers: { 'X-Tagent-Request': '1' },
    });
    assert.equal(deletion.status, 409);
    if (task !== 'crash-planning') await until(() => run.events.some(event => event.type === 'workflow_event'
      && event.data.type === (task === 'crash-tool' ? 'agent_tool_result' : 'synthesis_start')), 'checkpointed SSE evidence');
    const calls = stats.calls;
    const completedCalls = stats.completed - before.completed;
    await kill();
    await assert.rejects(run.finished);
    await until(() => pending.size === 0, 'crash closes upstream connection');
    await start();
    const restored = await json(`/api/workspaces/${workspaceId}/sessions/${run.sessionId}`);
    assert.equal(restored.messages.length, 2);
    assert.equal(restored.messages[0].content, message);
    const answer = restored.messages[1];
    assert.equal(answer.id, accepted.messages[1].id);
    assert.equal(answer.run.status, 'interrupted');
    assert.match(answer.content, /服务中断/);
    assert.match(answer.content, /不会自动重跑模型或工具/);
    assert.equal(answer.tokens.input, completedCalls * 100);
    assert.equal(answer.tokens.output, completedCalls * 20);
    if (task === 'crash-synthesis') assert.ok(answer.content.includes(artifact), 'Do not truncate saved child output to trace summary');
    assert.equal(answer.traces.filter(trace => trace.type === 'complete').length, 1);
    assert.ok(answer.traces.every(trace => trace.runId === run.runId && trace.sessionId === run.sessionId));
    const liveEvents = run.events.filter(event => event.type === 'workflow_event').map(event => event.data);
    assert.deepEqual(answer.traces.slice(0, liveEvents.length), liveEvents, 'Published events survive abrupt termination');
    const status = await json(`/api/runs/${run.runId}`);
    assert.equal(status.status, 'finished'); assert.equal(status.termination, 'interrupted'); assert.equal(status.persisted, true);
    await kill(); await start();
    assert.deepEqual(await json(`/api/workspaces/${workspaceId}/sessions/${run.sessionId}`), restored);
    assert.equal(stats.calls, calls, 'Neither restart performs model/tool replay');
    console.log(JSON.stringify({ task, forcedKill: true, restored: true, idempotent: true, knownCost: answer.cost, events: answer.traces.length }));
  }
  for (const action of ['crash', 'cancel']) for (const phase of ['review', 'revision', 'recheck']) {
    const before = { ...stats };
    const run = await launch('/api/agent/orchestrate', workspaceId, `office-stop-${phase} ${action}：仅整理给定办公笔记，不联网。`);
    await until(() => stats.waiting > before.waiting, 'office model request pending');
    const completed = stats.completed - before.completed, callCount = stats.calls;
    assert.equal(completed, phase === 'review' ? 2 : phase === 'revision' ? 3 : 4);
    if (action === 'crash') {
      await kill(); await assert.rejects(run.finished); await until(() => pending.size === 0, 'office crash closes upstream'); await start();
    } else {
      await json(`/api/runs/${run.runId}/cancel`, {}); await run.finished;
      assert.equal(run.events.filter(event => event.type === 'complete').length, 1);
      const final = run.events.find(event => event.type === 'complete').data;
      assert.equal(final.termination, 'cancelled'); assert.equal(final.success, false); assert.equal(final.persisted, true);
    }
    const saved = await json(`/api/workspaces/${workspaceId}/sessions/${run.sessionId}`), answer = saved.messages.at(-1);
    assert.equal(answer.deliveryReview.status, 'unverified');
    assert.equal(answer.tokens.input, completed * 100); assert.equal(answer.tokens.output, completed * 20);
    assert.match(answer.content, phase === 'recheck' ? /REVISED_OFFICE_DRAFT/ : /ORIGINAL_OFFICE_DRAFT/);
    const review = answer.deliveryReview;
    if (phase !== 'review') {
      const original = phase === 'recheck' ? review.previous.review : review;
      assert.match(original.receipt.rawOutput, /OFFICE_CHECK_RETAINED/);
      assert.ok(original.checks.some(check => check.status === 'failed'));
      if (phase === 'recheck') {
        assert.match(review.previous.output, /ORIGINAL_OFFICE_DRAFT/);
        assert.match(original.revisionAttempt.rawOutput, /REVISED_OFFICE_DRAFT/);
      }
    }
    const unfinished = phase === 'revision' ? review.revisionAttempt : review.receipt;
    assert.equal(unfinished.status, action === 'crash' ? 'pending' : 'request_failed');
    assert.equal(unfinished.unsettledRequests, 1); assert.ok(unfinished.requestId);
    assert.equal(answer.traces.filter(trace => trace.type === 'complete').length, 1);
    if (action === 'cancel') assert.deepEqual(run.events.find(event => event.type === 'complete').data.deliveryReview, review);
    await kill(); await start();
    assert.deepEqual(await json(`/api/workspaces/${workspaceId}/sessions/${run.sessionId}`), saved);
    assert.equal(stats.calls, callCount, 'Office recovery never repeats the model');
    console.log(JSON.stringify({ task: `office-stop-${phase}`, action, restoredReceipts: true, idempotent: true, knownCost: answer.cost }));
  }
  const afterUserData = await stat(userFile).catch(() => null);
  assert.equal(afterUserData?.mtimeMs, beforeUserData?.mtimeMs);
  assert.equal(afterUserData?.size, beforeUserData?.size);
  console.log(JSON.stringify({ passed: true, stats, realModelCost: 0, userDataWrites: 0 }));
  if (serveMode) {
    console.log(JSON.stringify({ base, modelBase, controlPath, workspaceId, pid: child.pid }));
    await serving;
  }
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  await kill();
  for (const response of pending) response.destroy();
  modelServer.closeAllConnections();
  await new Promise(done => modelServer.close(done));
  const rel = relative(tmpdir(), temporaryRoot);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(temporaryRoot, { recursive: true, force: true });
}
