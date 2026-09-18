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
const temp = await mkdtemp(join(tmpdir(), 'tagent-skill-http-'));
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
  const before = await request('/api/skills');
  const filesBefore = await readdir(join(temp, '.tagent'));
  const preview = await request('/api/skills/import/preview', { markdown: '---\nname: office-fixture\ndescription: 中文验收\n---\n保留完整说明。\n\n## 交付\n来源与日期。' });
  assert.equal(preview.willWrite, false); assert.equal(preview.willExecute, false); assert.equal(preview.requiresConfirmation, true);
  assert.deepEqual(await request('/api/skills'), before);
  assert.deepEqual(await readdir(join(temp, '.tagent')), filesBefore);
  const saved = await request('/api/skills', preview.candidate);
  assert.match(saved.body, /## 交付/);
  await stop(); await start();
  assert.deepEqual((await request('/api/skills')).skills.find(skill => skill.id === saved.id), saved);
  await request(`/api/skills/${saved.id}`, undefined, 'DELETE');
  console.log(JSON.stringify({ status: 'passed', base, previewNoWrite: true, utf8Restart: true, userDataTouched: false, modelCalls: 0 }));
  if (process.argv.includes('--serve')) {
    console.log(`SKILL_FIXTURE_READY ${base} ${temp} (write stop to stdin to close; use an interactive terminal)`);
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
