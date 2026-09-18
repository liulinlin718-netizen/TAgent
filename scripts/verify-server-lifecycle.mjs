import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createBackup, verifyBackup, restoreBackup } from './data-backup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tagent-server-acceptance-'));
const dataRoot = join(temporaryRoot, 'workspace');
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(done => reservation.close(done));
const base = `http://127.0.0.1:${port}`;
let child;
let logs = '';

async function start(cwd, workspace = dataRoot) {
  logs = '';
  child = spawn(process.execPath, [join(root, 'packages/tagent-server/dist/index.js')], {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), TAGENT_WORKSPACE_ROOT: workspace, TAGENT_ENV_FILE: '',
      DATABASE_URL: '', REDIS_URL: '', DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
      TAGENT_LLM_PROVIDER: '', TAGENT_LLM_MODEL: '', NODE_ENV: 'test', TAGENT_HOST: '127.0.0.1',
      // Exercise all invalid-input/import cases without replacing them with the separate rate-admission check.
      TAGENT_API_EXTERNAL_PER_MINUTE: '100',
      TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '', TAGENT_WEB_ORIGINS: 'http://localhost:3000', TAGENT_SEARCH_PROVIDER: '' },
  });
  child.stdout.on('data', chunk => { logs = (logs + chunk.toString()).slice(-6000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-6000); });
  child.on('error', error => { logs += error.message; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try {
      const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
      if (health.ok) return;
    } catch { /* Startup readiness only, no model requests. */ }
    await delay(100);
  }
  throw new Error(`Server did not start: ${logs}`);
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  return response;
}

async function run(path, body) {
  const response = await request(path, body);
  assert.equal(response.status, 200);
  const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const lines = block.split(/\r?\n/);
    return { type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(),
      data: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')) };
  });
  const complete = events.filter(event => event.type === 'complete');
  assert.equal(complete.length, 1, 'Exactly one final result is required');
  assert.ok(complete[0].data.output.length > 0);
  assert.ok(events.some(event => event.type === 'workflow_event' && event.data.type === 'complete'));
  return { events, result: complete[0].data };
}

