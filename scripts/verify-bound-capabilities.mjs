import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fixtureOfficeReview } from './fixtures/office-review.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tagent-bound-capabilities-'));
const serveMode = process.argv.includes('--serve');
const controlPath = `/stop-${randomUUID()}`;
const resourceText = `包内专属资料 ${randomUUID()}，日期 2026-09-15，中文与符号 🙂。`;
const mcpMarker = `local-mcp-${randomUUID()}`;
let finishServing, child, logs = '', calls = 0, currentCase, skill, mcp;
const cases = [];
const serving = new Promise(done => { finishServing = done; });
// The real SDK connects only to this local model and our repository's own MCP fixture.
const modelServer = createServer(async (request, response) => {
  if (serveMode && request.method === 'POST' && request.url === controlPath) { response.end('Stopping'); finishServing(); return; }
  if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404).end(); return; }
  try {
    assert.ok(currentCase, 'No model call outside an explicit fixture run');
    assert.ok(++calls <= 40, 'Bounded local fixture calls');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), system = input.messages[0].content;
    let content = '', tool_calls;
    if (system.includes('你是任务编排器')) content = JSON.stringify([{ id: 't-config', agentRole: 'research', objective: currentCase.task, dependsOn: [] }]);
    else if (system.includes('你是办公交付核对器')) content = fixtureOfficeReview(input.messages);
    else if (system.includes('你是办公交付修订器')) throw new Error('Unexpected revision');
    else {
      const toolResults = input.messages.filter(message => message.role === 'tool');
      if (toolResults.length === 0) {
        assert.equal(system.includes(skill.id), currentCase.bound);
        assert.ok(!system.includes(resourceText), 'Resource is read on demand, not inlined in Soul');
        const tools = (input.tools || []).map(tool => tool.function.name).sort();
        assert.deepEqual(tools, currentCase.bound && currentCase.allowed ? ['read_skill_file', mcp.toolName].sort() : []);
        tool_calls = [{ id: 'read-resource', type: 'function', function: { name: 'read_skill_file', arguments: JSON.stringify({ skillId: skill.id, path: 'references/source.md' }) } }];
      } else if (toolResults.length === 1) {
        currentCase.resourceRead = toolResults[0].content.includes(resourceText);
        tool_calls = [{ id: 'call-mcp', type: 'function', function: { name: mcp.toolName,
          arguments: JSON.stringify({ method: 'tools/call', params: { name: 'echo', arguments: { text: '本地工具验收' } } }) } }];
      } else {
        const mcpReply = toolResults.at(-1).content;
        assert.ok(!mcpReply.includes(mcpMarker), 'MCP credentials remain redacted even when the tool echoes them');
        const payload = (() => { try { return JSON.parse(mcpReply); } catch { return null; } })();
        currentCase.mcpExecuted = (payload?.content || []).some(item => {
          try { return JSON.parse(item.text).value === '本地工具验收'; } catch { return false; }
        });
        currentCase.toolResults = toolResults.map(message => message.content);
        content = currentCase.resourceRead && currentCase.mcpExecuted ? '已读取绑定资料，并完成本地工具调用。' : '权限或绑定不完整；未取得的资料和工具结果不作假定。';
      }
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion', model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }));
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: { message: error.message } })); }
});
modelServer.listen(0, '127.0.0.1'); await once(modelServer, 'listening');
const modelPort = modelServer.address().port;
const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(done => reservation.close(done));
const base = `http://127.0.0.1:${port}`;
async function start() {
  child = spawn(process.execPath, [join(root, 'packages/tagent-server/dist/index.js')], { cwd: temporaryRoot, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TAGENT_WORKSPACE_ROOT: temporaryRoot, TAGENT_ENV_FILE: '',
      PORT: String(port), TAGENT_HOST: '127.0.0.1', NODE_ENV: 'test', DATABASE_URL: '', REDIS_URL: '',
      DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'local-capability-only',
      OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, TAGENT_LLM_PROVIDER: 'openai', TAGENT_LLM_MODEL: 'deepseek-chat',
      TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '', TAGENT_WEB_ORIGINS: 'http://127.0.0.1:3000' } });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-5000); }); child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Fixture backend exited: ${logs}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Startup probe. */ }
    await delay(100);
  }
  throw new Error(`Fixture startup timed out: ${logs}`);
}
async function stop() { if (child && child.exitCode === null) { const ended = once(child, 'close'); child.kill(); await ended; } }
async function json(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `${method} ${path} HTTP ${response.status}: ${await response.clone().text()}`); return response.json();
}
async function agent() { return (await json('/api/agents')).agents.find(item => item.id === 'research-agent'); }
async function bind(bound) {
  const card = await agent();
  const saved = await json('/api/agents/research-agent/override', { configurationRevision: card.configurationRevision,
    skills: bound ? [skill.id] : [], mcpServers: bound ? [mcp.id] : [] });
  assert.deepEqual(saved.constraints.allowedTools, card.constraints.allowedTools, 'Binding does not grant permissions');
}
async function permit(allowed) {
  const card = await agent(), tools = allowed ? ['read_skill_file', mcp.toolName] : [];
  await json('/api/agents/research-agent', { ...card, capabilities: { ...card.capabilities, tools },
    constraints: { ...card.constraints, allowedTools: tools, approvalMode: 'full_auto' } }, 'PUT');
}
try {
  await start();
  const workspaceId = (await json('/api/workspaces')).workspaces[0].id;
  const skillsBefore = await json('/api/skills');
  const preview = await json('/api/skills/import/preview', { markdown: '---\nname: Bound resource fixture\ndescription: 包内资料核对\n---\n按需读取 references/source.md，随后调用已授权的 MCP。不联网、不安装。' });
  assert.equal(preview.requiresConfirmation, true); assert.equal(preview.willWrite, false); assert.equal(preview.willExecute, false);
  assert.deepEqual(await json('/api/skills'), skillsBefore);
  preview.candidate.package.files = [{ path: 'references/source.md', content: resourceText, size: Buffer.byteLength(resourceText), encoding: 'utf8', status: 'included' }];
  skill = await json('/api/skills', preview.candidate);
  mcp = await json('/api/mcp', { name: 'Office fixture', type: 'stdio', command: process.execPath,
    args: [join(root, 'packages/tagent-core/src/__tests__/fixtures/mcp-server.mjs')], env: { OWN_KEY: mcpMarker } });
  assert.equal(mcp.executionApproved, false); assert.equal(mcp.toolName, 'mcp_Office_fixture');
  assert.ok(!JSON.stringify(mcp).includes(mcpMarker));
  const test = await json(`/api/mcp/${mcp.id}/test`, {});
  assert.equal(test.status, 'preview_only'); assert.equal(test.willExecute, false); assert.equal(calls, 0);
  for (const scenario of [
    { name: 'bound-denied', bound: true, allowed: false, approved: false },
    { name: 'execution-unapproved', bound: true, allowed: true, approved: false },
    { name: 'authorized', bound: true, allowed: true, approved: true },
    { name: 'unbound-after-restart', bound: false, allowed: true, approved: true },
    { name: 'revoked', bound: true, allowed: false, approved: true },
  ]) {
    await permit(scenario.allowed); await bind(scenario.bound);
    if (scenario.name === 'authorized') mcp = await json(`/api/mcp/${mcp.id}/approval`, { revision: mcp.revision, confirmed: true });
    const before = calls;
    currentCase = { ...scenario, task: `配置能力验收 ${scenario.name}：核对包内附属资料，并使用本地工具。不联网。`, resourceRead: false, mcpExecuted: false };
    const response = await fetch(base + '/api/agent/orchestrate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, message: currentCase.task }), signal: AbortSignal.timeout(45000) });
    assert.equal(response.status, 200);
    const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map(block => {
      const lines = block.split(/\r?\n/);
      return { type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(), data: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')) };
    });
    const complete = events.filter(event => event.type === 'complete'); assert.equal(complete.length, 1);
    const final = complete[0].data;
    assert.ok(final.output.length > 0); assert.equal(final.persisted, true);
    assert.ok(currentCase.toolResults?.length >= 2, `Both tool replies must reach model: ${JSON.stringify(final)}`);
    assert.equal(currentCase.resourceRead, scenario.bound && scenario.allowed);
    assert.equal(currentCase.mcpExecuted, scenario.bound && scenario.allowed && scenario.approved, JSON.stringify(currentCase.toolResults));
    const trace = events.filter(event => event.type === 'workflow_event').map(event => event.data);
    assert.ok(trace.some(event => event.type === 'agent_spawn' && event.agentId === 'research-agent'));
    assert.equal(trace.filter(event => event.type === 'complete').length, 1);
    const message = (await json(`/api/workspaces/${workspaceId}/sessions/${final.sessionId}`)).messages.at(-1);
    assert.equal(message.content, final.output); assert.deepEqual(message.traces, trace); assert.equal(message.run.status, 'finished');
    cases.push({ name: scenario.name, sessionId: final.sessionId, resourceRead: currentCase.resourceRead, mcpExecuted: currentCase.mcpExecuted, modelCalls: calls - before, message });
    currentCase = undefined;
    if (scenario.name === 'authorized') {
      const card = await agent();
      await stop(); await start();
      assert.deepEqual(await agent(), card);
      assert.deepEqual((await json('/api/skills')).skills.find(item => item.id === skill.id), skill);
      assert.deepEqual((await json('/api/mcp')).servers.find(item => item.id === mcp.id), mcp);
      assert.deepEqual((await json(`/api/workspaces/${workspaceId}/sessions/${final.sessionId}`)).messages.at(-1), message);
    }
  }
  console.log(JSON.stringify({ status: 'passed', fixtureOnly: true, localModelCalls: calls, externalModelCalls: 0, userWrites: 0,
    cases: cases.map(({ message, ...item }) => item), restart: true }));
  if (serveMode) {
    // Leave the isolated editor in the safe, bound-but-denied state for browser checks.
    await json(`/api/mcp/${mcp.id}/approval`, { revision: mcp.revision, confirmed: false });
    console.log(JSON.stringify({ base, workspaceId, agentId: 'research-agent', skillId: skill.id, mcpId: mcp.id,
      stopUrl: `http://127.0.0.1:${modelPort}${controlPath}` }));
    await serving;
  }
} finally {
  await stop(); await new Promise(done => modelServer.close(done));
  const rel = relative(tmpdir(), temporaryRoot); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(temporaryRoot, { recursive: true, force: true });
}
