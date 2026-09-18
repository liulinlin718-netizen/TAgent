import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, link, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { createSourceCandidate, verifySourceCandidate, sourceFiles, sourceTrees, main } from './release-source.mjs';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  const rel = relative(tmpdir(), root); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(root, { recursive: true, force: true });
} });
async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), 'tagent-source-test-')); roots.push(temp);
  const source = join(temp, 'source'), target = join(temp, 'candidate');
  await mkdir(source);
  for (const path of sourceFiles) { await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), path.endsWith('/.env.example') ? '# API_KEY=example\n' : 'fixture\n'); }
  for (const tree of sourceTrees) await mkdir(join(source, tree), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'tagent', version: '0.1.0' }));
  await writeFile(join(source, 'packages/tagent-core/src/main.ts'), 'export const label = "中文 🙂";\n');
  return { temp, source, target };
}
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

test('copies an explicit Web/Core/Server source snapshot, not Git, credentials, runtime, caches, Desktop or other artifacts', async () => {
  const { source, target } = await fixture();
  for (const path of ['.git/history', '.tagent/data/workspaces.json', '.env', 'output/private.json', 'traces/a.jsonl',
    'packages/tagent-server/.env', 'packages/tagent-server/dist/index.js', 'packages/tagent-web/node_modules/private.json',
    'packages/tagent-web/.next/private.json', 'packages/tagent-core/src/.tagent/private.json',
    'scripts/.env', 'packages/tagent-desktop/private.json', 'lighthouse-report.json']) {
    await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), 'DO_NOT_COPY');
  }
  const result = await createSourceCandidate(source, target);
  assert.equal(result.status, 'candidate-verified'); assert.equal(result.productAccepted, false);
  assert.equal(result.files, sourceFiles.length + 1);
  assert.equal(await readFile(join(target, 'packages/tagent-core/src/main.ts'), 'utf8'), 'export const label = "中文 🙂";\n');
  const manifest = await readFile(join(target, 'SOURCE-MANIFEST.json'), 'utf8');
  assert.ok(!manifest.includes(source)); assert.ok(!manifest.includes('DO_NOT_COPY'));
  assert.equal(await exists(join(target, '.tagent')), false); assert.equal(await exists(join(target, 'packages/tagent-desktop')), false);
  assert.equal(await readFile(join(source, '.env'), 'utf8'), 'DO_NOT_COPY');
  assert.deepEqual(await verifySourceCandidate(target), result);
});

test('refuses an existing destination and a source-tree destination without merging, overwriting or deleting', async () => {
  const { source, target } = await fixture();
  await mkdir(target); await writeFile(join(target, 'keep'), 'original');
  await assert.rejects(createSourceCandidate(source, target), /EEXIST/);
  assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'original');
  await assert.rejects(createSourceCandidate(source, source), /must not replace/);
  await assert.rejects(createSourceCandidate(source, join(source, 'scripts/embedded')), /included source tree/);
});

test('unknown included-tree files and active credentials fail before any output is created', async () => {
  const { source, target } = await fixture();
  const unknown = join(source, 'scripts/dump.log'); await writeFile(unknown, 'private');
  await assert.rejects(createSourceCandidate(source, target), /Unrecognized source file/);
  await rm(unknown); assert.equal(await exists(target), false);
  const env = join(source, 'packages/tagent-server/.env.example');
  await writeFile(env, 'API_KEY=not-a-distributable-value');
  await assert.rejects(createSourceCandidate(source, target), /active credential assignment/);
  assert.equal(await exists(target), false);
});

test('credential tripwire never prints the matching credential', async () => {
  const { source, target } = await fixture();
  for (const secret of ['sk-' + 'a'.repeat(32), 'ghp_' + 'b'.repeat(36), ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')]) {
    await writeFile(join(source, 'docs/credential.md'), secret);
    await assert.rejects(createSourceCandidate(source, target), error => /Possible credential/.test(error.message) && !error.message.includes(secret));
    assert.equal(await exists(target), false);
  }
});

test('rejects symbolic links, directory junctions and hard links inside included source', async () => {
  const { temp, source, target } = await fixture();
  const outside = join(temp, 'private'); await mkdir(outside); await writeFile(join(outside, 'value.ts'), 'private');
  const linked = join(source, 'scripts/linked.ts'); await link(join(outside, 'value.ts'), linked);
  await assert.rejects(createSourceCandidate(source, target), /ordinary bounded source file/); await rm(linked);
  const linkedDir = join(source, 'scripts/linked'); await symlink(outside, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createSourceCandidate(source, target), /Linked source/);
  assert.equal(await exists(target), false);
});

test('rejects oversized source files before copying', async () => {
  const { source, target } = await fixture();
  await writeFile(join(source, 'docs/large.md'), Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(createSourceCandidate(source, target), /bounded source file/);
  assert.equal(await exists(target), false);
});

for (const change of ['modified', 'missing', 'extra-file', 'extra-directory', 'incomplete', 'linked']) test(`candidate verification rejects ${change}`, async () => {
  const { source, target } = await fixture(); await createSourceCandidate(source, target);
  const path = join(target, 'README.md');
  if (change === 'modified') await writeFile(path, 'tampered');
  if (change === 'missing') await rm(path);
  if (change === 'extra-file') await writeFile(join(target, '.env'), 'private');
  if (change === 'extra-directory') await mkdir(join(target, 'node_modules'));
  if (change === 'incomplete') await writeFile(join(target, 'SOURCE-INCOMPLETE'), 'not finished');
  if (change === 'linked') { await rm(path); await link(join(source, 'README.md'), path); }
  await assert.rejects(verifySourceCandidate(target));
});

test('untrusted manifests cannot escape the candidate or leak malformed content in errors', async () => {
  const { source, target } = await fixture(); await createSourceCandidate(source, target);
  const path = join(target, 'SOURCE-MANIFEST.json'), original = JSON.parse(await readFile(path, 'utf8'));
  for (const name of ['../outside', '/outside', 'C:/outside', 'docs/file:stream', 'docs/../README.md', 'docs/NUL.md']) {
    await writeFile(path, JSON.stringify({ ...original, files: [{ ...original.files[0], path: name }] }));
    await assert.rejects(verifySourceCandidate(target), /Unsafe|Invalid/);
  }
  await writeFile(path, '{private-malformed-value');
  await assert.rejects(verifySourceCandidate(target), error => /Invalid JSON/.test(error.message) && !error.message.includes('private-malformed-value'));
});

test('CLI accepts only explicit create/verify modes and never installs, runs, publishes or chooses a destructive default', async () => {
  for (const args of [[], ['create'], ['verify'], ['publish'], ['create', '--output', '.', '--source', '.'], ['create', '--output', '.', '--force']]) {
    await assert.rejects(main(args));
  }
});
