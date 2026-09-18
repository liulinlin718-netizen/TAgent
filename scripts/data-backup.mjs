import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const FORMAT = 'tagent-file-backup';
const MAX_ENTRIES = 100000;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 ** 3;
const MAX_TOTAL_BYTES = 100 * 1024 ** 3;
const MANIFEST = 'manifest.json';
const PRIVATE_WARNING = 'Contains private conversations, files and MCP credentials. Store offline with restricted access and encryption.';

function check(value, message) { if (!value) throw new Error(message); }
function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Invalid JSON or UTF-8 in backup metadata/configuration; original content is not printed.'); }
}
function within(root, target) {
  const part = relative(root, target);
  return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith('..\\') && !part.startsWith('../'));
}

// Portable names prevent traversal, Windows device/ADS aliases and case collisions on restore.
function validPath(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 2048, 'Invalid backup path.');
  const parts = value.split('/');
  check(parts.length <= 64 && parts.every(part => part && part !== '.' && part !== '..'
    && !/[\x00-\x1f\x7f\\:*?"<>|]/.test(part) && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Unsafe or non-portable backup path.');
  return value;
}

async function directory(value) {
  const path = resolve(value);
  const stat = await lstat(path);
  check(stat.isDirectory() && !stat.isSymbolicLink(), 'Expected a real directory, not a symbolic link or junction.');
  return realpath(path);
}

async function newTarget(value, source) {
  const absolute = resolve(value);
  const parent = await directory(dirname(absolute));
  const target = join(parent, basename(absolute));
  validPath(basename(target));
  check(!within(source, target) && !within(target, source), 'Source and destination must not overlap.');
  // mkdir without recursive atomically refuses existing files, folders and links.
  await mkdir(target, { mode: 0o700 });
  return target;
}

async function inventory(root) {
  const entries = [], folded = new Set();
  async function visit(prefix) {
    const names = (await readdir(join(root, prefix))).sort();
    for (const name of names) {
      const path = validPath(prefix ? `${prefix}/${name}` : name);
      const key = path.normalize('NFC').toLowerCase();
      check(!folded.has(key), 'Case or Unicode-normalization collision in backup paths.');
      folded.add(key);
      check(entries.length < MAX_ENTRIES, 'Too many backup entries.');
      const stat = await lstat(join(root, path));
      check(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), 'Links and special files cannot be backed up or restored.');
      check(stat.isDirectory() || stat.nlink === 1, 'Hard-linked files cannot be backed up or restored.');
      entries.push({ path, type: stat.isDirectory() ? 'directory' : 'file' });
      if (stat.isDirectory()) await visit(path);
    }
  }
  await visit('');
  return entries;
}

async function transfer(source, destination) {
  const before = await lstat(source);
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, 'Expected an ordinary, unlinked file.');
  check(before.size <= MAX_FILE_BYTES, 'File exceeds backup size limit.');
  const input = await open(source, 'r');
  let output;
  try {
    const opened = await input.stat();
    check(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino, 'File changed while opening.');
    if (destination) output = await open(destination, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const hash = createHash('sha256');
    let size = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      check(size <= MAX_FILE_BYTES, 'File exceeds backup size limit.');
      hash.update(buffer.subarray(0, bytesRead));
      if (output) {
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
          check(bytesWritten > 0, 'Backup write made no progress.');
          offset += bytesWritten;
        }
      }
    }
    const after = await input.stat(), current = await lstat(source);
    check(after.size === size && before.size === size && before.mtimeMs === after.mtimeMs
      && before.ctimeMs === after.ctimeMs && !current.isSymbolicLink()
      && current.ino === before.ino && current.dev === before.dev && current.mtimeMs === after.mtimeMs,
    'Source changed during backup; stop every writer before retrying.');
    if (output) await output.sync();
    return { size, sha256: hash.digest('hex') };
  } finally { await input.close(); if (output) await output.close(); }
}

function privateConsent(options) {
  check(options.offline === true, 'Stop every server/writer using this file store, then explicitly pass --offline. This flag does not stop or lock services.');
  check(options.fileStore === true, 'Explicit --file-store confirmation required. Check /api/health before shutdown; this tool does not infer storage from .env or an old workspaces.json.');
  check(options.includePrivateData === true, `Explicit --include-private-data consent required. ${PRIVATE_WARNING}`);
  check(!process.env.DATABASE_URL, 'DATABASE_URL is set. This tool does not back up PostgreSQL; use a database-native backup and recovery procedure.');
}

