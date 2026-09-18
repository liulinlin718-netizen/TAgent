import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { OpenAIProvider, type LLMCallParams } from '../packages/tagent-ai/src/index.js';
import { loadServerEnvironment, resolveModelConfig } from '../packages/tagent-server/src/config.js';
import { acceptanceOptions, createAcceptanceProvider, reserveAcceptanceCost } from './model-acceptance.js';

// One-off, explicitly authorized synthetic acceptance. Never part of CI or app startup.
const limits = acceptanceOptions(process.argv.slice(2));
assert.equal(limits.positional.length, 0);
const root = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = resolve(root, 'output/office-budget-20260918-additional-020.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.status, 'first_process_finished');
const previous = JSON.parse(await readFile(resolve(root, 'output/office-delivery-1789704637205/project.json'), 'utf8'));
assert.equal(previous.acceptance.unsettledRequests, 0);
assert.equal(previous.acceptance.activeCalls, 0);
assert.equal(previous.acceptance.reservedCost, 0);
assert.equal(limits.maxCalls, manifest.maxCalls - previous.acceptance.calls);
assert.ok(limits.maxRecordedCost <= manifest.maxEstimatedCostUSD - previous.acceptance.recordedCost + 1e-10);
const tasks: Record<string, string> = {};
for (const role of ['research', 'project']) {
  tasks[role] = JSON.parse(await readFile(resolve(root, `output/office-delivery-1789704637205/${role}.json`), 'utf8')).task;
}
loadServerEnvironment(root);
const config = resolveModelConfig();
assert.equal(config.name, 'deepseek');
assert.equal(config.baseURL?.replace(/\/$/, ''), 'https://api.deepseek.com');
assert.equal(config.model, 'deepseek-flash');
const directory = resolve(root, `output/office-ui-live-${Date.now()}`);
await mkdir(directory);
// Exclusive claim survives a crash; a second process must not reset the remaining allowance.
await writeFile(resolve(root, 'output/office-budget-20260918-additional-020-ui.claim'), directory, { flag: 'wx' });
const sdk = new OpenAIProvider({ ...config, maxRetries: 0, timeout: 120000 });
const requests: unknown[] = [];
let status = 'starting';
async function checkpoint() {
  await writeFile(resolve(directory, 'receipts.json'), JSON.stringify({ status, directory, tasks, acceptance: acceptance.snapshot(),
    previous: previous.acceptance, requests }, null, 2), 'utf8');
}
const acceptance = createAcceptanceProvider({ name: sdk.name,
  async call(params) { await checkpoint(); return sdk.call(params); },
  async *stream() { throw new Error('Streaming model requests are not enabled in this bounded acceptance'); },
}, limits, reserveAcceptanceCost);
let child: ReturnType<typeof spawn> | undefined, logs = '', ready = false;
const stopPath = `/stop-${randomUUID()}`;
const token = randomUUID();
let done!: () => void;
const finished = new Promise<void>(accept => { done = accept; });
const bridge = createServer(async (req, res) => {
  if (req.url === stopPath && req.method === 'POST') { res.end('Stopping'); done(); return; }
  if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return; }
  try {
    assert.ok(ready);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let raw = '';
    for await (const chunk of req) { raw += chunk; assert.ok(raw.length < 200000); }
    const input = JSON.parse(raw);
    assert.equal(input.model, 'deepseek-flash');
    assert.ok(!input.stream && !input.tools?.length, 'No streaming model calls or tool definitions');
    assert.ok(Array.isArray(input.messages) && input.messages.every((message: Record<string, unknown>) =>
      ['system', 'user', 'assistant'].includes(String(message.role)) && typeof message.content === 'string' && !message.tool_calls));
    const text = input.messages.map((message: { content: string }) => message.content).join('\n');
    const role = Object.keys(tasks).find(name => text.includes(tasks[name]!) || text.includes(JSON.stringify(tasks[name]!).slice(1, -1)));
    assert.ok(role, 'Request must contain an exact authorized synthetic task');
    const params: LLMCallParams = { model: config.model, messages: input.messages, maxTokens: input.max_tokens,
      temperature: input.temperature, reasoning: input.thinking?.type === 'enabled' ? 'low' : 'disabled', signal: AbortSignal.timeout(120000) };
    const result = await acceptance.provider.call(params);
    requests.push({ role, result });
    await checkpoint();
    assert.equal(result.toolCalls.length, 0, 'Unexpected model tool request; do not execute');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion', model: config.model,
      choices: [{ index: 0, message: { role: 'assistant', content: result.content }, finish_reason: result.stopReason === 'end' ? 'stop' : result.stopReason === 'max_tokens' ? 'length' : 'unknown' }],
      usage: { prompt_tokens: result.usage.inputTokens, completion_tokens: result.usage.outputTokens,
        total_tokens: result.usage.inputTokens + result.usage.outputTokens } }));
  } catch (error) {
    requests.push({ error: error instanceof Error ? error.message : String(error) });
    await checkpoint();
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Bounded acceptance request refused or failed; inspect local receipts. No retry.' } }));
  }
});
bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
const bridgePort = (bridge.address() as { port: number }).port;
const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = (reservation.address() as { port: number }).port;
await new Promise<void>(accept => reservation.close(() => accept()));
const base = `http://127.0.0.1:${port}`;
const env: NodeJS.ProcessEnv = {};
for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
Object.assign(env, { TAGENT_WORKSPACE_ROOT: directory, TAGENT_ENV_FILE: '', PORT: String(port), TAGENT_HOST: '127.0.0.1',
  NODE_ENV: 'test', DATABASE_URL: '', REDIS_URL: '', DEEPSEEK_API_KEY: token, DEEPSEEK_BASE_URL: `http://127.0.0.1:${bridgePort}/v1`,
  TAGENT_LLM_PROVIDER: 'deepseek', TAGENT_LLM_MODEL: config.model, TAGENT_LLM_TIMEOUT_MS: '130000', TAGENT_RUN_TIMEOUT_MS: '180000',
  TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '', TAGENT_WEB_ORIGINS: 'http://127.0.0.1:3000' });
