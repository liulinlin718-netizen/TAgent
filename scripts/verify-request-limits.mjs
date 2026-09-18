import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as controlServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, checkEnvironment } from './check.mjs';

const require = createRequire(join(root, 'packages/tagent-server/package.json'));
const WebSocket = require('ws');
const temp = await mkdtemp(join(tmpdir(), 'tagent-request-limits-'));
const token = 'isolated-request-limit-test-token-not-for-deployment';
const origin = 'http://127.0.0.1:3000';
const sockets = new Set();
let child, control, base, wsAttempts = 0;
const keepServing = process.argv.includes('--serve');
const free = createServer().listen(0, '127.0.0.1');
await once(free, 'listening');
const port = free.address().port;
await new Promise(done => free.close(done));
base = `http://127.0.0.1:${port}`;

async function launch(ui = false) {
  child = spawn(process.execPath, [join(root, 'packages/tagent-server/dist/index.js')], { cwd: root, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...checkEnvironment(process.env, temp), NODE_ENV: 'test', PORT: String(port),
      TAGENT_HOST: '127.0.0.1', TAGENT_ACCESS_TOKEN: ui ? '' : token, TAGENT_PUBLIC_ORIGIN: '', TAGENT_WEB_ORIGINS: origin,
      TAGENT_API_READ_PER_MINUTE: ui ? '600' : '4', TAGENT_API_WRITE_PER_MINUTE: ui ? '2' : '4', TAGENT_API_EXTERNAL_PER_MINUTE: '2' } });
  child.logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { child.logs = (child.logs + value.toString()).slice(-4000); });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Isolated backend exited: ${child.logs}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Wait for this child only. */ }
    await delay(100);
  }
  throw new Error('Isolated backend readiness timed out');
}
async function stopChild() {
  if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
}
async function request(path, body, overrides = {}) {
  return fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-tagent-request': '1', origin, ...overrides,
  }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
}
async function opened() {
  wsAttempts++;
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { authorization: `Bearer ${token}`, origin }, handshakeTimeout: 3000 });
  sockets.add(ws); ws.on('error', () => {});
  await once(ws, 'open');
  return ws;
}
async function denied() {
  wsAttempts++;
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { authorization: `Bearer ${token}`, origin }, handshakeTimeout: 3000 });
  sockets.add(ws);
  await new Promise((done, reject) => {
    ws.on('error', error => { if (ws.readyState !== WebSocket.CLOSED) reject(error); });
    ws.on('open', () => reject(new Error('Throttled socket unexpectedly opened')));
    ws.on('unexpected-response', (_req, res) => {
      res.resume(); ws.terminate();
      try { assert.equal(res.statusCode, 429); done(); } catch (error) { reject(error); }
    });
  });
}
async function closeSocket(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, 'close'); ws.close(); await closed;
}