async function requireWorkspace(root) {
  const data = await directory(join(root, 'data'));
  check(within(root, data), 'Invalid data directory.');
  const stat = await lstat(join(data, 'workspaces.json'));
  check(stat.isFile() && !stat.isSymbolicLink(), 'Missing file-store workspaces.json. Do not use this tool for PostgreSQL.');
}

function validateManifest(value) {
  check(value?.format === FORMAT && value.version === 1 && value.storage === 'file'
    && value.consistency === 'operator-confirmed-offline' && value.containsPrivateData === true
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    && Array.isArray(value.entries) && value.entries.length <= MAX_ENTRIES, 'Unsupported or incomplete backup manifest.');
  const paths = new Map();
  let total = 0;
  for (const entry of value.entries) {
    check(entry && ['directory', 'file'].includes(entry.type), 'Invalid backup entry.');
    const path = validPath(entry.path), key = path.normalize('NFC').toLowerCase();
    check(!paths.has(key), 'Duplicate or aliased backup path.');
    if (entry.type === 'file') {
      check(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAX_FILE_BYTES
        && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256), 'Invalid file checksum or size.');
      total += entry.size;
      check(total <= MAX_TOTAL_BYTES, 'Backup exceeds total size limit.');
    }
    paths.set(key, entry);
  }
  for (const entry of paths.values()) {
    const parts = entry.path.split('/');
    if (parts.length > 1) {
      const parent = parts.slice(0, -1).join('/');
      check(paths.get(parent.normalize('NFC').toLowerCase())?.type === 'directory'
        && paths.get(parent.normalize('NFC').toLowerCase()).path === parent, 'Missing or aliased parent directory.');
    }
  }
  check(paths.get('data/workspaces.json')?.type === 'file' && paths.get('data/workspaces.json').path === 'data/workspaces.json', 'Backup has no portable file-store workspace data.');
  return value;
}

