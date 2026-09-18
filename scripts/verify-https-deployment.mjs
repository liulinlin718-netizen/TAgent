import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer, request as httpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { createServer as reservePort } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { checkEnvironment } from './check.mjs';

const { values } = parseArgs({ options: { openssl: { type: 'string' }, serve: { type: 'boolean' } } });
assert.ok(values.openssl && isAbsolute(values.openssl), 'Pass --openssl <existing OpenSSL 3 executable>; no automatic installation.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/tagent-server/package.json'));
const WebSocket = require('ws');
const { load: parseHTML } = require('cheerio');
const temp = await mkdtemp(join(tmpdir(), 'tagent-https-'));
const token = randomBytes(32).toString('base64url');
const controlPath = `/stop-${randomUUID()}`;
const children = [], connections = new Set(), sockets = new Set();
let proxy, finishServing;
const serving = new Promise(done => { finishServing = done; });
async function freePort() {
  const server = reservePort().listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}
const backendPort = await freePort(), frontendPort = await freePort(), proxyPort = await freePort();
const origin = `https://127.0.0.1:${proxyPort}`;
const env = checkEnvironment(process.env, temp);
function launch(args, cwd, extra) {
  const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ...extra } });
  child.logs = ''; children.push(child);
  child.stdout.on('data', chunk => { child.logs = (child.logs + chunk).slice(-5000); });
  child.stderr.on('data', chunk => { child.logs = (child.logs + chunk).slice(-5000); });
  return child;
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Test child exited: ${child.logs}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* This child is still starting. */ }
    await delay(100);
  }
  throw new Error(`Readiness timed out: ${child.logs}`);
}
let cert;
async function request(path, body, cookie, headers = {}) {
  return new Promise((resolve, reject) => {
    let received = 0, status;
    const req = httpsRequest(origin + path, { method: body === undefined ? 'GET' : 'POST', ca: cert, rejectUnauthorized: true,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Tagent-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers } }, response => {
      status = response.statusCode;
      let text = ''; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; received += Buffer.byteLength(chunk); }); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject); req.setTimeout(20000, () => req.destroy(new Error(`Fixture request timeout: ${path}, status=${status}, bytes=${received}`)));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
function connect(cookie, requestOrigin = origin) {
  const ws = new WebSocket(origin.replace('https:', 'wss:') + '/ws', { ca: cert, rejectUnauthorized: true,
    headers: { Origin: requestOrigin, ...(cookie ? { Cookie: cookie } : {}) }, handshakeTimeout: 5000 });
  sockets.add(ws); return ws;
}
async function deniedSocket(cookie, requestOrigin, status) {
  await new Promise((resolve, reject) => {
    const ws = connect(cookie, requestOrigin); let denied = false;
    ws.on('error', error => { if (!denied) reject(error); });
    ws.on('open', () => { ws.terminate(); reject(new Error('Unauthorized WSS opened')); });
    ws.on('unexpected-response', (_request, response) => {
      denied = true; response.resume(); ws.terminate();
      try { assert.equal(response.statusCode, status); resolve(); } catch (error) { reject(error); }
    });
  });
}
try {
  const keyPath = join(temp, 'fixture-key.pem'), certPath = join(temp, 'fixture-cert.pem');
  const config = join(temp, 'openssl.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\n[dn]\n', { mode: 0o600 });
  // Ephemeral local certificate only. https://docs.openssl.org/3.5/man1/openssl-req/
  const generated = spawnSync(values.openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', keyPath,
    '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-config', config],
  { cwd: temp, windowsHide: true, shell: false, encoding: 'utf8', timeout: 30000 });
  assert.equal(generated.status, 0, 'OpenSSL could not create the temporary fixture certificate; no trust store is changed.');
  cert = await readFile(certPath); const key = await readFile(keyPath);
  const backend = launch([join(root, 'packages/tagent-server/dist/index.js')], temp, { NODE_ENV: 'production', PORT: String(backendPort),
    DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
    TAGENT_HOST: '127.0.0.1', TAGENT_ACCESS_TOKEN: token, TAGENT_PUBLIC_ORIGIN: origin, TAGENT_WEB_ORIGINS: origin });
  await ready(`http://127.0.0.1:${backendPort}/api/health`, backend);
  const frontend = launch([join(root, 'packages/tagent-web/node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(frontendPort)],
    join(root, 'packages/tagent-web'), { NODE_ENV: 'production' });
  await ready(`http://127.0.0.1:${frontendPort}/`, frontend);
  // Test TLS terminator only, not a shipped proxy or an Nginx configuration validator.
  proxy = createServer({ key, cert, minVersion: 'TLSv1.2' }, (req, res) => {
    if (values.serve && req.method === 'POST' && req.url === controlPath) { res.end('Stopping'); finishServing(); return; }
    const port = req.url.startsWith('/api/') ? backendPort : frontendPort;
    const upstream = httpRequest({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => upstream.destroy()); req.pipe(upstream);
  });
  proxy.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  proxy.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: backendPort, path: '/ws', headers: req.headers });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      connections.add(remote); remote.on('close', () => connections.delete(remote));
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(response.headers).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`);
      if (head.length) remote.write(head); if (remoteHead.length) socket.write(remoteHead);
      socket.pipe(remote).pipe(socket); socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
      socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
    });
    upstream.on('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  proxy.listen(proxyPort, '127.0.0.1'); await once(proxy, 'listening');
  await assert.rejects(new Promise((resolve, reject) => {
    const req = httpsRequest(origin + '/', { rejectUnauthorized: true }, response => { response.resume(); resolve(); });
    req.on('error', reject); req.end();
  }), error => ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code));
  const page = await request('/'); assert.equal(page.status, 200);
  const $ = parseHTML(page.text);
  assert.equal($('link[rel="preconnect"][href="http://localhost:3001"], link[rel="preconnect"][href="http://127.0.0.1:3001"]').length, 0,
    'Production HTML must not preconnect to the developer backend');
  assert.deepEqual((await request('/api/health')).json(), { status: 'ok', access: 'protected' });
  assert.equal((await request('/api/workspaces')).status, 401);
  assert.equal((await request('/api/auth/login', { token: 'wrong' })).status, 401);
  const login = await request('/api/auth/login', { token }); assert.equal(login.status, 200);
  const header = login.headers['set-cookie'][0], cookie = header.split(';')[0];
  assert.ok(cookie.startsWith('__Host-tagent_session=')); assert.match(header, /HttpOnly/); assert.match(header, /Secure/);
  assert.match(header, /SameSite=Strict/); assert.match(header, /Path=\//); assert.doesNotMatch(header, /Domain=/i);
  assert.ok(!header.includes(token) && !login.text.includes(token));
  assert.equal((await request('/api/workspaces', undefined, cookie, { Origin: 'https://other.example' })).status, 403);
  const workspace = (await request('/api/workspaces', { name: 'HTTPS 隔离工作区' }, cookie)).json();
  const session = (await request(`/api/workspaces/${workspace.id}/sessions`, { title: 'HTTPS 中文 🙂' }, cookie)).json();
  assert.ok(workspace.id && session.id);
  assert.equal((await request('/api/health', undefined, cookie)).json().model.status, 'unconfigured');
  const baselineSession = (await request(`/api/workspaces/${workspace.id}/sessions`, { title: 'Direct control' }, cookie)).json();
  const baseline = await fetch(`http://127.0.0.1:${backendPort}/api/agent/orchestrate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    body: JSON.stringify({ workspaceId: workspace.id, sessionId: baselineSession.id, message: 'Direct control' }),
    signal: AbortSignal.timeout(10000),
  });
  assert.match(await baseline.text(), /event: complete/);
  console.log('Direct HTTP control completed');
  await deniedSocket(undefined, origin, 401); await deniedSocket(cookie, 'https://other.example', 403);
  const ws = connect(cookie); await once(ws, 'open', { signal: AbortSignal.timeout(5000) });
  const joined = once(ws, 'message', { signal: AbortSignal.timeout(5000) }); ws.send(JSON.stringify({ type: 'join', sessionId: session.id }));
  assert.equal(JSON.parse(String((await joined)[0])).type, 'joined');
  const run = await request('/api/agent/orchestrate', { workspaceId: workspace.id, sessionId: session.id, message: 'HTTPS 隔离验收，保留中文 🙂，不联网。' }, cookie);
  assert.equal(run.status, 200); assert.match(run.headers['content-type'], /text\/event-stream/);
  const events = run.text.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const lines = block.split(/\r?\n/); return { type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(),
      data: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')) };
  });
  const complete = events.filter(event => event.type === 'complete'); assert.equal(complete.length, 1);
  assert.equal(complete[0].data.persisted, true); assert.ok(complete[0].data.output.length > 0);
  assert.equal(complete[0].data.success, false, 'Missing provider must not be reported as a successful task');
  const history = (await request(`/api/workspaces/${workspace.id}/sessions/${session.id}`, undefined, cookie)).json();
  assert.equal(history.messages.at(-1).content, complete[0].data.output);
  assert.equal((await request('/api/auth/logout', {}, cookie)).status, 200);
  assert.equal((await request('/api/workspaces', undefined, cookie)).status, 401);
  const closed = once(ws, 'close', { signal: AbortSignal.timeout(5000) }); ws.send(JSON.stringify({ type: 'join', sessionId: session.id })); assert.equal((await closed)[0], 1008);
  console.log(JSON.stringify({ status: 'passed', productionMode: true, localTLS: true, defaultClientRejectsFixtureCertificate: true,
    verifiedCAClient: true, secureHostCookie: true, wss: true, sse: true, logoutRevocation: true, modelCalls: 0, userWrites: 0 }));
  if (values.serve) {
    const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    const browserConfig = join(temp, 'playwright-config.json');
    await writeFile(browserConfig, JSON.stringify({ browser: { browserName: 'chromium', launchOptions: { args: [`--ignore-certificate-errors-spki-list=${spki}`] } } }));
    console.log(JSON.stringify({ origin, token, workspaceId: workspace.id, sessionId: session.id, browserConfig,
      certPath, stopUrl: origin + controlPath, note: 'All credentials and TLS trust are isolated fixtures, never deployment settings.' }));
    await serving;
  }
} catch (error) {
  for (const child of children) console.error(child.logs);
  throw error;
} finally {
  for (const ws of sockets) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  for (const socket of connections) socket.destroy();
  if (proxy) await new Promise(done => proxy.close(done));
  for (const child of children.reverse()) if (child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
  const rel = relative(tmpdir(), temp); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(temp, { recursive: true, force: true });
}