try {
  await mkdir(join(dataRoot, '.tagent-restore-incomplete'), { recursive: true });
  await assert.rejects(start(root), /数据恢复尚未完成/);
  await assert.rejects(lstat(join(dataRoot, '.tagent')), { code: 'ENOENT' });
  await rmdir(join(dataRoot, '.tagent-restore-incomplete'));
  await start(root);
  const health = await (await request('/api/health')).json();
  assert.equal(health.persistence, 'file');
  assert.equal(health.model.status, 'unconfigured');
  assert.equal(health.model.connectivity, 'unchecked');
  const searchPath = '/api/research-search/settings';
  const initialSearch = await (await request(searchPath)).json();
  assert.equal(initialSearch.provider, 'auto');
  assert.equal(initialSearch.locked, false);
  const searchChoice = { provider: 'parallel', confirmed: true, expectedRevision: initialSearch.revision, confirmationVersion: initialSearch.confirmationVersion };
  assert.equal((await request('/api/research-search/test', { provider: 'parallel', confirmed: false, confirmationVersion: initialSearch.confirmationVersion })).status, 400);
  assert.deepEqual(await (await request(searchPath)).json(), initialSearch);
  const savedSearch = await (await request(searchPath, searchChoice, 'PUT')).json();
  assert.equal(savedSearch.provider, 'parallel');
  assert.equal(savedSearch.revision, 1);
  assert.equal((await request(searchPath, searchChoice, 'PUT')).status, 409);
  assert.equal((await (await request('/api/health')).json()).search.provider, 'parallel');
  const beforeSkills = await (await request('/api/skills')).json();
  const beforeMcp = await (await request('/api/mcp')).json();
  for (const endpoint of ['/api/skills/import', '/api/skills/import/preview', '/api/mcp/import', '/api/mcp/import/preview']) {
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://[::ffff:127.0.0.1]/private', 'http://2130706433/private']) {
      const denied = await request(endpoint, { source: url });
      assert.equal(denied.status, 400);
      const data = await denied.json();
      assert.match(data.error, /拦截/);
      assert.equal(data.candidate, undefined, 'A blocked source must not become an import draft');
    }
  }
  for (const endpoint of ['/api/discovery/search', '/api/skills/search', '/api/mcp/search']) {
    for (const query of [null, 123, [], {}, '', 'x'.repeat(501)]) {
      assert.equal((await request(endpoint, { query })).status, 400, `${endpoint} must reject invalid query without searching`);
    }
    const direct = await (await request(endpoint, { query: 'https://github.com/demo/skills' })).json();
    assert.equal(direct.providers['github-repo'], 'disabled');
    assert.equal(direct.candidates.some(item => item.providerId === 'url'), true);
    assert.equal(direct.candidates.some(item => item.draft || item.command || item.body), false);
  }
  const skillPreview = await (await request('/api/skills/import/preview', { markdown: '# Office Skill\n\nSummarize verified notes.' })).json();
  const mcpPreview = await (await request('/api/mcp/import/preview', { text: JSON.stringify({ name: 'Lifecycle preview', command: 'fixture-not-installed', args: [] }) })).json();
  for (const preview of [skillPreview, mcpPreview]) {
    assert.equal(preview.requiresConfirmation, true);
    assert.equal(preview.willWrite, false);
    assert.equal(preview.willExecute, false);
  }
  assert.deepEqual(await (await request('/api/skills')).json(), beforeSkills);
  assert.deepEqual(await (await request('/api/mcp')).json(), beforeMcp);
  const workspaces = await (await request('/api/workspaces')).json();
  const workspaceId = workspaces.workspaces[0].id;
  assert.equal((await request('/api/workspaces', { name: 42 })).status, 400);
  assert.equal((await request(`/api/workspaces/${workspaceId}/sessions`, { title: 42 })).status, 400);
  const prompt = '近 30 天 AI Agent 最新进展 🚀 / Docker?';
  const { events, result } = await run('/api/agent/orchestrate', { message: prompt, workspaceId, mode: 'research_smoke' });
  assert.equal(result.success, true);
  assert.ok(events.some(event => event.type === 'workflow_event' && event.data.toolName === 'web_research'));
  const sessionId = result.sessionId;
  const path = `/api/workspaces/${workspaceId}/sessions/${sessionId}`;
  const saved = await (await request(path)).json();
  assert.equal(saved.messages[0].content, prompt);
  assert.equal(saved.messages[1].content, result.output);
  const fork = await (await request(path + '/fork', { forkType: 'fork_full' })).json();
  assert.equal(fork.parentSessionId, sessionId);
  assert.deepEqual(fork.messages, saved.messages.map(({ run: _ownedRun, ...message }) => message));
  assert.ok(fork.messages.every(message => !message.run), 'A fork copies history, not active run ownership');
  // Same production entry, different working directory, same persistent state.
  await stop();
  const output = join(temporaryRoot, 'backup'), restored = join(temporaryRoot, 'restored');
  const consent = { offline: true, fileStore: true, includePrivateData: true };
  await createBackup({ workspace: dataRoot, output, ...consent });
  const backupHash = (await verifyBackup(output)).sha256;
  await restoreBackup({ backup: output, workspace: restored, ...consent });
  await start(root, restored);
  assert.deepEqual(await (await request(path)).json(), saved, 'Restored server must return exact messages, UTF-8, costs and trace');
  assert.deepEqual(await (await request(`/api/workspaces/${workspaceId}/sessions/${fork.id}`)).json(), fork);
  assert.deepEqual(await (await request(searchPath)).json(), savedSearch);
  assert.deepEqual(await (await request('/api/skills')).json(), beforeSkills);
  assert.deepEqual(await (await request('/api/mcp')).json(), beforeMcp);
  assert.equal((await verifyBackup(output)).sha256, backupHash, 'Starting a restore must not modify its backup');
  await stop();
  console.log('PASS: offline backup checksums, independent restored server, UTF-8/trace/Fork/settings preserved and incomplete-restore startup rejected');
  await start(join(root, 'packages/tagent-server'));
  assert.deepEqual(await (await request(path)).json(), saved);
  assert.deepEqual(await (await request(searchPath)).json(), savedSearch);
  for (const endpoint of ['/api/agent/run', '/api/agent/orchestrate']) {
    const failed = await run(endpoint, { message: '你好', workspaceId, sessionId });
    assert.equal(failed.result.success, false);
    assert.match(failed.result.output, /API Key/);
    assert.equal((await request(endpoint, { message: 'hello', workspaceId, sessionId: 'missing' })).status, 404);
  }
  assert.equal((await request('/api/agent/orchestrate', { message: { invalid: true } })).status, 400);
  await request(`/api/workspaces/${workspaceId}/sessions/${fork.id}`, undefined, 'DELETE');
  await stop();
  await start(root);
  assert.equal((await request(`/api/workspaces/${workspaceId}/sessions/${fork.id}`)).status, 404);
  console.log('PASS: production server, UTF-8 restart, Fork, deletion, smoke workflow, missing-provider final results, import network boundaries and search settings consent/restart');
} finally {
  await stop();
  const rel = relative(tmpdir(), temporaryRoot);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(temporaryRoot, { recursive: true, force: true });
}