try {
  await launch();
  const workspace = await (await request('/api/workspaces', { name: '请求限制隔离验收' })).json();
  const session = await (await request(`/api/workspaces/${workspace.id}/sessions`, { title: '中文限流草稿' })).json();
  assert.ok(session.id);
  const sessionPath = `/api/workspaces/${workspace.id}/sessions/${session.id}`;
  const before = await (await request(sessionPath)).json();
  for (const path of ['/api/discovery/search', '/api/skills/search']) {
    assert.equal((await request(path, {})).status, 400, 'Invalid searches must not contact remote providers');
  }
  for (const path of ['/api/agent/orchestrate', '/api/agent/run']) {
    const rejected = await request(path, { workspaceId: workspace.id, sessionId: session.id, message: '中文 🚀 不应落盘' });
    assert.equal(rejected.status, 429);
    assert.match(rejected.headers.get('retry-after'), /^\d+$/);
    assert.equal(rejected.headers.get('cache-control'), 'no-store');
    assert.match(rejected.headers.get('access-control-expose-headers'), /Retry-After/i);
    assert.match(rejected.headers.get('content-type'), /application\/json/);
    assert.deepEqual(Object.keys(await rejected.clone().json()).sort(), ['accepted', 'code', 'error', 'retryAfterSeconds']);
    assert.equal((await rejected.json()).accepted, false);
  }
  assert.equal((await request('/api/discovery/health')).status, 429);
  assert.deepEqual(await (await request(sessionPath)).json(), before, 'Rejected task must not write optimistic messages or traces');
  // Unknown write paths share the same bounded lane without changing any configuration.
  for (const path of ['/api/unknown-one', '/api/unknown-two']) assert.equal((await request(path, {})).status, 404);
  const writeBlocked = await request('/api/workspaces', { name: '不得创建' });
  assert.equal(writeBlocked.status, 429);
  const workspaces = await (await request('/api/workspaces')).json();
  assert.ok(workspaces.workspaces.some(item => item.id === workspace.id));
  assert.ok(!workspaces.workspaces.some(item => item.name === '不得创建'));
  assert.equal((await request('/api/workspaces')).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await request(`/api/workspaces?q=${i}`, undefined, {
    'x-forwarded-for': `192.0.2.${i}`, forwarded: `for=192.0.2.${i}`, cookie: `forged=${i}`,
  })).status, 429);
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/runs/missing/cancel', {})).status, 404);
  assert.equal((await request('/api/approval/missing', { approved: false })).status, 404);
  assert.equal((await request('/api/auth/logout', {})).status, 200);

  const normal = await opened();
  for (let i = 0; i < 3; i++) {
    const joined = once(normal, 'message'); normal.send(JSON.stringify({ type: 'join', sessionId: session.id }));
    assert.equal(JSON.parse(String((await joined)[0])).sessionId, session.id);
  }
  await closeSocket(normal);
  for (const fragmented of [false, true]) {
    const ws = await opened(); const closed = once(ws, 'close');
    if (fragmented) { ws.send('x'.repeat(9000), { fin: false }); ws.send('x'.repeat(9000)); }
    else ws.send('x'.repeat(20000));
    assert.equal((await closed)[0], 1009, 'Native WebSocket receiver must reject oversized complete and fragmented messages');
  }
  const binary = await opened(); const binaryClosed = once(binary, 'close'); binary.send(Buffer.from('{}'));
  assert.equal((await binaryClosed)[0], 1003);
  const flood = await opened(); const flooded = once(flood, 'close');
  for (let i = 0; i < 121; i++) flood.send('invalid JSON');
  assert.equal((await flooded)[0], 1008, 'Malformed messages still count toward the per-socket limit');
  const capacity = [];
  for (let i = 0; i < 16; i++) capacity.push(await opened());
  await denied();
  await closeSocket(capacity.pop());
  capacity.push(await opened());
  for (const ws of capacity) await closeSocket(ws);
  while (wsAttempts < 30) await closeSocket(await opened());
  await denied();
  console.log(JSON.stringify({ passed: true, realHTTP: true, rejectedTaskWrites: 0, modelCalls: 0, externalCalls: 0,
    independentControlLane: true, nativeWebSocketLimits: ['handshake', 'connections', 'messages', 'payload', 'fragments', 'binary'] }));

  if (keepServing) {
    await stopChild(); await launch(true);
    const stopPath = `/stop-${randomUUID()}`;
    let stopped;
    const stopping = new Promise(done => { stopped = done; });
    control = controlServer((req, res) => {
      if (req.method === 'POST' && req.url === stopPath) { res.end('Stopping'); stopped(); }
      else { res.writeHead(404); res.end(); }
    }).listen(0, '127.0.0.1');
    await once(control, 'listening');
    console.log(JSON.stringify({ fixture: base, workspaceId: workspace.id, sessionId: session.id,
      stopURL: `http://127.0.0.1:${control.address().port}${stopPath}`, limits: { read: 600, write: 2, external: 2 } }));
    await stopping;
  }
} finally {
  for (const ws of sockets) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  if (control) { control.closeAllConnections(); await new Promise(done => control.close(done)); }
  await stopChild();
  const inside = relative(tmpdir(), temp);
  assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside) && temp.startsWith(join(tmpdir(), 'tagent-request-limits-')));
  await rm(temp, { recursive: true, force: true });
}
