import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { FilePersistence } from '../packages/tagent-core/dist/index.js';
import { Store, type TraceEvent } from '../packages/tagent-server/src/store.js';
import { buildResearchSmokePayload } from '../packages/tagent-server/src/research-smoke.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(join(tmpdir(), 'tagent-trace-api-'));
let child: ChildProcess | undefined, logs = '';
const store = await Store.open(new FilePersistence(root));
const workspaceId = store.listWorkspaces()[0].id;
const sessionId = (await store.createSession(workspaceId, '长任务执行记录验收'))!.id, runId = 'run-history-fixture';
const smoke = buildResearchSmokePayload('近 30 天 AI Agent 最新进展');
const traces: TraceEvent[] = smoke.events.map((event, i) => ({ ...event, eventId: `history-${i}`, runId, sessionId, timestamp: 1000 + i,
  ...(typeof event.data.agentId === 'string' ? { agentId: event.data.agentId } : {}) }));
traces.pop();
for (let i = 0; i < 125; i++) traces.push({ eventId: `history-extra-${i}`, runId, sessionId, timestamp: 2000 + i,
  agentId: i % 2 ? 'research-agent' : 'document-agent', type: i % 3 ? 'agent_tool_result' : 'governance',
  status: 'passed', summary: `来源检查 ${i}：中文资料与 URL 核对 🚀`, data: i % 3 ? { agentId: i % 2 ? 'research-agent' : 'document-agent', tool: 'web_research', resultLength: 420,
    detail: `验收文本 ${i} / ` + '边界测试文本'.repeat(60) } : { ruleName: 'source_quality', result: 'passed', message: '已保留来源标识', policyType: 'quality' } });
traces.push({ eventId: 'history-complete', runId, sessionId, timestamp: 3000, type: 'complete', status: 'complete', summary: '任务完成', data: { success: true, persistence: 'saved' } });
await store.beginRun(workspaceId, sessionId, runId, '检查长任务执行记录：中文 🚀 / symbols <>&');
const receipt = store.findRun(runId)!.message;
await store.finishRun(workspaceId, sessionId, runId, { ...receipt, content: '## 文档核对结果\n\n这是隔离验收实例的固定记录，不是实际联网调研结果。', traces,
  cost: .012, run: { ...receipt.run!, status: 'finished' } });
await fs.writeFile(join(root, 'empty.env'), '');
const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = (reservation.address() as { port: number }).port; await new Promise<void>(done => reservation.close(() => done()));
const base = `http://127.0.0.1:${port}`, traceURL = `/api/workspaces/${workspaceId}/sessions/${sessionId}/traces/${runId}`;
async function start() {
  child = spawn(process.execPath, [join(repository, 'packages/tagent-server/dist/index.js')], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TAGENT_WORKSPACE_ROOT: root, TAGENT_ENV_FILE: join(root, 'empty.env'),
      PORT: String(port), TAGENT_HOST: '127.0.0.1', NODE_ENV: 'test', DATABASE_URL: '', REDIS_URL: '',
      DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', TAGENT_LLM_PROVIDER: '',
      TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '', TAGENT_WEB_ORIGINS: 'http://127.0.0.1:3000,http://localhost:3000' } });
  child.stdout!.on('data', chunk => { logs = (logs + chunk).slice(-6000); }); child.stderr!.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error('Fixture exited: ' + logs);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Local startup. */ }
    await delay(100);
  }
  throw new Error('Fixture startup timed out: ' + logs);
}
async function stop() { if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
async function json(path: string, body?: unknown, method = body ? 'POST' : 'GET', status = 200) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, status, path + ': ' + await response.clone().text()); return response.json();
}
try {
  await start();
  await json('/api/trace/%2e%2e%2fprivate', undefined, 'GET', 404);
  await json(traceURL.replace(workspaceId, 'foreign'), undefined, 'GET', 404);
  await assert.rejects(fs.stat(join(root, '.tagent', 'workflow-index')), { code: 'ENOENT' });
  const first = await json(traceURL), events = [...first.events]; let cursor = first.nextCursor;
  while (cursor) { const next = await json(traceURL + '?' + new URLSearchParams({ cursor })); events.push(...next.events); cursor = next.nextCursor; }
  assert.deepEqual(events, traces);
  const filtered = await json(traceURL + '?type=governance&agentId=research-agent&limit=100');
  assert.deepEqual(filtered.events, traces.filter(e => e.type === 'governance' && e.agentId === 'research-agent'));
  const before = await fs.readFile(join(root, '.tagent', 'data', 'workspaces.json'));
  await stop(); await start();
  assert.deepEqual((await json(traceURL)).events, first.events);
  assert.equal((await json(traceURL + '?' + new URLSearchParams({ cursor: first.nextCursor }))).events[0].eventId, traces[40].eventId);
  assert.deepEqual(await fs.readFile(join(root, '.tagent', 'data', 'workspaces.json')), before);
  // Exercise both genuine SSE handlers without paid SDK or network calls.
  for (const route of ['/api/agent/run', '/api/agent/orchestrate']) {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, message: '近 30 天 AI Agent 最新进展', mode: 'research_smoke' }), signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    const streamed = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map(block => {
      const lines = block.split(/\r?\n/); return { type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(),
        data: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')) };
    });
    const scope = streamed.find(e => e.type === 'session')!.data;
    assert.equal(streamed.filter(e => e.type === 'complete').length, 1);
    const history = await json(`/api/workspaces/${workspaceId}/sessions/${scope.sessionId}/traces/${scope.runId}?limit=100`);
    assert.deepEqual(history.events, streamed.filter(e => e.type === 'workflow_event').map(e => e.data));
    assert.ok(history.events.some((e: TraceEvent) => e.toolName === 'web_research'));
    const saved = await json(`/api/workspaces/${workspaceId}/sessions/${scope.sessionId}`);
    assert.ok(saved.messages.at(-1).content.trim()); assert.equal(saved.messages.at(-1).run.status, 'finished');
    assert.deepEqual((await json(`/api/workspaces/${workspaceId}/sessions/${scope.sessionId}`, undefined, 'DELETE')).warnings, []);
    await json(`/api/trace/${scope.sessionId}?runId=${scope.runId}`, undefined, 'GET', 404);
  }
  console.log(JSON.stringify({ passed: true, events: traces.length, restart: true, pagination: true, sseRuns: 2, externalCalls: 0, userWrites: 0 }));
  if (process.argv.includes('--serve')) {
    console.log(JSON.stringify({ base, workspaceId, sessionId, runId, traceURL, events: traces.length }));
    process.stdin.resume(); await Promise.race([once(process.stdin, 'data'), once(process.stdin, 'end'), once(process, 'SIGINT'), once(process, 'SIGTERM')]); process.stdin.pause();
  }
} finally {
  await stop();
  const rel = relative(tmpdir(), root); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await fs.rm(root, { recursive: true, force: true });
}
