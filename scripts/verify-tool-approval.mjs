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
import { createSkillPackageDraft } from '../packages/tagent-core/dist/index.js';
import { fixtureOfficeReview } from './fixtures/office-review.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tagent-approval-'));
let child, logs = '', calls = 0, resourceReceipts = 0, skillId = '';
const marker = 'APPROVED_LOCAL_RESOURCE_中文';
const serveMode = process.argv.includes('--serve');
const streams = [];
// This fixture exercises the real SDK, Orchestrator, HTTP handlers and file store.
// Only in-memory Skill resources are executed; no paid model or remote tool call.
const model = createServer(async (request, response) => {
  if (request.url === '/stats') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ calls, resourceReceipts })); return; }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), system = input.messages[0].content;
    let content, tool_calls;
    calls++;
    if (system.includes('你是任务编排器')) content = JSON.stringify([{ id: 'approval-doc', agentRole: 'document', objective: '读取已绑定的 Skill 资料，整理文档摘要，不联网。', dependsOn: [] }]);
    else if (system.includes('你是办公交付核对器')) content = fixtureOfficeReview(input.messages);
    else if (system.includes('你是办公交付修订器')) content = '## 文档摘要\n\n这是审批流程的本地验收。';
    else {
      const results = input.messages.filter(message => message.role === 'tool');
      if (!results.length) {
        content = '将读取已绑定的资料。';
        tool_calls = [{ id: 'call-' + randomUUID(), type: 'function', function: { name: 'read_skill_file', arguments: JSON.stringify({ skillId, path: 'references/office.md' }) } }];
      } else {
        if (results.some(message => message.content.includes(marker))) resourceReceipts++;
        content = results.some(message => message.content.includes(marker))
          ? '## 文档摘要\n\n已取得用户允许读取的本地资料。\n\n没有联网、执行脚本或保存外部文件。'
          : '## 未读取资料\n\n此次工具未获许可，未取得参考资料。请确认权限后再决定是否重新发起任务。';
      }
    }
    await delay(60);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion', model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }));
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: { message: error.message } })); }
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const modelBase = `http://127.0.0.1:${model.address().port}`;
const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(done => reservation.close(done));
const base = `http://127.0.0.1:${port}`;
async function start() {
  child = spawn(process.execPath, [join(root, 'packages/tagent-server/dist/index.js')], { cwd: temporaryRoot, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TAGENT_WORKSPACE_ROOT: temporaryRoot, TAGENT_ENV_FILE: '',
      PORT: String(port), TAGENT_HOST: '127.0.0.1', NODE_ENV: 'test', DATABASE_URL: '', REDIS_URL: '',
      DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'local-approval-only',
      OPENAI_BASE_URL: modelBase + '/v1', TAGENT_LLM_PROVIDER: 'openai', TAGENT_LLM_MODEL: 'deepseek-chat',
      TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '', TAGENT_WEB_ORIGINS: 'http://127.0.0.1:3000,http://localhost:3000' } });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-5000); }); child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Fixture backend exited: ${logs}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Startup probe. */ }
    await delay(100);
  }
  throw new Error(`Fixture startup timed out: ${logs}`);
}
async function stop() { if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
async function json(path, body, method = body ? 'POST' : 'GET', expected = 200) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, expected, path + ': ' + await response.clone().text()); return response.json();
}
async function configure(mode, allowed = true) {
  const card = await json('/api/agents/document-agent');
  return json('/api/agents/document-agent', { configurationRevision: card.configurationRevision,
    capabilities: { ...card.capabilities, skills: [skillId], mcpServers: [] },
    constraints: { ...card.constraints, allowedTools: allowed ? ['read_skill_file'] : [], approvalMode: mode } }, 'PUT');
}
async function run(workspaceId, name, route = '/api/agent/orchestrate') {
  const controller = new AbortController(), events = [];
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, message: 'approval-' + name + '：读取绑定资料，整理文档摘要，不联网。' }), signal: controller.signal });
  assert.equal(response.status, 200);
  const done = (async () => {
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
          const lines = block.split(/\r?\n/), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (data) events.push({ type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(), data: JSON.parse(data) });
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  void done.catch(() => {});
  streams.push({ controller, done });
  const waitFor = async predicate => {
    for (let i = 0; i < 400; i++) {
      const found = events.find(predicate); if (found) return found.data;
      if (events.some(event => event.type === 'complete')) throw new Error('Ended before expected event: ' + JSON.stringify(events.at(-1)));
      await delay(50);
    }
    controller.abort(); throw new Error('Expected event timed out');
  };
  return { controller, events, done, waitFor, scope: await waitFor(event => event.type === 'session') };
}
const snapshots = [];
try {
  await start();
  const workspaceId = (await json('/api/workspaces')).workspaces[0].id;
  const input = { name: '审批验收资料', description: '只在隔离验收实例使用', category: 'office', body: '按需读取 references/office.md。' };
  const pkg = createSkillPackageDraft(input);
  pkg.files = [{ path: 'references/office.md', url: 'https://example.com/office', content: marker, size: Buffer.byteLength(marker), encoding: 'utf8', status: 'included' }];
  skillId = (await json('/api/skills', { ...input, package: pkg }, 'POST', 201)).id;
  for (const mode of ['allow', 'deny', 'cancel', 'disconnect', 'auto_edit', 'forbidden']) {
    console.log('Checking approval case: ' + mode);
    await configure(mode === 'auto_edit' ? 'auto_edit' : 'suggest', mode !== 'forbidden');
    const before = resourceReceipts, task = await run(workspaceId, mode, mode === 'allow' ? '/api/agent/run' : undefined);
    if (!['auto_edit', 'forbidden'].includes(mode)) {
      const event = await task.waitFor(item => item.type === 'workflow_event' && item.data.data?.approval?.status === 'pending');
      const approval = event.data.approval;
      assert.equal(approval.runId, task.scope.runId); assert.equal(approval.sessionId, task.scope.sessionId); assert.ok(approval.taskId);
      assert.equal(resourceReceipts, before, 'No resource may be read before confirmation');
      assert.equal((await json('/api/approvals?' + new URLSearchParams(task.scope))).approvals.length, 1);
      const live = await json('/api/governance/events?runId=' + task.scope.runId);
      assert.ok(live.events.some(record => record.approval?.requestId === approval.requestId && !record.persisted));
      if (mode === 'allow') {
        await json('/api/approval/' + approval.requestId, { approved: true, runId: 'run-other', sessionId: task.scope.sessionId }, 'POST', 409);
        await json('/api/approval/' + approval.requestId, { approved: true }, 'POST', 400);
        assert.equal(resourceReceipts, before);
      }
      if (mode === 'cancel') await json('/api/runs/' + task.scope.runId + '/cancel', {}, 'POST', 202);
      else if (mode === 'disconnect') task.controller.abort();
      else {
        const decision = await json('/api/approval/' + approval.requestId, { approved: mode === 'allow', runId: task.scope.runId, sessionId: task.scope.sessionId });
        assert.equal(decision.approval.status, mode === 'allow' ? 'approved' : 'denied');
        await json('/api/approval/' + approval.requestId, { approved: true, runId: task.scope.runId, sessionId: task.scope.sessionId }, 'POST', 404);
      }
    }
    if (mode !== 'disconnect') await task.waitFor(event => event.type === 'complete');
    await task.done;
    let stored;
    for (let i = 0; i < 100; i++) {
      stored = (await json(`/api/workspaces/${workspaceId}/sessions/${task.scope.sessionId}`)).messages.at(-1);
      if (stored.run.status !== 'running') break;
      await delay(50);
    }
    assert.notEqual(stored.run.status, 'running'); assert.ok(stored.content.trim());
    assert.equal(resourceReceipts > before, ['allow', 'auto_edit'].includes(mode));
    const records = await json('/api/governance/events?limit=100&runId=' + task.scope.runId);
    const expected = stored.traces.filter(event => event.type === 'governance').map(event => event.eventId).sort();
    assert.deepEqual(records.events.map(event => event.id).sort(), expected);
    assert.ok(records.events.every(record => record.persisted));
    assert.equal(records.stats.costTimeline[0]?.cost, stored.cost);
    if (['auto_edit', 'forbidden'].includes(mode)) assert.ok(!stored.traces.some(event => event.data?.approval));
    else assert.ok(records.events.some(record => record.approval?.status === (mode === 'allow' ? 'approved' : mode === 'deny' ? 'denied' : 'cancelled')));
    if (mode !== 'disconnect') assert.equal(task.events.filter(event => event.type === 'complete').length, 1);
    snapshots.push({ mode, scope: task.scope, stored, records });
  }
  await json('/api/governance/events?before=invalid', undefined, 'GET', 400);
  await configure('suggest');
  await stop(); await start();
  for (const item of snapshots) {
    assert.deepEqual((await json(`/api/workspaces/${workspaceId}/sessions/${item.scope.sessionId}`)).messages.at(-1), item.stored);
    assert.deepEqual(await json('/api/governance/events?limit=100&runId=' + item.scope.runId), item.records);
    assert.deepEqual((await json('/api/approvals?' + new URLSearchParams(item.scope))).approvals, []);
  }
  const beforeCrash = resourceReceipts, interrupted = await run(workspaceId, 'restart-pending');
  const waiting = (await interrupted.waitFor(item => item.type === 'workflow_event' && item.data.data?.approval?.status === 'pending')).data.approval;
  await stop(); await interrupted.done.catch(() => {}); await start();
  const recovered = (await json(`/api/workspaces/${workspaceId}/sessions/${interrupted.scope.sessionId}`)).messages.at(-1);
  assert.equal(recovered.run.status, 'interrupted'); assert.ok(recovered.content.trim());
  assert.equal(resourceReceipts, beforeCrash, 'Restart must never replay pending tool calls');
  assert.deepEqual((await json('/api/approvals?' + new URLSearchParams(interrupted.scope))).approvals, []);
  await json('/api/approval/' + waiting.requestId, { approved: true, runId: interrupted.scope.runId, sessionId: interrupted.scope.sessionId }, 'POST', 404);
  const recoveredRecords = await json('/api/governance/events?runId=' + interrupted.scope.runId);
  assert.ok(recoveredRecords.events.some(record => record.approval?.requestId === waiting.requestId && record.persisted));
  console.log(JSON.stringify({ passed: true, cases: snapshots.length + 1, localModelCalls: calls, resourceReceipts, restart: true, interruptedApprovalNotReplayed: true, externalCalls: 0, userWrites: 0 }));
  if (serveMode) {
    console.log(JSON.stringify({ base, modelBase, workspaceId, cases: snapshots.map(item => ({ mode: item.mode, ...item.scope })) }));
    process.stdin.resume();
    await Promise.race([once(process.stdin, 'data'), once(process.stdin, 'end'), once(process, 'SIGINT'), once(process, 'SIGTERM')]);
    process.stdin.pause();
  }
} finally {
  streams.forEach(stream => stream.controller.abort());
  await Promise.allSettled(streams.map(stream => stream.done));
  await stop(); await new Promise(done => model.close(done));
  const rel = relative(tmpdir(), temporaryRoot); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(temporaryRoot, { recursive: true, force: true });
}
