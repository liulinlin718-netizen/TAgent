import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createBackup, verifyBackup, restoreBackup, main } from './data-backup.mjs';

const consent = { offline: true, fileStore: true, includePrivateData: true };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tagent-backup-test-'));
  t.after(async () => {
    const rel = relative(tmpdir(), root);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  });
  const workspace = join(root, 'source'), output = join(root, 'backup'), restored = join(root, 'restored');
  await mkdir(join(workspace, '.tagent/data'), { recursive: true });
  await mkdir(join(workspace, '.tagent/skills/notes'), { recursive: true });
  await mkdir(join(workspace, '.tagent/empty'));
  await writeFile(join(workspace, '.env'), 'API_KEY=excluded-fixture-secret');
  const state = [{ id: 'ws-1', name: '\u4e2d\u6587 \ud83d\ude80 / Office', sessions: [{ messages: [{ content: '\u4fdd\u7559\u539f\u6587' }] }] }];
  await writeFile(join(workspace, '.tagent/data/workspaces.json'), JSON.stringify(state));
  await writeFile(join(workspace, '.tagent/data/run-fixture.json'), '{"state":"interrupted","cost":0.25}');
  await writeFile(join(workspace, '.tagent/skills/notes/attachment.bin'), Buffer.from([0, 255, 128, 1]));
  await writeFile(join(workspace, '.tagent/skills.json'), '[]');
  await writeFile(join(workspace, '.tagent/mcp.json'), JSON.stringify([{ id: 'fixture', name: 'not-executed', type: 'stdio', command: 'never-run',
    args: [], env: { KEY: 'private-fixture-key' }, executionApproved: true, revision: 4 }]));
  return { root, workspace, output, restored, state, create: () => createBackup({ workspace, output, ...consent }) };
}

test('offline backup preserves every byte, empty directory and private file without including external .env', async t => {
  const f = await fixture(t);
  const result = await f.create();
  assert.equal(result.files, 5);
  const verified = await verifyBackup(f.output);
  assert.equal(verified.manifest.storage, 'file');
  assert.equal(verified.manifest.containsPrivateData, true);
  assert.equal(verified.manifest.consistency, 'operator-confirmed-offline');
  assert.ok(verified.manifest.entries.some(entry => entry.path === 'empty' && entry.type === 'directory'));
  for (const entry of verified.manifest.entries.filter(entry => entry.type === 'file')) {
    assert.deepEqual(await readFile(join(f.output, '.tagent', entry.path)), await readFile(join(f.workspace, '.tagent', entry.path)));
  }
  assert.deepEqual((await readdir(f.output)).sort(), ['.tagent', 'manifest.json']);
  assert.doesNotMatch(JSON.stringify(verified.manifest), /private-fixture-key|excluded-fixture-secret/);
});

test('restore verifies first, preserves source, revokes MCP approvals and writes a receipt without starting services', async t => {
  const f = await fixture(t); await f.create();
  const before = (await verifyBackup(f.output)).sha256;
  const result = await restoreBackup({ backup: f.output, workspace: f.restored, ...consent });
  assert.equal(result.revokedMcpApprovals, 1);
  assert.deepEqual(JSON.parse(await readFile(join(f.restored, '.tagent/data/workspaces.json'), 'utf8')), f.state);
  assert.deepEqual(await readFile(join(f.restored, '.tagent/skills/notes/attachment.bin')), Buffer.from([0, 255, 128, 1]));
  const restored = JSON.parse(await readFile(join(f.restored, '.tagent/mcp.json'), 'utf8'))[0];
  assert.equal(restored.executionApproved, false); assert.equal(restored.revision, 5);
  assert.equal(restored.env.KEY, 'private-fixture-key');
  assert.equal((await verifyBackup(f.output)).sha256, before);
  assert.equal(JSON.parse(await readFile(join(f.workspace, '.tagent/mcp.json'), 'utf8'))[0].executionApproved, true);
  const receipt = JSON.parse(await readFile(join(f.restored, 'restore-receipt.json'), 'utf8'));
  assert.equal(receipt.backupManifestSha256, before); assert.equal(receipt.revokedMcpApprovals, 1);
  assert.deepEqual((await readdir(f.restored)).sort(), ['.tagent', 'restore-receipt.json']);
});

test('requires explicit offline/private consent and rejects an active database configuration', async t => {
  const f = await fixture(t);
  for (const flags of [{}, { offline: true }, { offline: true, fileStore: true }, { includePrivateData: true }]) {
    await assert.rejects(createBackup({ workspace: f.workspace, output: f.output, ...flags }), /offline|file-store|private-data/);
  }
  const previous = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = 'postgres://fixture-secret';
    await assert.rejects(f.create(), /does not back up PostgreSQL/);
  } finally { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; }
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});

test('source and backup must not overlap; an existing destination is never merged or replaced', async t => {
  const f = await fixture(t);
  await assert.rejects(createBackup({ workspace: f.workspace, output: join(f.workspace, 'backup'), ...consent }), /overlap/);
  await mkdir(f.output); await writeFile(join(f.output, 'sentinel'), 'keep');
  await assert.rejects(f.create(), { code: 'EEXIST' });
  assert.equal(await readFile(join(f.output, 'sentinel'), 'utf8'), 'keep');
  await assert.rejects(createBackup({ workspace: f.workspace, output: f.root, ...consent }), /overlap/);
});

