import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as reservePort } from 'node:net';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/tagent-server/package.json'));
const WebSocket = require('ws');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tagent-access-'));
const token = 'tagent-acceptance-only-access-code-not-for-deployment';
const ui = process.argv.includes('--ui');
const children = [];
const sockets = [];
let proxy;

async function freePort() {
  const server = reservePort().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
const backendPort = await freePort();
const frontendPort = await freePort();
const proxyPort = await freePort();
const base = `http://127.0.0.1:${backendPort}`;
const origin = ui ? `http://127.0.0.1:${proxyPort}` : 'http://localhost:3000';
const authHeaders = { Origin: origin, 'Content-Type': 'application/json', 'X-Tagent-Request': '1' };

function launch(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  child.logs = '';
  child.stdout.on('data', value => { child.logs = (child.logs + value.toString()).slice(-5000); });
  child.stderr.on('data', value => { child.logs = (child.logs + value.toString()).slice(-5000); });
  children.push(child);
  return child;
}
async function ready(url, child) {
  for (let index = 0; index < 100; index++) {
    if (child.exitCode !== null) throw new Error(`Test process exited: ${child.logs}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Await this child only. */ }
    await delay(100);
  }
  throw new Error(`Readiness timed out for test process: ${child.logs}`);
}
async function request(path, body, cookie, method = body === undefined ? 'GET' : 'POST') {
  return fetch(base + path, { method, headers: { ...authHeaders, ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
}
async function deniedSocket(headers, status) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers, handshakeTimeout: 3000 });
    sockets.push(ws);
    let receivedResponse = false;
    ws.on('error', error => { if (!receivedResponse) reject(error); });
    ws.on('open', () => { ws.close(); reject(new Error('Unauthorized WebSocket opened')); });
    ws.on('unexpected-response', (_request, response) => {
      receivedResponse = true;
      response.resume(); ws.terminate();
      try { assert.equal(response.statusCode, status); resolve(); } catch (error) { reject(error); }
    });
  });
}

try {
  const backend = launch([join(root, 'packages/tagent-server/dist/index.js')], root, {
    ...process.env, NODE_ENV: 'test', PORT: String(backendPort), TAGENT_HOST: '127.0.0.1',
    TAGENT_WORKSPACE_ROOT: temporaryRoot, TAGENT_ENV_FILE: '', DATABASE_URL: '', REDIS_URL: '',
    DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', TAGENT_LLM_PROVIDER: '',
    TAGENT_ACCESS_TOKEN: token, TAGENT_PUBLIC_ORIGIN: '', TAGENT_WEB_ORIGINS: origin,
  });
  await ready(base + '/api/health', backend);
  assert.deepEqual(await (await request('/api/health')).json(), { status: 'ok', access: 'protected' });
  for (const endpoint of ['/api/workspaces', '/api/agents', '/api/skills', '/api/mcp', '/api/team/export', '/api/metrics', '/api/runs/missing',
    '/api/trace/missing', '/api/workspaces/missing/sessions/missing/traces', '/api/workspaces/missing/sessions/missing/traces/run-missing']) {
    assert.equal((await request(endpoint)).status, 401, endpoint);
  }
  for (const endpoint of ['/api/agent/run', '/api/agent/orchestrate', '/api/skills/import/preview', '/api/agents/research-agent/benchmark/run', '/api/approval/missing', '/api/runs/missing/cancel',
    '/api/workspaces/missing/sessions/missing/quote-preview', '/api/workspaces/missing/sessions/missing/merge-to-parent',
    '/api/workspaces/missing/sessions/missing/fork/preview', '/api/workspaces/missing/sessions/missing/fork',
    '/api/workspaces/missing/sessions/missing/summary-forks/missing/cancel', '/api/workspaces/missing/sessions/missing/summary-forks/missing/retry-save']) {
    assert.equal((await request(endpoint, { message: 'Should not execute' })).status, 401, endpoint);
  }
  assert.equal((await request('/api/auth/login', { token: 'wrong' })).status, 401);
  const login = await request('/api/auth/login', { token });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.ok(login.headers.get('set-cookie').includes('HttpOnly'));
  const workspace = await (await request('/api/workspaces', { name: '访问控制验收工作区' }, cookie)).json();
  const session = await (await request(`/api/workspaces/${workspace.id}/sessions`, { title: 'Auth regression' }, cookie)).json();
  assert.ok(session.id);
  await deniedSocket({ Origin: origin }, 401);
  await deniedSocket({ Origin: 'https://evil.example', Cookie: cookie }, 403);
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Origin: origin, Cookie: cookie }, handshakeTimeout: 3000 });
  sockets.push(ws);
  await once(ws, 'open');
  const joined = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'join', sessionId: session.id }));
  assert.equal(JSON.parse(String((await joined)[0])).type, 'joined');
  assert.equal((await request('/api/approval/missing', { approved: 'yes' }, cookie)).status, 400);
  assert.equal((await request('/api/auth/logout', {}, cookie)).status, 200);
  assert.equal((await request('/api/workspaces', undefined, cookie)).status, 401);
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'join', sessionId: session.id }));
  assert.equal((await closed)[0], 1008, 'Existing socket must reject a revoked session');
  console.log('PASS: protected HTTP APIs, login, UTF-8 storage, logout revocation, real WebSocket origin/auth/revocation');

  if (ui) {
    const frontend = launch([join(root, 'packages/tagent-web/node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(frontendPort)], join(root, 'packages/tagent-web'), process.env);
    await ready(`http://127.0.0.1:${frontendPort}`, frontend);
    proxy = createServer((req, res) => {
      const port = req.url.startsWith('/api/') ? backendPort : frontendPort;
      const upstream = httpRequest({ hostname: '127.0.0.1', port, path: req.url, method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${port}` } }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end('Test upstream unavailable'); });
      req.pipe(upstream);
    }).listen(proxyPort, '127.0.0.1');
    await once(proxy, 'listening');
    console.log(`UI_ACCEPTANCE_URL=${origin}`);
    console.log(`TEST_ONLY_ACCESS_CODE=${token}`);
    console.log('Type stop to close this isolated acceptance instance.');
    await new Promise(done => {
      process.stdin.setEncoding('utf8'); process.stdin.resume();
      process.stdin.on('data', value => { if (value.includes('stop')) done(); });
      process.once('SIGINT', done);
    });
    process.stdin.pause();
  }
} finally {
  for (const ws of sockets) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  if (proxy) { proxy.closeAllConnections(); await new Promise(done => proxy.close(done)); }
  for (const child of children.reverse()) {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
  const inside = relative(tmpdir(), temporaryRoot);
  assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
  assert.ok(temporaryRoot.startsWith(join(tmpdir(), 'tagent-access-')));
  await rm(temporaryRoot, { recursive: true, force: true });
}
