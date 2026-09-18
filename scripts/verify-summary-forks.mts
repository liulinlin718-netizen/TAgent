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
import { Store } from '../packages/tagent-server/src/store.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(join(tmpdir(), 'tagent-summary-forks-'));
const safe = (path: string) => { const rel = relative(root, path); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel)); return path; };
const file = safe(join(root, '.tagent/data/workspaces.json')), backup = safe(join(root, '.tagent/data/workspaces.json.backup'));
const store = await Store.open(new FilePersistence(root)), workspaceId = store.listWorkspaces()[0].id;
const sources: Record<string, string> = {};
for (const key of ['deepseek', 'anthropic', 'invalid', 'cancel', 'crash', 'save', 'ui']) {
  const session = (await store.createSession(workspaceId))!; sources[key] = session.id;
  await store.addMessage(workspaceId, session.id, { id: key + '-user', role: 'user', content: `SUMMARY_${key.toUpperCase()}：中文🚀预算1200元，禁止外部安装。`, timestamp: new Date().toISOString() });
  await store.addMessage(workspaceId, session.id, { id: key + '-assistant', role: 'assistant', content: '尚未执行任何操作。请先核实材料。', timestamp: new Date().toISOString() });
}
await fs.writeFile(join(root, 'empty.env'), '');
let child: ChildProcess | undefined, logs = '', provider = 'deepseek', mode = 'success', broken = false;
const calls: Array<{ sdk: string; input: any }> = [];
async function breakStorage() { if (!broken) { await fs.rename(file, backup); await fs.mkdir(file); broken = true; } }
async function restoreStorage() { if (broken) { await fs.rmdir(file); await fs.rename(backup, file); broken = false; } }
const model = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.end(); return; }
  if (req.url === '/fixture/state') { res.end(JSON.stringify({ calls: calls.length, mode, broken })); return; }
  if (req.url?.startsWith('/fixture/mode/')) {
    mode = req.url.split('/').at(-1)!; assert.ok(['success', 'invalid', 'hold', 'save-failure'].includes(mode));
    if (mode !== 'save-failure') await restoreStorage(); res.end('{}'); return;
  }
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const system = body.system || body.messages.find((item: any) => item.role === 'system')?.content;
  assert.ok(system.includes('你是会话摘要提取器')); assert.ok(!body.tools?.length);
  const last = body.messages.at(-1).content;
  const input = JSON.parse(typeof last === 'string' ? last : last.filter((item: any) => item.type === 'text').map((item: any) => item.text).join(''));
  const sdk = req.url?.includes('messages') ? 'anthropic' : 'openai'; calls.push({ sdk, input });
  if (mode === 'hold') return;
  if (mode === 'save-failure') await breakStorage();
  const source = input.messages.find((message: any) => message.role === 'assistant') || input.messages[0];
  const content = JSON.stringify({ excerpts: [{ messageId: source.id, quote: mode === 'invalid' ? '模型编造，不是来源原文。' : source.content }] });
  res.end(JSON.stringify(sdk === 'anthropic' ? { id: 'local-summary', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text: content }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 30 } }
    : { id: 'local-summary', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }));
}).listen(0, '127.0.0.1'); await once(model, 'listening');
const control = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = (reservation.address() as { port: number }).port; await new Promise<void>(done => reservation.close(() => done()));
const base = `http://127.0.0.1:${port}`, path = (key: string) => `/api/workspaces/${workspaceId}/sessions/${sources[key]}`;
async function start() {
  child = spawn(process.execPath, [join(repository, 'packages/tagent-server/dist/index.js')], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TAGENT_WORKSPACE_ROOT: root, TAGENT_ENV_FILE: join(root, 'empty.env'), PORT: String(port), TAGENT_HOST: '127.0.0.1',
      NODE_ENV: 'test', DATABASE_URL: '', REDIS_URL: '', TAGENT_LLM_PROVIDER: provider, TAGENT_LLM_MODEL: provider === 'deepseek' ? 'deepseek-chat' : 'claude-sonnet-4-20250514',
      DEEPSEEK_API_KEY: 'local-fixture-only', DEEPSEEK_BASE_URL: control + '/v1', ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: control,
      OPENAI_API_KEY: '', TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '', TAGENT_WEB_ORIGINS: 'http://127.0.0.1:3000,http://localhost:3000' } });
  child.stdout!.on('data', chunk => { logs = (logs + chunk).slice(-8000); }); child.stderr!.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error('Fixture exited: ' + logs);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Local readiness. */ }
    await delay(100);
  }
  throw new Error('Fixture not ready: ' + logs);
}
async function stop() { if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
async function json(url: string, body?: unknown, status = 200) {
  const response = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, status, await response.clone().text()); return response.json();
}
async function begin(key: string) {
  const before = calls.length, bytes = await fs.readFile(file);
  const consent = await json(path(key) + '/fork/preview', { preservedMessageIds: [key + '-user'] });
  assert.equal(consent.preview.willWrite, false); assert.equal(consent.preview.willExecute, false); assert.equal(consent.preview.requiresConfirmation, true);
  assert.equal(calls.length, before); assert.deepEqual(await fs.readFile(file), bytes);
  const body = { forkType: 'fork_summary', confirmed: true, previewId: consent.id, token: consent.token };
  await json(path(key) + '/fork', body, 202); await json(path(key) + '/fork', body, 202);
  for (let i = 0; i < 150 && calls.length === before; i++) await delay(10);
  assert.equal(calls.length, before + 1, 'Exactly one local SDK request reaches the model fixture');
  return { consent, body, before };
}
async function terminal(key: string, id: string) {
  for (let i = 0; i < 150; i++) {
    const view = await json(path(key) + '/summary-forks/' + id);
    if (!view.persisted || !['running', 'ready'].includes(view.record.status)) return view;
    await delay(50);
  }
  throw new Error('Summary remained pending');
}
try {
  for (const key of ['deepseek', 'anthropic']) {
    provider = key; await start();
    await json(path(key) + '/fork', { forkType: 'fork_summary', confirmed: true }, 400);
    const { consent, body, before } = await begin(key), result = await terminal(key, consent.id);
    assert.equal(result.record.status, 'completed'); assert.equal(calls.length, before + 1);
    assert.ok(calls.at(-1)!.input.messages.every((item: any) => item.id !== key + '-user'));
    const source = await json(path(key)), childSession = await json(`/api/workspaces/${workspaceId}/sessions/${result.record.targetSessionId}`);
    assert.equal(childSession.messages[0].contextKind, 'fork_summary'); assert.equal(childSession.messages[1].content, source.messages[0].content);
    assert.ok(source.totalCost > 0); assert.equal(childSession.totalCost, 0);
    await stop(); await start(); assert.deepEqual(await json(path(key)), source);
    await json(path(key) + '/fork', body, 202); assert.equal(calls.length, before + 1); await stop();
  }
  provider = 'deepseek'; await start(); mode = 'invalid';
  let run = await begin('invalid'); assert.equal((await terminal('invalid', run.consent.id)).record.status, 'failed');
  mode = 'hold'; run = await begin('cancel');
  await json(path('cancel') + '/summary-forks/' + run.consent.id + '/cancel', {});
  assert.equal((await terminal('cancel', run.consent.id)).record.status, 'interrupted');
  run = await begin('crash'); await stop(); mode = 'success'; await start();
  const recovered = await terminal('crash', run.consent.id); assert.equal(recovered.record.status, 'interrupted'); assert.equal(recovered.record.usage.unsettledRequests, 1);
  assert.equal(calls.length, run.before + 1);
  mode = 'save-failure'; run = await begin('save'); const unsaved = await terminal('save', run.consent.id);
  assert.equal(unsaved.canRetrySave, true); assert.equal(unsaved.persisted, false);
  await restoreStorage(); mode = 'success';
  const saved = await json(path('save') + '/summary-forks/' + run.consent.id + '/retry-save', {});
  assert.equal(saved.record.status, 'completed'); assert.equal(calls.length, run.before + 1);
  await stop();
  const snapshot = JSON.parse(await fs.readFile(file, 'utf8'));
  const workspace = snapshot.find((item: any) => item.id === workspaceId), source = workspace.sessions.find((item: any) => item.id === sources.save);
  source.summaryForks[0].status = 'ready'; workspace.sessions = workspace.sessions.filter((item: any) => item.id !== saved.record.targetSessionId);
  await fs.writeFile(file, JSON.stringify(snapshot), 'utf8');
  await start();
  assert.equal((await terminal('save', run.consent.id)).record.status, 'completed');
  assert.equal((await json(path('save'))).totalCost, source.totalCost); assert.equal(calls.length, run.before + 1);
  console.log(JSON.stringify({ passed: true, localModelCalls: calls.length, sdks: [...new Set(calls.map(call => call.sdk))],
    previewReadOnly: true, idempotent: true, cancel: true, restart: true, preparedSnapshotRecovery: true, realDiskFailure: true, externalModelCalls: 0, userWrites: 0 }));
  if (process.argv.includes('--serve')) {
    console.log(JSON.stringify({ base, control, workspaceId, sessionId: sources.ui }));
    process.stdin.resume(); await Promise.race([once(process.stdin, 'data'), once(process.stdin, 'end'), once(process, 'SIGINT'), once(process, 'SIGTERM')]); process.stdin.pause();
  }
} finally {
  await stop(); await restoreStorage(); model.closeAllConnections(); await new Promise<void>(done => model.close(() => done()));
  const rel = relative(tmpdir(), root); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel)); await fs.rm(root, { recursive: true, force: true });
}
