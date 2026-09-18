import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createReservation } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fixtureOfficeReview } from './fixtures/office-review.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tagent-workflow-'));
const serveMode = process.argv.includes('--serve');
const taskAgentMode = process.argv.includes('--task-agents');
const toolCallsPerTurn = process.argv.includes('--burst') ? 40 : 1;
const controlPath = `/stop-${randomUUID()}`;
let child;
let logs = '';
let modelCalls = 0;
let stopping = false;
const configuredSoul = '来自大厅保存的文档角色设定 WORKFLOW_CARD_FIXTURE';

// This local model fixture never forwards requests or reads real model credentials.
const modelServer = createServer(async (request, response) => {
  if (serveMode && request.method === 'POST' && request.url === controlPath) {
    response.end('Stopping isolated fixture');
    void cleanup();
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  try {
    let raw = '';
    for await (const part of request) { raw += part.toString(); if (raw.length > 1000000) throw new Error('Fixture input too large'); }
    const input = JSON.parse(raw);
    modelCalls++;
    const system = String(input.messages[0]?.content || '');
    let content;
    let toolCalls;
    if (system.includes('你是办公交付核对器')) {
      content = fixtureOfficeReview(input.messages);
    } else if (system.includes('你是任务编排器')) {
      content = JSON.stringify([{ id: 'review-a', agentRole: 'document', objective: '校对已提供说明 alpha beta gamma',
        ...(taskAgentMode ? { spawn: { name: '材料整理子 Agent', reason: '隔离材料上下文' } } : {}) },
        { id: 'review-b', agentRole: 'document', objective: '校对已提供说明 alpha beta gamma', dependsOn: ['review-a'],
          ...(taskAgentMode ? { spawn: { name: '交接核对子 Agent', reason: '逐级交接复核', parentTaskId: 'review-a' } } : {}) }]);
    } else if (system.includes('你是办公交付助手')) {
      content = '# 工作流验收样例\n\n两个子任务均已返回。此内容由本地模拟模型生成，仅验证事件与存储，不是办公交付质量验收。';
    } else if (!input.messages.some(message => message.role === 'tool')) {
      assert.ok(system.includes(configuredSoul), 'The saved Agent Card must reach the executing model');
      const allowed = (input.tools || []).map(tool => tool.function.name);
      assert.ok(allowed.includes('read_url'), 'Fixture requires the existing read-only URL tool');
      toolCalls = Array.from({ length: toolCallsPerTurn }, () => ({ id: randomUUID(), type: 'function',
        function: { name: 'read_url', arguments: JSON.stringify({ url: 'http://127.0.0.1:9/blocked-fixture' }) } }));
    } else {
      const toolResult = input.messages.findLast(message => message.role === 'tool');
      assert.match(toolResult.content, /拦截|禁止|公网|private|blocked|restricted/i, 'Private URL must be blocked without connecting');
      content = '工作流验收子任务结果：alpha beta gamma。私有地址读取已被安全边界拦截；本地输入已保留。';
    }
    await delay(200);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: randomUUID(), object: 'chat.completion', model: 'workflow-fixture',
      choices: [{ index: 0, message: { role: 'assistant', content: content || '', ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
  } catch (error) { response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: error.message } })); }
});
modelServer.listen(0, '127.0.0.1');
await once(modelServer, 'listening');
const modelPort = modelServer.address().port;
const reservation = createReservation().listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(done => reservation.close(done));
const base = `http://127.0.0.1:${port}`;

