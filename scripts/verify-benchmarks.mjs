import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as reserve } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fixtureOfficeReview } from './fixtures/office-review.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tagent-benchmarks-'));
const dataPath = join(temporaryRoot, '.tagent/data/benchmarks.json');
const serve = process.argv.includes('--serve');
let child, logs = '', calls = 0, failAgent = false;
// Local protocol fixtures only: no real credentials, external model or search requests.
const model = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  try {
    let raw = '';
    for await (const chunk of request) { raw += chunk; if (raw.length > 1000000) throw new Error('Fixture request too large'); }
    const input = JSON.parse(raw), system = String(input.messages[0]?.content || '');
    calls++;
    let content;
    if (system.includes('你是任务编排器')) {
      content = JSON.stringify([{ id: 'document-check', agentRole: 'document', objective: '整理提供的材料 alpha beta gamma' }]);
    } else if (failAgent) {
      response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Fixture authentication failure' } })); return;
    } else if (system.includes('你是办公交付核对器')) {
      content = fixtureOfficeReview(input.messages);
    } else {
      content = '# 材料整理\n\nalpha beta gamma。此内容来自本地模拟模型，只验证记录链路，不证明真实办公质量。';
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion', model: 'fixture',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
  } catch { response.writeHead(500).end(); }
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const reservation = reserve().listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(done => reservation.close(done));
const base = `http://127.0.0.1:${port}`;
async function start() {
  logs = '';
  child = spawn(process.execPath, [join(root, 'packages/tagent-server/dist/index.js')], { cwd: temporaryRoot, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), NODE_ENV: 'test', TAGENT_HOST: '127.0.0.1',
      TAGENT_WORKSPACE_ROOT: temporaryRoot, TAGENT_ENV_FILE: '', DATABASE_URL: '', REDIS_URL: '', TAGENT_SEARCH_PROVIDER: 'auto',
      DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'local-benchmark-fixture', TAGENT_LLM_PROVIDER: 'openai', TAGENT_LLM_MODEL: 'deepseek-chat',
      OPENAI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '',
      TAGENT_WEB_ORIGINS: 'http://127.0.0.1:3000', TAVILY_API_KEY: '', JINA_API_KEY: '' } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-5000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Fixture exited: ${logs}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Startup only. */ }
    await delay(100);
  }
  throw new Error(`Fixture startup timed out: ${logs}`);
}
async function stop() { if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
async function request(path, method = 'GET', body, status = 200) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const value = await response.json(); assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}`); return value;
}
const path = '/api/agents/document-agent/benchmark';
try {
  await start();
  const { workspaces } = await request('/api/workspaces'), workspaceId = workspaces[0].id;
  const sources = [];
  for (const failed of [false, true]) {
    failAgent = failed;
    const response = await fetch(base + '/api/agent/orchestrate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, message: `评分证据验收${failed ? '失败' : '正常'}：整理提供的材料 alpha beta gamma。` }), signal: AbortSignal.timeout(45000) });
    assert.equal(response.status, 200);
    const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map(block => ({
      type: block.match(/^event: *(.*)$/m)?.[1], data: JSON.parse(block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')),
    }));
    const terminal = events.filter(event => event.type === 'complete'); assert.equal(terminal.length, 1);
    const trace = events.filter(event => event.type === 'workflow_event').map(event => event.data);
    assert.ok(trace.some(event => event.type === 'agent_spawn' && event.agentId === 'document-agent' && event.agentSnapshot));
    sources.push({ runId: trace[0].runId, sessionId: terminal[0].data.sessionId, failed });
  }
  const before = calls, originalAgent = await request('/api/agents/document-agent');
  const available = await request(path + '/sources'); assert.equal(available.sources.length, 2);
  const initial = await request(path); assert.equal(initial.profile.source, 'estimated'); assert.equal(initial.latestRun, undefined);
  const config = await request(path + '/run', 'POST', {}, 201);
  assert.equal(config.profile.source, 'estimated'); assert.equal(config.run.mode, 'static_capability');
  assert.equal(config.run.estimatedCost, 0); assert.equal(config.run.evidenceReview, undefined);
  for (const source of sources) {
    const result = await request(path + '/run', 'POST', { sourceRunId: source.runId }, 201);
    assert.equal(result.run.totalScore, config.run.totalScore);
    assert.equal(result.run.evidenceReview.source.runId, source.runId);
    assert.equal(result.run.evidenceReview.checks.find(check => check.id === 'task-outcome').status, source.failed ? 'failed' : 'passed');
    for (const id of ['source-quality', 'deliverable-quality']) assert.equal(result.run.evidenceReview.checks.find(check => check.id === id).status, 'unobserved');
    assert.equal(result.profile.source, 'estimated');
  }
  await request(path + '/run', 'POST', { events: [], output: 'fake URL and dates', score: 100 }, 400);
  await request('/api/agents/research-agent/benchmark/run', 'POST', { sourceRunId: sources[0].runId }, 400);
  assert.deepEqual(await request('/api/agents/document-agent'), originalAgent, 'Assessments cannot change agent configuration');
  const history = await request(path + '/history'); assert.equal(history.runs.length, 3);
  assert.equal((await request('/api/benchmarks/runs/' + config.run.runId)).run.runId, config.run.runId);
  const disk = await readFile(dataPath, 'utf8');
  const relativeData = relative(temporaryRoot, dataPath); assert.ok(relativeData && !relativeData.startsWith('..') && !isAbsolute(relativeData));
  await rename(dataPath, dataPath + '.backup'); await mkdir(dataPath);
  try {
    await request(path + '/run', 'POST', {}, 503);
    assert.deepEqual(await request(path + '/history'), history);
  } finally { await rm(dataPath, { recursive: true }); await rename(dataPath + '.backup', dataPath); }
  assert.equal(await readFile(dataPath, 'utf8'), disk);
  await request('/api/agents/document-agent', 'PUT', { soul: originalAgent.card.soul + '\n更新后的职责', configurationRevision: originalAgent.configurationRevision });
  assert.equal((await request(path)).stale, true);
  await stop(); await start();
  assert.deepEqual(await request(path + '/history'), history);
  assert.equal((await request(path)).stale, true);
  assert.equal((await request(path + '/sources')).sources.length, 2);
  assert.equal(calls, before, 'Assessment and restart must not invoke the model');
  console.log(JSON.stringify({ status: 'passed', base, workspaceId, sources, backendPid: child.pid, temporaryRoot,
    localModelCalls: calls, assessmentModelCalls: 0, persistedRecords: 3, staleRetained: true, diskFailure503: true, userWrites: 0 }));
  if (serve) {
    console.log('Fixture ready; send stop on stdin to clean up.');
    await new Promise(done => { process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { if (data.includes('stop')) done(); }); process.stdin.on('end', done); });
    process.stdin.pause();
    assert.equal(calls, before, 'Browser assessment actions must not invoke any model');
  }
} finally {
  await stop(); model.closeAllConnections(); await new Promise(done => model.close(done));
  const rel = relative(tmpdir(), temporaryRoot); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(temporaryRoot, { recursive: true, force: true });
  console.log('Isolated benchmark fixture cleaned up.');
}
