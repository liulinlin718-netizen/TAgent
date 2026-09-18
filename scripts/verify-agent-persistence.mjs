import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tagent-agent-persistence-'));
const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(done => reservation.close(done));
const base = `http://127.0.0.1:${port}`;
const legacyPath = join(temporaryRoot, '.tagent', 'agents.json');
const storagePath = join(temporaryRoot, '.tagent', 'data', 'resident-agents.json');
const legacy = JSON.stringify({ 'research-agent': { id: 'research-agent', skills: ['legacy-skill'], mcpServers: ['legacy-mcp'] } });
await mkdir(dirname(legacyPath), { recursive: true }); await writeFile(legacyPath, legacy, 'utf8');
let child, logs = '';
async function start() {
  logs = '';
  child = spawn(process.execPath, [join(root, 'packages/tagent-server/dist/index.js')], { cwd: temporaryRoot, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), TAGENT_HOST: '127.0.0.1', NODE_ENV: 'test',
      TAGENT_WORKSPACE_ROOT: temporaryRoot, TAGENT_ENV_FILE: '', DATABASE_URL: '', REDIS_URL: '',
      DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', TAGENT_LLM_PROVIDER: '',
      TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '', TAGENT_SEARCH_PROVIDER: 'auto' } });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Isolated backend exited: ${logs}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Startup only. */ }
    await delay(100);
  }
  throw new Error(`Isolated backend startup timed out: ${logs}`);
}
async function stop() { if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
async function request(path, method = 'GET', body, expected = 200) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const data = await response.json(); assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
try {
  await start();
  const initial = (await request('/api/agents')).agents;
  assert.equal(initial.length, 6);
  assert.deepEqual(initial.find(agent => agent.id === 'research-agent').capabilities.skills, ['legacy-skill']);
  for (const path of ['/api/agents/from-template', '/api/agents/from-run']) {
    assert.equal((await request(path, 'POST', { save: false })).saved, false);
    await request(path, 'POST', { save: 'false' }, 400);
  }
  assert.equal((await request('/api/agents')).agents.length, 6);
  const created = await request('/api/agents', 'POST', { id: 'office-fixture', name: '保存验收 🚀', description: '中文 / symbols %',
    soul: '只使用提供的材料。', constraints: { allowedTools: [], maxCostPerTask: 0.1 } }, 201);
  assert.equal(created.configurationRevision, 1); assert.deepEqual(created.constraints.allowedTools, []);
  await request('/api/agents', 'POST', { id: 'office-fixture', name: '不能覆盖' }, 409);
  const edited = await request('/api/agents/office-fixture', 'PUT', { soul: '持久化角色设定', configurationRevision: 1 });
  const benchmark = await request('/api/agents/office-fixture/benchmark/run', 'POST', {}, 201);
  assert.ok(benchmark.run.runId);
  assert.equal((await request('/api/agents/office-fixture/benchmark')).latestRun.runId, benchmark.run.runId);
  const cleared = await request('/api/agents/office-fixture', 'PUT', { soul: '', configurationRevision: edited.configurationRevision });
  assert.equal(cleared.card.soul, '', 'An explicit empty Soul must not silently reuse the previous value');
  const staleBenchmark = await request('/api/agents/office-fixture/benchmark');
  assert.equal(staleBenchmark.latestRun.runId, benchmark.run.runId, 'Editing config retains historical checks');
  assert.equal(staleBenchmark.stale, true, 'Old config scores are no longer current');
  assert.equal(staleBenchmark.profile.source, 'estimated');
  const restoredSoul = await request('/api/agents/office-fixture', 'PUT', { soul: '持久化角色设定', configurationRevision: cleared.configurationRevision });
  const bound = await request('/api/agents/office-fixture/override', 'POST', { skills: ['fixture-skill'], mcpServers: ['fixture-mcp'], configurationRevision: restoredSoul.configurationRevision });
  await request('/api/agents/office-fixture', 'PUT', { name: '过期覆盖', configurationRevision: edited.configurationRevision }, 409);
  assert.equal(bound.configurationRevision, 5);
  await request('/api/agents/office-fixture', 'PUT', { card: null }, 400);
  await request('/api/agents/office-fixture', 'PUT', { name: '' }, 400);
  await request('/api/agents/office-fixture/override', 'POST', { skills: 'malformed' }, 400);
  await request('/api/agents/office-fixture', 'PUT', { constraints: { maxCostPerTask: -1 } }, 400);
  await request('/api/agents/missing/override', 'POST', { skills: [] }, 404);
  const template = await request('/api/agents/from-template', 'POST', { template: 'research', name: '模板保存', save: true }, 201);
  const fromRun = await request('/api/agents/from-run', 'POST', { agentId: 'research-agent', summary: '人工输入的沉淀摘要', save: true }, 201);
  await request('/api/agents/research-agent/spawn', 'POST', { objective: '拒绝虚构来源', sessionId: 'fixture-session', runId: 'fixture-run' }, 400);
  const { agent: task } = await request('/api/agents/research-agent/spawn', 'POST', { objective: '测试临时子 Agent' }, 201);
  assert.equal(task.spawnMeta.status, 'queued');
  await request('/api/agents/research-agent/spawn', 'POST', { objective: '拒绝权限提升', allowedTools: ['shell'] }, 400);
  await request('/api/agents/research-agent/spawn', 'POST', { objective: 123 }, 400);
  const restricted = await request('/api/agents', 'POST', { id: 'approval-fixture', name: '需要确认', description: '手动创建审批验收',
    constraints: { approvalMode: 'suggest', maxFissionDepth: 0 } }, 201);
  await request(`/api/agents/${restricted.id}/spawn`, 'POST', { objective: '未确认创建' }, 409);
  await request(`/api/agents/${restricted.id}/spawn`, 'POST', { objective: '深度用尽', confirmed: true }, 409);
  const preview = await request(`/api/agents/${task.id}/promote`, 'POST', { save: false });
  assert.equal(preview.saved, false);
  await request(`/api/agents/${task.id}`, 'PUT', { type: 'resident' }, 400);
  assert.equal((await request(`/api/agents/${task.id}`)).spawnMeta.promotedAgentId, undefined);
  const beforeFault = await readFile(storagePath, 'utf8');
  // A directory at the file target forces a real atomic-write failure in this isolated data root.
  await rename(storagePath, storagePath + '.backup'); await mkdir(storagePath);
  try {
    await request('/api/agents/office-fixture', 'PUT', { name: '不可见的失败编辑' }, 503);
    await request(`/api/agents/${task.id}/promote`, 'POST', { save: true }, 503);
    assert.equal((await request('/api/agents/office-fixture')).name, bound.name);
    assert.equal((await request(`/api/agents/${task.id}`)).spawnMeta.promotedAgentId, undefined);
  } finally { await rm(storagePath, { recursive: true }); await rename(storagePath + '.backup', storagePath); }
  assert.equal(await readFile(storagePath, 'utf8'), beforeFault);
  // The editor confirms a preview by posting its edited copy, retaining the source association.
  const promoted = await request('/api/agents', 'POST', { ...preview.agent, name: '已确认的子 Agent', sourceTaskAgentId: task.id }, 201);
  assert.equal((await request(`/api/agents/${task.id}`)).spawnMeta.promotedAgentId, promoted.id);
  const secondTask = (await request('/api/agents/research-agent/spawn', 'POST', { objective: '直接确认接口验收' }, 201)).agent;
  const directPromotion = await request(`/api/agents/${secondTask.id}/promote`, 'POST', { save: true }, 201);
  const expected = (await request('/api/agents/resident')).agents;
  await stop(); await start();
  for (const saved of [bound, template.agent, fromRun.agent, promoted, directPromotion.agent]) {
    const restored = await request(`/api/agents/${saved.id}`);
    assert.equal(restored.name, saved.name);
    assert.equal(restored.card.soul, saved.card.soul);
    assert.deepEqual(restored.capabilities, saved.capabilities);
    assert.deepEqual(restored.constraints, saved.constraints);
    assert.equal(restored.state.business, 'idle');
  }
  assert.equal((await request('/api/agents/resident')).agents.length, expected.length);
  assert.equal((await request('/api/agents/task-spawned')).agents.length, 2);
  assert.equal((await request(`/api/agents/${task.id}`)).spawnMeta.promotedAgentId, promoted.id);
  assert.equal(await readFile(legacyPath, 'utf8'), legacy);
  console.log(JSON.stringify({ status: 'passed', restart: true, createEditBind: true, previewNoWrites: true,
    templateAndRunCopies: true, confirmedPromotion: true, staleEdit409: true, diskFailure503: true, modelCalls: 0, userWrites: 0 }));
} finally {
  await stop();
  const rel = relative(tmpdir(), temporaryRoot); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(temporaryRoot, { recursive: true, force: true });
}
