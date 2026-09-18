import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'tagent-mcp-http-'));
const reservation = createServer().listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(done => reservation.close(done));
const base = `http://127.0.0.1:${port}`;
let child, logs = '';
async function start() {
  child = spawn(process.execPath, [join(root, 'packages/tagent-server/dist/index.js')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), TAGENT_WORKSPACE_ROOT: temp, TAGENT_ENV_FILE: '',
      DATABASE_URL: '', REDIS_URL: '', DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
      TAGENT_LLM_PROVIDER: '', TAGENT_LLM_MODEL: '', TAGENT_HOST: '127.0.0.1', NODE_ENV: 'test',
      TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '', TAGENT_WEB_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3000' },
  });
  child.stdout.on('data', value => { logs = (logs + value).slice(-5000); });
  child.stderr.on('data', value => { logs = (logs + value).slice(-5000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Backend exited: ${logs}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await delay(100);
  }
  throw new Error('Backend startup failed');
}
async function stop() {
  if (child && child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
}
async function request(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal(response.ok, true, await response.clone().text());
  return response.json();
}
try {
  await start();
  const before = await request('/api/mcp');
  const saved = await request('/api/mcp', { name: 'MCP 中文验收', type: 'stdio', command: 'fixture-not-installed',
    args: ['folder with spaces', '--token', 'fixture-private-token'], env: { OFFICE_KEY: 'fixture-private-env' }, executionApproved: true });
  assert.equal(saved.executionApproved, false);
  assert.ok(!JSON.stringify(saved).includes('fixture-private'));
  const test = await request(`/api/mcp/${saved.id}/test`, {});
  assert.equal(test.status, 'preview_only'); assert.equal(test.willExecute, false); assert.equal(test.willWrite, false);
  assert.ok(!JSON.stringify(test).includes('fixture-private'));
  const approved = await request(`/api/mcp/${saved.id}/approval`, { revision: saved.revision, confirmed: true });
  assert.equal(approved.executionApproved, true);
  const edited = await request(`/api/mcp/${saved.id}`, { ...approved, name: '已编辑 MCP 🙂' }, 'PUT');
  assert.equal(edited.executionApproved, false);
  await stop(); await start();
  assert.deepEqual((await request('/api/mcp')).servers.find(server => server.id === saved.id), edited);
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(join(temp, '.tagent', 'mcp.json'), 'utf8')).find(server => server.id === saved.id);
  assert.equal(raw.env.OFFICE_KEY, 'fixture-private-env');
  assert.deepEqual(raw.args, ['folder with spaces', '--token', 'fixture-private-token']);
  await request(`/api/mcp/${saved.id}`, undefined, 'DELETE');
  assert.deepEqual(await request('/api/mcp'), before);
  console.log(JSON.stringify({ status: 'passed', base, utf8Restart: true, secretsRedacted: true, approvalSeparate: true, stdioTestsExecuted: false, userDataTouched: false, modelCalls: 0 }));
  if (process.argv.includes('--serve')) {
    console.log(`MCP_FIXTURE_READY ${base} ${temp} (write stop to stdin to close; use an interactive terminal)`);
    process.stdin.resume();
    await Promise.race([once(process.stdin, 'data'), once(process.stdin, 'end'), once(process, 'SIGINT'), once(process, 'SIGTERM')]);
    process.stdin.pause();
  }
} finally {
  await stop();
  const rel = relative(tmpdir(), temp);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(temp, { recursive: true, force: true });
}
