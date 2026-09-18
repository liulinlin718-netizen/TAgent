import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { AnthropicProvider, OpenAIProvider } from '../packages/tagent-ai/src/index.js';
import { createMCPBridgeTool } from '../packages/tagent-core/src/tools/mcp-bridge.js';
import { newBrowserPage, closeSharedBrowser } from '../packages/tagent-core/src/tools/browser-pool.js';

const pids: number[] = [];
let requests = 0, aborted = 0;
const sockets = new Set<import('node:net').Socket>();
const telemetry = createServer(async (request, response) => {
  if (request.url === '/pids') {
    let body = ''; for await (const chunk of request) body += chunk;
    pids.push(...JSON.parse(body)); response.end('ok'); return;
  }
  requests++;
  request.resume();
  response.on('close', () => { if (!response.writableEnded) aborted++; });
});
telemetry.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
telemetry.listen(0, '127.0.0.1');
await once(telemetry, 'listening');
const base = `http://127.0.0.1:${(telemetry.address() as { port: number }).port}`;
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 120; i++) { if (predicate()) return; await delay(25); }
  throw new Error(`Timed out: ${label}`);
}

try {
  for (const provider of [new OpenAIProvider({ apiKey: 'fixture-only', baseURL: `${base}/v1`, maxRetries: 0 }),
    new AnthropicProvider({ apiKey: 'fixture-only', baseURL: base, maxRetries: 0 })]) {
    for (const mode of ['call', 'stream']) {
    const controller = new AbortController(), before = requests, beforeAbort = aborted;
    const params = { model: 'fixture', messages: [{ role: 'user' as const, content: 'local cancellation test' }], signal: controller.signal };
    const call = mode === 'call' ? provider.call(params) : (async () => { for await (const _event of provider.stream(params)) {} })();
    void call.catch(() => {});
    await until(() => requests > before, 'SDK HTTP request');
    controller.abort();
    await assert.rejects(call);
    await until(() => aborted > beforeAbort, 'SDK socket closed');
    console.log(`${provider.name} ${mode}: underlying HTTP request aborted`);
    }
  }

  const controller = new AbortController();
  const code = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
const req=require('node:http').request(${JSON.stringify(base + '/pids')},{method:'POST'},res=>res.resume());
req.end(JSON.stringify([process.pid,child.pid]));
process.stdin.resume();setInterval(()=>{},1000);`;
  const tool = createMCPBridgeTool({ id: 'fixture', name: 'fixture', type: 'stdio', command: process.execPath, args: ['-e', code], env: {}, executionApproved: true });
  const pending = tool.execute({ method: 'tools/list' }, { signal: controller.signal });
  await until(() => pids.length === 2, 'owned stdio process and child started');
  controller.abort();
  const output = await pending;
  assert.match(output, /取消/);
  await until(() => pids.every(pid => {
    try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
  }), 'both stdio processes exited');
  console.log('stdio MCP: parent and descendant exited before the tool returned');

  const browserController = new AbortController();
  const first = await newBrowserPage(undefined, browserController.signal);
  const second = await newBrowserPage();
  await second.page.setContent('<main>Independent browser task</main>');
  let entered = false, release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  await first.page.route('https://example.com/cancellation-fixture', async route => {
    entered = true; await gate; await route.abort().catch(() => {});
  });
  const navigation = first.page.goto('https://example.com/cancellation-fixture');
  void navigation.catch(() => {});
  await until(() => entered, 'browser navigation waiting');
  browserController.abort();
  await assert.rejects(navigation);
  await until(() => first.page.isClosed(), 'owned browser page closed');
  assert.equal(second.page.isClosed(), false);
  assert.equal(await second.page.locator('main').textContent(), 'Independent browser task');
  release();
  await second.ctx.close();
  console.log('browser: in-flight navigation stopped, unrelated task remains usable');
} finally {
  await closeSharedBrowser();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(done => telemetry.close(() => done()));
}
