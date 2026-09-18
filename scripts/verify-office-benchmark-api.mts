import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as reserve } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentPool, getOfficeBenchmarkTasks } from '../packages/tagent-core/dist/index.js';
import { OFFICE_ANSWERS, OFFICE_ROLE_ANSWERS } from '../packages/tagent-core/src/__tests__/fixtures/office-benchmark-answers.js';

// Isolated full Server + SDK lifecycle. All answers are fixtures, not real model quality evidence.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(join(tmpdir(), 'tagent-office-api-')), serve = process.argv.includes('--serve');
let child: ChildProcess | undefined, logs = '', calls = 0, mode = 'success', fixtureError: unknown;
const tasks = getOfficeBenchmarkTasks(new AgentPool().getAgent('document-agent')!);
const model = createServer(async (request, response) => {
  try {
    if (request.url?.startsWith('/__fixture/')) {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'POST') mode = url.searchParams.get('mode') || 'success';
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode, calls })); return;
    }
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer local-office-fixture');
    let raw = ''; for await (const part of request) { raw += part; assert.ok(raw.length < 200000); }
    const input = JSON.parse(raw); calls++;
    if (mode === 'hold') return;
    if (mode === 'slow') await delay(250);
    if (mode === 'error') { response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'private-fixture-error' } })); return; }
    const prompt = input.messages.find((message: { role: string }) => message.role === 'user').content;
    const index = tasks.findIndex(task => task.prompt === prompt); assert.ok(index >= 0);
    const url = Object.keys(tasks[index]!.resources)[0];
    const tool = url && !input.messages.some((message: { role: string }) => message.role === 'tool');
    const content = JSON.stringify([...OFFICE_ANSWERS, OFFICE_ROLE_ANSWERS.document][index]);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `chat-${calls}`, object: 'chat.completion', model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: tool ? '' : content,
        ...(tool ? { tool_calls: [{ id: `tool-${calls}`, type: 'function', function: { name: 'read_url', arguments: JSON.stringify({ url }) } }] } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
  } catch (error) { fixtureError = error; response.writeHead(500).end(); }
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const modelBase = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
const reservation = reserve().listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = (reservation.address() as { port: number }).port; await new Promise<void>(done => reservation.close(() => done()));
const base = `http://127.0.0.1:${port}`, path = '/api/agents/document-agent/benchmark';
async function startBackend() {
  logs = '';
  child = spawn(process.execPath, [join(repo, 'packages/tagent-server/dist/index.js')], { cwd: root, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), NODE_ENV: 'test', TAGENT_HOST: '127.0.0.1',
      TAGENT_WORKSPACE_ROOT: root, TAGENT_ENV_FILE: '', DATABASE_URL: '', REDIS_URL: '', TAGENT_SEARCH_PROVIDER: 'auto',
      DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'local-office-fixture', OPENAI_BASE_URL: modelBase + '/v1',
      TAGENT_LLM_PROVIDER: 'openai', TAGENT_LLM_MODEL: 'deepseek-chat', TAGENT_LLM_TIMEOUT_MS: '20000',
      TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '', TAGENT_WEB_ORIGINS: 'http://127.0.0.1:3000', TAVILY_API_KEY: '', JINA_API_KEY: '' } });
  for (const stream of [child.stdout, child.stderr]) stream!.on('data', value => { logs = (logs + value).slice(-8000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Backend exited: ${logs}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Startup polling. */ }
    await delay(100);
  }
  throw new Error(`Backend startup timeout: ${logs}`);
}
async function stopBackend() { if (child && child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; } }
async function api(suffix: string, method = 'GET', body?: unknown, status = 200) {
  const response = await fetch(base + path + suffix, { method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
}
async function launch() { const preview = await api('/live/preview', 'POST', {}); return api('/live/start', 'POST', { token: preview.token, confirmed: true }, 202); }
async function ended(id: string) {
  for (let i = 0; i < 100; i++) { const view = await api('/live/runs/' + id); if (view.run.status !== 'running') return view; await delay(100); }
  throw new Error('Assessment did not finish');
}
try {
  await startBackend();
  const before = calls, preview = await api('/live/preview', 'POST', {});
  assert.equal((await api('')).profile.source, 'estimated'); assert.equal(calls, before);
  await api('/live/start', 'POST', { token: preview.token, confirmed: false }, 400);
  const started = await api('/live/start', 'POST', { token: preview.token, confirmed: true }, 202);
  const completed = await ended(started.run.id); assert.ifError(fixtureError);
  assert.equal(completed.run.score.totalScore, 100); assert.equal(completed.run.modelCalls, 11); assert.equal(calls, 11);
  assert.equal((await api('')).profile.mode, 'controlled_office');
  await api('/live/start', 'POST', { token: preview.token, confirmed: true }, 409);
  await stopBackend(); await startBackend();
  assert.deepEqual(await api('/live/runs/' + started.run.id), completed); assert.equal(calls, 11);
  mode = 'hold'; const active = await launch();
  for (let i = 0; i < 50 && calls < 12; i++) await delay(50);
  assert.equal(calls, 12); await api('/live/runs/' + active.run.id + '/cancel', 'POST', {});
  const stopped = await ended(active.run.id); assert.equal(stopped.run.status, 'interrupted'); assert.equal(stopped.run.score, undefined);
  assert.equal(stopped.run.usage.unsettledRequests, 1); assert.equal(calls, 12);
  const crash = await launch();
  for (let i = 0; i < 50 && calls < 13; i++) await delay(50);
  await stopBackend(); await startBackend();
  const recovered = await api('/live/runs/' + crash.run.id); assert.equal(recovered.run.status, 'interrupted');
  assert.equal(recovered.run.events.filter((event: { type: string }) => event.type === 'complete').length, 1); assert.equal(calls, 13);
  mode = 'error'; const bad = await launch(), failed = await ended(bad.run.id);
  assert.equal(failed.run.status, 'failed'); assert.equal(failed.run.score, undefined); assert.ok(!JSON.stringify(failed).includes('private-fixture-error')); assert.equal(calls, 14);
  // Real filesystem fault: confirmation must not dispatch a model request without its initial durable checkpoint.
  const file = join(root, '.tagent/data/office-benchmarks.json'), old = await readFile(file, 'utf8');
  const rel = relative(root, file); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rename(file, file + '.backup'); await mkdir(file);
  try { const consent = await api('/live/preview', 'POST', {}); await api('/live/start', 'POST', { token: consent.token, confirmed: true }, 503); }
  finally { await rm(file, { recursive: true }); await rename(file + '.backup', file); }
  assert.equal(await readFile(file, 'utf8'), old); assert.equal(calls, 14);
  assert.equal((await api('/live/history')).storageFailed, true);
  await stopBackend(); await startBackend(); mode = 'slow';
  console.log(JSON.stringify({ status: 'passed', base, modelBase, backendPid: child!.pid, fixtureCalls: calls, paidRequests: 0, userWrites: 0,
    checks: ['preview', 'one-use-consent', 'score-profile', 'restart', 'cancel', 'crash-recovery', 'model-failure', 'real-storage-failure'] }));
  if (serve) {
    console.log('Browser fixture ready; enter stop to clean up.');
    await new Promise<void>(done => { process.stdin.setEncoding('utf8'); process.stdin.on('data', value => { if (String(value).trim() === 'stop') { process.stdin.pause(); done(); } }); process.stdin.resume(); });
  }
} finally {
  await stopBackend(); model.closeAllConnections(); await new Promise<void>(done => model.close(() => done()));
  const rel = relative(tmpdir(), root); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel)); await rm(root, { recursive: true, force: true });
}