async function start() {
  logs = '';
  child = spawn(process.execPath, [join(root, 'packages/tagent-server/dist/index.js')], {
    cwd: temporaryRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), TAGENT_HOST: '127.0.0.1', NODE_ENV: 'test', TAGENT_WORKSPACE_ROOT: temporaryRoot, TAGENT_ENV_FILE: '',
      DATABASE_URL: '', REDIS_URL: '', DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'local-workflow-fixture-only',
      OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, TAGENT_LLM_PROVIDER: 'openai', TAGENT_LLM_MODEL: 'deepseek-chat',
      TAGENT_SEARCH_PROVIDER: 'auto', TAVILY_API_KEY: '', JINA_API_KEY: '', TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '',
      TAGENT_WEB_ORIGINS: 'http://127.0.0.1:3000' },
  });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
  child.on('error', error => { logs += error.message; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Fixture backend exited: ${logs}`);
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Startup only. */ }
    await delay(100);
  }
  throw new Error(`Fixture startup timed out: ${logs}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const ended = once(child, 'exit'); child.kill(); await ended;
}
async function cleanup() {
  if (stopping) return;
  stopping = true;
  await stop();
  await new Promise(done => modelServer.close(done));
  const rel = relative(tmpdir(), temporaryRoot);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(temporaryRoot, { recursive: true, force: true });
}
const json = async (path, body) => {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.ok(response.ok, `HTTP ${response.status}: ${path}`);
  return response.json();
};

try {
  await start();
  const { workspaces } = await json('/api/workspaces');
  const workspaceId = workspaces[0].id;
  const savedCard = await fetch(base + '/api/agents/document-agent', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ soul: configuredSoul,
      ...(taskAgentMode ? { constraints: { maxFissionDepth: 2, allowedTools: ['read_url'] } } : {}) }) });
  assert.ok(savedCard.ok, 'Save edited Agent Card');
  await stop(); await start();
  assert.equal((await json('/api/agents')).agents.find(agent => agent.id === 'document-agent').card.soul, configuredSoul);
  let lastSaved;
  let lastSessionId;
  for (const endpoint of ['/api/agent/run', '/api/agent/orchestrate']) {
    const response = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, message: '工作流验收：校对已提供说明 alpha beta gamma。' }), signal: AbortSignal.timeout(45000) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream; charset=utf-8$/i);
    const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map(block => {
      const lines = block.split(/\r?\n/);
      return { type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(), data: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')) };
    });
    const complete = events.filter(event => event.type === 'complete');
    assert.equal(complete.length, 1);
    assert.equal(complete[0].data.success, true);
    const trace = events.filter(event => event.type === 'workflow_event').map(event => event.data);
    assert.equal(new Set(trace.map(event => event.runId)).size, 1);
    const spawned = trace.filter(event => event.type === 'agent_spawn');
    assert.equal(trace.filter(event => event.type === 'agent_tool_call').length, 2 * toolCallsPerTurn);
    assert.equal(trace.filter(event => event.type === 'agent_tool_result').length, 2 * toolCallsPerTurn);
    assert.deepEqual(spawned.map(event => event.taskId), ['review-a', 'review-b']);
    assert.equal(new Set(spawned.map(event => event.agentId)).size, taskAgentMode ? 2 : 1);
    if (taskAgentMode) {
      assert.equal(spawned[0].data.agentType, 'task_spawned');
      assert.equal(spawned[1].parentAgentId, spawned[0].agentId);
      assert.equal(spawned[1].parentTaskId, 'review-a');
      const children = (await json(`/api/agents/task-spawned?runId=${trace[0].runId}`)).agents;
      assert.equal(children.length, 2);
      for (const child of children) {
        assert.equal(child.spawnMeta.status, 'completed');
        assert.match(child.spawnMeta.result.output, /alpha beta gamma/);
        assert.deepEqual(child.constraints.allowedTools, ['read_url']);
        assert.equal(child.spawnMeta.sessionId, complete[0].data.sessionId);
        assert.ok(child.spawnMeta.result.cost > 0);
      }
      assert.equal(children[1].constraints.maxFissionDepth, 0);
      assert.ok(children[1].constraints.maxCostPerTask <= children[0].constraints.maxCostPerTask * 0.5);
    }
    for (const spawn of spawned) {
      assert.equal(spawn.agentSnapshot.id, spawn.agentId);
      assert.ok(spawn.agentSnapshot.constraints.allowedTools.includes('read_url'));
      const owned = trace.filter(event => event.taskId === spawn.taskId);
      for (const type of ['agent_stage', 'agent_progress', 'agent_tool_call', 'agent_tool_result', 'governance', 'agent_complete']) assert.ok(owned.some(event => event.type === type), `Missing scoped ${type}`);
    }
    lastSessionId = complete[0].data.sessionId;
    lastSaved = await json(`/api/workspaces/${workspaceId}/sessions/${lastSessionId}`);
    assert.deepEqual(lastSaved.messages.at(-1).traces, trace);
    assert.equal(lastSaved.messages.at(-1).content, complete[0].data.output);
    if (!taskAgentMode) await json(`/api/agents/${spawned[0].agentId}/override`, { skills: ['later-fixture-skill'], mcpServers: [] });
    assert.deepEqual((await json(`/api/workspaces/${workspaceId}/sessions/${lastSessionId}`)).messages, lastSaved.messages);
  }
  const taskHistory = (await json('/api/agents/task-spawned')).agents;
  const beforeRestartCalls = modelCalls;
  await stop(); await start();
  assert.deepEqual((await json(`/api/workspaces/${workspaceId}/sessions/${lastSessionId}`)).messages, lastSaved.messages);
  assert.deepEqual((await json('/api/agents/task-spawned')).agents, taskHistory);
  assert.equal(modelCalls, beforeRestartCalls, 'Restart must not replay completed children');
  console.log(JSON.stringify({ status: 'passed', fixtureOnly: true, modelCalls, endpoints: 2, taskScoped: true, sameResidentReused: !taskAgentMode,
    executedChildren: taskHistory.length, twoGenerations: taskAgentMode, toolCallsPerTurn, snapshotRestart: true, savedCardExecutedAfterRestart: true }));
  if (serveMode) console.log(JSON.stringify({ base, workspaceId, sessionId: lastSessionId, backendPid: child.pid, temporaryRoot, stopUrl: `http://127.0.0.1:${modelPort}${controlPath}` }));
  else await cleanup();
} catch (error) { await cleanup(); throw error; }