test('restore refuses existing empty or nonempty directories and never touches the original workspace', async t => {
  const f = await fixture(t); await f.create(); await mkdir(f.restored);
  await assert.rejects(restoreBackup({ backup: f.output, workspace: f.restored, ...consent }), { code: 'EEXIST' });
  await assert.rejects(restoreBackup({ backup: f.output, workspace: f.workspace, ...consent }), { code: 'EEXIST' });
  await assert.rejects(restoreBackup({ backup: f.output, workspace: join(f.output, 'nested'), ...consent }), /overlap/);
  assert.deepEqual(JSON.parse(await readFile(join(f.workspace, '.tagent/data/workspaces.json'), 'utf8')), f.state);
});

for (const corruption of ['modified', 'missing', 'extra', 'incomplete']) test(`rejects ${corruption} backups before creating a restore target`, async t => {
  const f = await fixture(t); await f.create();
  const file = join(f.output, '.tagent/skills.json');
  if (corruption === 'modified') await writeFile(file, '{}');
  if (corruption === 'missing') await rm(file);
  if (corruption === 'extra') await writeFile(join(f.output, '.tagent/unlisted'), 'unexpected');
  if (corruption === 'incomplete') await rm(join(f.output, 'manifest.json'));
  await assert.rejects(restoreBackup({ backup: f.output, workspace: f.restored, ...consent }), /Checksum|files|Incomplete/);
  await assert.rejects(lstat(f.restored), { code: 'ENOENT' });
});

for (const path of ['../outside', '/absolute', 'C:/drive', 'data\\escape', 'data/file:stream', 'data/NUL.txt', 'data/tail.', 'data/./file']) {
  test(`rejects unsafe manifest path ${path}`, async t => {
    const f = await fixture(t); await f.create();
    const manifest = join(f.output, 'manifest.json'), value = JSON.parse(await readFile(manifest, 'utf8'));
    value.entries.push({ type: 'file', path, size: 0, sha256: '0'.repeat(64) });
    await writeFile(manifest, JSON.stringify(value));
    await assert.rejects(restoreBackup({ backup: f.output, workspace: f.restored, ...consent }), /Unsafe/);
    await assert.rejects(lstat(f.restored), { code: 'ENOENT' });
  });
}

test('rejects duplicate/case aliases, missing parents, invalid hashes, future formats and oversized manifests', async t => {
  const f = await fixture(t); await f.create();
  const file = join(f.output, 'manifest.json'), original = JSON.parse(await readFile(file, 'utf8'));
  for (const change of [
    value => value.entries.push({ ...value.entries.find(entry => entry.path === 'skills.json'), path: 'SKILLS.JSON' }),
    value => { value.entries = value.entries.filter(entry => entry.path !== 'data'); },
    value => { value.entries.find(entry => entry.type === 'file').sha256 = 'x'; },
    value => { value.version = 99; },
  ]) {
    const value = structuredClone(original); change(value); await writeFile(file, JSON.stringify(value));
    await assert.rejects(verifyBackup(f.output), /Duplicate|parent|checksum|Unsupported/);
  }
  await writeFile(file, ' '.repeat(16 * 1024 * 1024 + 1));
  await assert.rejects(verifyBackup(f.output), /manifest file/);
});

test('rejects links and junctions in data, backup paths and restore destinations', async t => {
  const f = await fixture(t);
  await symlink(join(f.workspace, '.tagent/skills'), join(f.workspace, '.tagent/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.create(), /Links/);
  await rm(join(f.workspace, '.tagent/linked'));
  await f.create();
  await symlink(join(f.output, '.tagent/skills'), join(f.output, '.tagent/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyBackup(f.output), /Links/);
  await rm(join(f.output, '.tagent/linked'));
  await symlink(f.workspace, f.restored, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(restoreBackup({ backup: f.output, workspace: f.restored, ...consent }), { code: 'EEXIST' });
});

test('rejects hard links without reading linked content', async t => {
  const f = await fixture(t);
  await link(join(f.workspace, '.env'), join(f.workspace, '.tagent/linked-secret'));
  await assert.rejects(f.create(), /Hard-linked/);
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});

test('invalid MCP data keeps restored runtime unpublished and never prints raw credentials', async t => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, '.tagent/mcp.json'), 'private-fixture-key invalid json');
  await f.create();
  await assert.rejects(restoreBackup({ backup: f.output, workspace: f.restored, ...consent }), error => {
    assert.doesNotMatch(error.message, /private-fixture-key/); return /Invalid JSON/.test(error.message);
  });
  await assert.rejects(lstat(join(f.restored, '.tagent')), { code: 'ENOENT' });
  assert.ok((await lstat(join(f.restored, '.tagent-restore-incomplete'))).isDirectory());
});

test('CLI requires explicit paths, rejects unknown/destructive options and has no default current-directory backup', async () => {
  for (const args of [[], ['create'], ['restore', '--workspace', '.'], ['verify', '--backup', '.', '--offline'], ['create', '--force']]) {
    await assert.rejects(main(args), /Choose|Explicit|Invalid|Unknown/);
  }
});