async function json(path: string, body?: unknown) {
  const response = await fetch(base + path, { method: body ? 'PUT' : 'GET', headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok, `HTTP ${response.status} ${path}`); return response.json();
}
const deadline = setTimeout(done, 15 * 60_000);
try {
  child = spawn(process.execPath, [resolve(root, 'packages/tagent-server/dist/index.js')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', data => { logs = (logs + data).slice(-4000); }); child.stderr?.on('data', data => { logs = (logs + data).slice(-4000); });
  for (let attempt = 0; attempt < 150; attempt++) {
    assert.equal(child.exitCode, null, logs);
    try { await json('/api/health'); break; } catch { if (attempt === 149) throw new Error('Isolated backend startup failed'); }
    await delay(100);
  }
  const { agents } = await json('/api/agents/resident');
  for (const agent of agents) await json(`/api/agents/${agent.id}`, { ...agent, capabilities: { ...agent.capabilities, mcpServers: [] },
    constraints: { ...agent.constraints, allowedTools: [], maxCostPerTask: 0.2 } });
  const configured = await json('/api/agents/resident');
  assert.ok(configured.agents.every((agent: { constraints: { allowedTools: string[] }; capabilities: { mcpServers: string[] } }) =>
    !agent.constraints.allowedTools.length && !agent.capabilities.mcpServers.length));
  ready = true; status = 'ready'; await checkpoint();
  const state = { base, directory, tasks, stopURL: `http://127.0.0.1:${bridgePort}${stopPath}`, limits };
  await writeFile(resolve(directory, 'browser-state.json'), JSON.stringify(state, null, 2), 'utf8');
  console.log(JSON.stringify(state));
  await finished;
} finally {
  ready = false; clearTimeout(deadline);
  if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
  await new Promise<void>(accept => bridge.close(() => accept()));
  status = 'finished'; await checkpoint();
  console.log(JSON.stringify({ directory, ...acceptance.snapshot() }));
}
