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
const root = await fs.mkdtemp(join(tmpdir(), 'tagent-session-context-'));
const store = await Store.open(new FilePersistence(root)), workspaceId = store.listWorkspaces()[0].id;
const parentId = (await store.createSession(workspaceId, '主线：项目预算'))!.id;
await store.addMessage(workspaceId, parentId, { id: 'seed-user', role: 'user', content: 'SEED_BUDGET_1200：预算1200元，禁止外部安装。', timestamp: new Date().toISOString() });
await store.addMessage(workspaceId, parentId, { id: 'seed-answer', role: 'assistant', content: '预算已记录，尚未执行任何外部操作。', timestamp: new Date().toISOString() });
const branchId = (await store.forkSession(workspaceId, parentId, 'fork_full'))!.id;
const excerpt = 'BRANCH_ONLY_NOTE：中文🚀 / Docker: $0.01，待核实材料。';
await store.addMessage(workspaceId, branchId, { id: 'branch-result', role: 'assistant',
  content: '## 分支备选方案\n\n' + '该段是本机验收资料，保留原文与边界，不能当作已批准操作。\n'.repeat(18) + '\n' + excerpt,
  timestamp: new Date().toISOString() });
await fs.writeFile(join(root, 'empty.env'), '');
let child: ChildProcess | undefined, logs = '', provider = 'deepseek', failModel = false;
const calls: Array<{ sdk: string; body: Record<string, any>; system: string; text: string }> = [];
const modelServer = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const system = body.system || body.messages.find((message: any) => message.role === 'system')?.content || '';
  const last = body.messages.at(-1).content;
  const text = typeof last === 'string' ? last : last.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('');
  const sdk = req.url?.includes('messages') ? 'anthropic' : 'openai'; calls.push({ sdk, body, system, text });
  res.setHeader('Content-Type', 'application/json');
  if (failModel) { res.writeHead(503); res.end(JSON.stringify({ error: { message: 'Local fixture unavailable', type: 'overloaded_error' } })); return; }
  let content: string;
  if (system.includes('你是任务编排器')) content = '[{"id":"d","agentRole":"document","objective":"依据会话内已有材料整理备忘，不联网"}]';
  else if (system.includes('你是办公交付核对器')) {
    const input = JSON.parse(text);
    content = JSON.stringify({ areas: ['instructions', 'material_consistency', 'arithmetic', 'deliverable', 'actions'].map(area => ({ area, status: 'passed', reason: '本机夹具结构验收，不代表真实质量评价。' })),
      blocks: input.blocks.map((block: any) => ({ index: block.index, verdict: 'non_factual', reason: '夹具输出。', evidence: [] })), lengthLimits: [], calculations: [] });
  } else content = '本机验收结果，已收到参考：' + ['SEED_BUDGET_1200', 'PARENT_LATER_ONLY', 'BRANCH_ONLY_NOTE'].filter(marker => text.includes(marker)).join('、') + '。';
  res.end(JSON.stringify(sdk === 'anthropic' ? { id: 'local-message', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text: content }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 30 } }
    : { id: 'local-completion', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }));
}).listen(0, '127.0.0.1'); await once(modelServer, 'listening');
const modelBase = `http://127.0.0.1:${(modelServer.address() as { port: number }).port}`;
const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = (reservation.address() as { port: number }).port; await new Promise<void>(done => reservation.close(() => done()));
const base = `http://127.0.0.1:${port}`, sessionPath = (id: string) => `/api/workspaces/${workspaceId}/sessions/${id}`;
async function start() {
  child = spawn(process.execPath, [join(repository, 'packages/tagent-server/dist/index.js')], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TAGENT_WORKSPACE_ROOT: root, TAGENT_ENV_FILE: join(root, 'empty.env'), PORT: String(port), TAGENT_HOST: '127.0.0.1',
      NODE_ENV: 'test', DATABASE_URL: '', REDIS_URL: '', TAGENT_LLM_PROVIDER: provider, TAGENT_LLM_MODEL: provider === 'deepseek' ? 'deepseek-chat' : 'claude-sonnet-4-20250514',
      DEEPSEEK_API_KEY: 'local-fixture-only', DEEPSEEK_BASE_URL: modelBase + '/v1', ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: modelBase,
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
async function json(path: string, body?: unknown, status = 200) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, status, await response.clone().text()); return response.json();
}
async function run(id: string | undefined, message: string, route = '/api/agent/orchestrate') {
  const before = calls.length;
  const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, sessionId: id, message }), signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200);
  const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const lines = block.split(/\r?\n/); return { type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(),
      data: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')) };
  });
  const finals = events.filter(event => event.type === 'complete'); assert.equal(finals.length, 1);
  assert.ok(finals[0].data.output.trim());
  const saved = await json(sessionPath(finals[0].data.sessionId));
  assert.equal(saved.messages.at(-1).content, finals[0].data.output); assert.equal(saved.messages.at(-1).run.status, 'finished');
  const current = calls.slice(before);
  assert.ok(current.every(call => call.body.messages.every((message: any) => message.role !== 'tool'
    && !message.tool_calls && (!Array.isArray(message.content) || message.content.every((block: any) => block.type === 'text')))), 'Historical tools must never become SDK protocol blocks');
  return { saved, current, events, result: finals[0].data };
}
try {
  await start();
  await json(`/api/workspaces/${workspaceId}/sessions/tree`);
  await json(sessionPath('missing') + '/messages', undefined, 404);
  await json(sessionPath(parentId) + '/memory?depth=NaN', undefined, 400);
  const callsBefore = calls.length;
  await json(sessionPath(parentId) + '/fork', { forkType: 'fork_summary' }, 400);
  await json(sessionPath(branchId) + '/merge-to-parent', {}, 400);
  assert.equal(calls.length, callsBefore);
  for (const nextProvider of ['deepseek', 'anthropic']) {
    if (nextProvider !== provider) { await stop(); provider = nextProvider; await start(); }
    const followup = await run(parentId, '按刚才的预算整理备忘。', nextProvider === 'deepseek' ? '/api/agent/orchestrate' : '/api/agent/run');
    assert.ok(followup.current.length >= 4);
    assert.ok(followup.current.every(call => call.text.includes('SEED_BUDGET_1200')), 'Every stage receives the supplied history');
    assert.ok(followup.events.some(event => event.type === 'workflow_event' && event.data.type === 'context_loaded'));
    assert.ok(!JSON.stringify(followup.saved.messages.at(-1).run.context).includes('SEED_BUDGET_1200'), 'Trace receipt contains hashes, not reference text');
    assert.equal(followup.result.success, true);
    const blank = await run(undefined, '写一句问候。');
    assert.ok(blank.current.every(call => !call.text.includes('SEED_BUDGET_1200') && !call.text.includes('BRANCH_ONLY_NOTE')));
  }
  await run(parentId, 'PARENT_LATER_ONLY：新主线备注。');
  const branch = await run(branchId, '整理本分支材料。');
  assert.ok(branch.current.every(call => !call.text.includes('PARENT_LATER_ONLY')));
  assert.ok(branch.current.every(call => call.text.includes('BRANCH_ONLY_NOTE')));
  const preBytes = await fs.readFile(join(root, '.tagent/data/workspaces.json'));
  const count = calls.length, input = { messageId: 'branch-result', text: excerpt };
  const preview = await json(sessionPath(branchId) + '/quote-preview', input);
  assert.deepEqual(await fs.readFile(join(root, '.tagent/data/workspaces.json')), preBytes);
  assert.equal(preview.willWrite, false); assert.equal(preview.willExecute, false); assert.equal(preview.requiresConfirmation, true);
  const body = { ...input, confirmed: true, fingerprint: preview.fingerprint };
  const quoted = await json(sessionPath(branchId) + '/merge-to-parent', body);
  assert.equal(quoted.created, true); assert.equal((await json(sessionPath(branchId) + '/merge-to-parent', body)).created, false);
  assert.equal(calls.length, count, 'Quote is never a model call');
  const followQuote = await run(parentId, '结合刚引用的材料继续。');
  assert.ok(followQuote.current.every(call => call.text.includes('BRANCH_ONLY_NOTE')));
  assert.ok(followQuote.saved.messages.at(-1).run.context.items.some((item: any) => item.kind === 'quoted_excerpt'));
  const saved = await json(sessionPath(parentId)); await stop(); await start();
  assert.deepEqual(await json(sessionPath(parentId)), saved);
  failModel = true;
  const failed = await run(parentId, '继续。'); failModel = false;
  assert.equal(failed.result.success, false);
  assert.ok(failed.saved.messages.at(-1).run.context.items.length > 0);
  console.log(JSON.stringify({ passed: true, localModelCalls: calls.length, sdks: [...new Set(calls.map(call => call.sdk))], restart: true,
    contextStages: true, branchIsolation: true, manualQuote: true, externalModelCalls: 0, userWrites: 0 }));
  if (process.argv.includes('--serve')) {
    console.log(JSON.stringify({ base, workspaceId, parentId, branchId, excerpt }));
    process.stdin.resume(); await Promise.race([once(process.stdin, 'data'), once(process.stdin, 'end'), once(process, 'SIGINT'), once(process, 'SIGTERM')]); process.stdin.pause();
  }
} finally {
  await stop(); await new Promise<void>(done => { modelServer.closeAllConnections(); modelServer.close(() => done()); });
  const rel = relative(tmpdir(), root); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await fs.rm(root, { recursive: true, force: true });
}