async function readManifest(backup) {
  const file = join(backup, MANIFEST);
  const stat = await lstat(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= MAX_MANIFEST_BYTES, 'Invalid backup manifest file.');
  const bytes = await readFile(file);
  check(bytes.length <= MAX_MANIFEST_BYTES, 'Backup manifest too large.');
  const manifest = validateManifest(parseJson(bytes));
  return { manifest, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function compareFiles(root, entries) {
  const actual = await inventory(root);
  const expected = entries.map(({ path, type }) => ({ path, type })).sort((a, b) => a.path.localeCompare(b.path));
  check(JSON.stringify(actual.sort((a, b) => a.path.localeCompare(b.path))) === JSON.stringify(expected), 'Missing or unexpected files in backup.');
  for (const entry of entries) if (entry.type === 'file') {
    const current = await transfer(join(root, entry.path));
    check(current.size === entry.size && current.sha256 === entry.sha256, 'Checksum mismatch; backup is damaged or source changed.');
  }
}

export async function createBackup(options) {
  privateConsent(options);
  const workspace = await directory(options.workspace);
  const source = await directory(join(workspace, '.tagent'));
  await requireWorkspace(source);
  const entries = await inventory(source);
  const target = await newTarget(options.output, workspace);
  const data = join(target, '.tagent');
  await mkdir(data, { mode: 0o700 });
  let total = 0;
  for (const entry of entries) {
    const destination = join(data, entry.path);
    if (entry.type === 'directory') await mkdir(destination, { mode: 0o700 });
    else {
      Object.assign(entry, await transfer(join(source, entry.path), destination));
      total += entry.size;
      check(total <= MAX_TOTAL_BYTES, 'Backup exceeds total size limit.');
    }
  }
  await compareFiles(source, entries);
  await compareFiles(data, entries);
  const manifest = validateManifest({ format: FORMAT, version: 1, storage: 'file', consistency: 'operator-confirmed-offline',
    createdAt: new Date().toISOString(), containsPrivateData: true, entries });
  const bytes = JSON.stringify(manifest, null, 2);
  check(Buffer.byteLength(bytes) <= MAX_MANIFEST_BYTES, 'Backup manifest too large.');
  // Only a completely copied and rechecked directory receives the completion manifest.
  await writeFile(join(target, MANIFEST), bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
  return { backup: target, files: entries.filter(entry => entry.type === 'file').length, bytes: total, warning: PRIVATE_WARNING };
}

export async function verifyBackup(value) {
  const backup = await directory(value);
  check(JSON.stringify((await readdir(backup)).sort()) === JSON.stringify(['.tagent', MANIFEST]), 'Incomplete backup or unexpected top-level files.');
  const { manifest, sha256 } = await readManifest(backup);
  const source = await directory(join(backup, '.tagent'));
  await compareFiles(source, manifest.entries);
  // The manifest itself must not change while its entries are being checked.
  check((await readManifest(backup)).sha256 === sha256, 'Backup manifest changed during verification.');
  return { backup, manifest, sha256 };
}

async function revokeExecution(data) {
  const file = join(data, 'mcp.json');
  let bytes;
  try {
    check((await lstat(file)).size <= MAX_MANIFEST_BYTES, 'MCP configuration too large to restore safely.');
    bytes = await readFile(file);
  } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  const configs = parseJson(bytes);
  check(Array.isArray(configs) && configs.every(item => item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.id === 'string' && ['stdio', 'sse', 'http'].includes(item.type)), 'Invalid MCP data; restore cannot safely revoke old execution permissions.');
  let revoked = 0;
  for (const config of configs) if (config.executionApproved === true) {
    check(config.revision !== Number.MAX_SAFE_INTEGER, 'MCP revision cannot be incremented safely.');
    config.executionApproved = false;
    config.revision = Number.isSafeInteger(config.revision) && config.revision >= 0 ? config.revision + 1 : 1;
    revoked++;
  }
  if (revoked) await writeFile(file, JSON.stringify(configs, null, 2), { encoding: 'utf8', mode: 0o600, flush: true });
  return revoked;
}

export async function restoreBackup(options) {
  privateConsent(options);
  const { backup, manifest, sha256 } = await verifyBackup(options.backup);
  const target = await newTarget(options.workspace, backup);
  const data = join(target, '.tagent');
  // Build under a non-runtime name. An interrupted restore cannot become a usable store.
  const staging = join(target, '.tagent-restore-incomplete');
  await mkdir(staging, { mode: 0o700 });
  const entries = [...manifest.entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  for (const entry of entries) {
    const destination = join(staging, entry.path);
    if (entry.type === 'directory') await mkdir(destination, { mode: 0o700 });
    else {
      const copied = await transfer(join(backup, '.tagent', entry.path), destination);
      check(copied.size === entry.size && copied.sha256 === entry.sha256, 'Backup changed during restore.');
    }
  }
  await compareFiles(staging, manifest.entries);
  check((await readManifest(backup)).sha256 === sha256, 'Backup manifest changed during restore.');
  const revokedMcpApprovals = await revokeExecution(staging);
  const receipt = { format: 'tagent-file-restore', version: 1, restoredAt: new Date().toISOString(),
    backupManifestSha256: sha256, revokedMcpApprovals, containsPrivateData: true };
  await writeFile(join(target, 'restore-receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600, flush: true });
  // Publish the runtime directory last, after validation and permission revocation.
  // No server or external commands are started here. Operator reviews configuration before boot.
  await rename(staging, data);
  return { workspace: target, files: entries.filter(entry => entry.type === 'file').length, revokedMcpApprovals, warning: PRIVATE_WARNING };
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    workspace: { type: 'string' }, output: { type: 'string' }, backup: { type: 'string' },
    offline: { type: 'boolean' }, 'file-store': { type: 'boolean' }, 'include-private-data': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('TAgent file-store backup (offline, no overwrites, no network)\n'
      + 'create --workspace <existing root> --output <new backup directory> --offline --file-store --include-private-data\n'
      + 'verify --backup <backup directory>\n'
      + 'restore --backup <backup directory> --workspace <NEW root> --offline --file-store --include-private-data\n'
      + 'Stop every writer yourself. PostgreSQL, external files and deployment .env are NOT included.\n' + PRIVATE_WARNING);
    return;
  }
  check(positionals.length === 1, 'Choose create, verify or restore; see --help.');
  const command = positionals[0];
  const allowed = command === 'create' ? ['workspace', 'output', 'offline', 'file-store', 'include-private-data']
    : command === 'restore' ? ['workspace', 'backup', 'offline', 'file-store', 'include-private-data'] : command === 'verify' ? ['backup'] : [];
  check(allowed.length && Object.keys(values).every(key => allowed.includes(key)), 'Invalid command or options; see --help.');
  check((command === 'create' && values.workspace && values.output) || (command === 'restore' && values.workspace && values.backup)
    || (command === 'verify' && values.backup), 'Explicit source and destination paths are required; see --help.');
  const options = { ...values, fileStore: values['file-store'], includePrivateData: values['include-private-data'] };
  const result = command === 'create' ? await createBackup(options) : command === 'restore' ? await restoreBackup(options)
    : await verifyBackup(values.backup).then(({ backup, sha256, manifest }) => ({ backup, manifestSha256: sha256, files: manifest.entries.filter(entry => entry.type === 'file').length }));
  console.log(JSON.stringify({ ok: true, ...result }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Backup operation failed: ${error.message}. Incomplete destinations are retained for inspection; do not start a server against them.`); process.exitCode = 1; });
}
