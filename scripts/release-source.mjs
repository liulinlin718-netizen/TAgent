import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const sourceFiles = [
  'README.md', 'LICENSE', 'implementation_plan.md', 'innovation_review_checklist.md', '.gitignore',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'turbo.json', 'eslint.config.mjs', 'vitest.config.mjs', 'docker-compose.yml',
  ...['ai', 'core', 'server', 'web'].flatMap(name => [`packages/tagent-${name}/package.json`, `packages/tagent-${name}/tsconfig.json`]),
  'packages/tagent-server/.env.example', 'packages/tagent-web/next.config.ts',
  'packages/tagent-web/next-env.d.ts', 'packages/tagent-web/eslint.config.mjs',
];
export const sourceTrees = ['docs', 'scripts', '.github/workflows',
  ...['ai', 'core', 'server', 'web'].map(name => `packages/tagent-${name}/src`), 'packages/tagent-web/public'];
const FORMAT = 'tagent-source-candidate-v1', MANIFEST = 'SOURCE-MANIFEST.json', INCOMPLETE = 'SOURCE-INCOMPLETE';
const MAX_FILE = 8 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024, MAX_FILES = 2000;
const extensions = new Set(['.md', '.txt', '.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.json', '.css', '.yaml', '.yml', '.py', '.ps1', '.svg', '.ico', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ttf']);
const omittedNames = /^(?:\.git|\.tagent|\.env(?:\..*)?|node_modules|dist|out|output|traces|coverage|\.next|\.turbo|\.tmp|\.cache|\.playwright-cli|\.pnpm-store)$/i;
const check = (value, message) => { if (!value) throw new Error(message); };
const within = (root, path) => { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\')); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Invalid JSON or UTF-8 in source metadata; content is not printed.'); }
}
function validPath(path) {
  check(typeof path === 'string' && path.length > 0 && path.length <= 1024 && path.split('/').every(part => part && part !== '.' && part !== '..'
    && !/[\x00-\x1f\x7f\\:*?"<>|]/.test(part) && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Unsafe candidate path.');
  return path;
}
function included(path) {
  validPath(path);
  if (sourceFiles.includes(path)) return true;
  return sourceTrees.some(tree => path.startsWith(tree + '/')) && !path.split('/').some(part => omittedNames.test(part))
    && extensions.has(extname(path).toLowerCase());
}
async function directory(path) {
  const stat = await lstat(path);
  check(stat.isDirectory() && !stat.isSymbolicLink(), 'Expected an ordinary directory, not a symlink or junction.');
  return realpath(path);
}
async function readRegular(root, path) {
  const target = join(root, path);
  for (const part of path.split('/').slice(0, -1).keys()) {
    const parent = join(root, ...path.split('/').slice(0, part + 1));
    check(within(root, await directory(parent)), `Linked parent: ${path}`);
  }
  const before = await lstat(target);
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= MAX_FILE, `Not an ordinary bounded source file: ${path}`);
  const file = await open(target, 'r');
  try {
    const opened = await file.stat();
    check(opened.dev === before.dev && opened.ino === before.ino && opened.nlink === 1, `Source changed: ${path}`);
    const chunks = []; let length = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65536, MAX_FILE - length + 1));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      length += bytesRead; check(length <= MAX_FILE, `Source exceeds size limit: ${path}`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks);
    const after = await file.stat(), current = await lstat(target);
    check(bytes.length <= MAX_FILE && bytes.length === before.size && after.size === before.size
      && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && !current.isSymbolicLink()
      && current.dev === before.dev && current.ino === before.ino && current.nlink === 1, `Source changed: ${path}`);
    return bytes;
  } finally { await file.close(); }
}
function scanCredentials(bytes, path) {
  // A small leak tripwire, not a general secret scanner or an authorization to publish.
  const text = bytes.toString('utf8');
  check(!/\bsk-[a-zA-Z0-9_-]{24,}\b|\bgh[pousr]_[a-zA-Z0-9]{30,}\b|\bgithub_pat_[a-zA-Z0-9_]{60,}\b|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(text),
    `Possible credential in ${path}; content is not printed. Review the source before packaging.`);
  if (path.endsWith('/.env.example')) {
    check(!text.split(/\r?\n/).some(line => /^\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^#\s]+/i.test(line)),
      'Environment example contains an active credential assignment; only commented examples may be distributed.');
  }
}
async function collect(root) {
  const names = new Set(sourceFiles);
  async function visit(prefix) {
    await directory(join(root, prefix));
    for (const name of (await readdir(join(root, prefix))).sort()) {
      const path = validPath(`${prefix}/${name}`);
      if (omittedNames.test(name)) continue;
      const stat = await lstat(join(root, path));
      check(!stat.isSymbolicLink(), `Linked source is not distributable: ${path}`);
      if (stat.isDirectory()) await visit(path);
      else {
        check(included(path), `Unrecognized source file: ${path}; review the inclusion policy instead of copying it silently.`);
        names.add(path); check(names.size <= MAX_FILES, 'Too many source files.');
      }
    }
  }
  for (const tree of sourceTrees) await visit(tree);
  const entries = [], folded = new Set(); let total = 0;
  for (const path of [...names].sort()) {
    const key = path.normalize('NFC').toLowerCase(); check(!folded.has(key), 'Case or Unicode path collision.'); folded.add(key);
    const bytes = await readRegular(root, path); total += bytes.length;
    check(total <= MAX_TOTAL, 'Candidate source exceeds size limit.'); scanCredentials(bytes, path);
    entries.push({ path, bytes });
  }
  const pkg = parseJson(entries.find(entry => entry.path === 'package.json').bytes);
  check(pkg.name === 'tagent' && typeof pkg.version === 'string', 'Expected the TAgent source workspace.');
  return { entries, version: pkg.version };
}

export async function createSourceCandidate(source, destination) {
  const root = await directory(resolve(source));
  const requested = resolve(destination), parent = await directory(dirname(requested));
  const target = join(parent, validPath(basename(requested)));
  check(!within(target, root) && !sourceTrees.some(tree => within(join(root, tree), target)), 'Candidate must not replace or be nested in an included source tree.');
  const { entries, version } = await collect(root);
  // No merge, overwrite, Git operation, package install or process execution.
  await mkdir(target, { mode: 0o700 });
  await writeFile(join(target, INCOMPLETE), 'Incomplete source candidate. Do not use or distribute.\n', { flag: 'wx', mode: 0o600 });
  for (const entry of entries) {
    await mkdir(dirname(join(target, entry.path)), { recursive: true, mode: 0o700 });
    await writeFile(join(target, entry.path), entry.bytes, { flag: 'wx', mode: 0o600 });
  }
  const manifest = { format: FORMAT, version, status: 'candidate-not-release-approved', createdAt: new Date().toISOString(),
    scope: 'Single-instance Web/Server/Core source; no Desktop, runtime data, credentials, dependencies, builds or Git history.',
    warning: 'Integrity inventory only, not a signature, license grant, complete secret audit or product acceptance. Do not publish automatically.',
    files: entries.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: hash(bytes) })) };
  await writeFile(join(target, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await unlink(join(target, INCOMPLETE));
  return verifySourceCandidate(target);
}

export async function verifySourceCandidate(source) {
  const root = await directory(resolve(source));
  const manifestBytes = await readRegular(root, MANIFEST);
  const manifest = parseJson(manifestBytes);
  check(manifest.format === FORMAT && manifest.status === 'candidate-not-release-approved' && Array.isArray(manifest.files)
    && manifest.files.length > 0 && manifest.files.length <= MAX_FILES, 'Invalid candidate manifest.');
  const expected = new Map(), folders = new Set(['']), folded = new Set(); let total = 0;
  for (const entry of manifest.files) {
    check(included(entry.path) && !expected.has(entry.path) && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAX_FILE
      && /^[a-f0-9]{64}$/.test(entry.sha256), 'Invalid candidate file entry.');
    const key = entry.path.normalize('NFC').toLowerCase(); check(!folded.has(key), 'Aliased candidate file entry.'); folded.add(key);
    expected.set(entry.path, entry);
    const parts = entry.path.split('/'); for (let index = 1; index < parts.length; index++) folders.add(parts.slice(0, index).join('/'));
    total += entry.size; check(total <= MAX_TOTAL, 'Candidate source exceeds size limit.');
  }
  check(sourceFiles.every(path => expected.has(path)), 'Required source files are missing.');
  const actual = new Set();
  async function visit(prefix) {
    for (const name of await readdir(join(root, prefix))) {
      const path = validPath(prefix ? `${prefix}/${name}` : name), stat = await lstat(join(root, path));
      check(!stat.isSymbolicLink(), 'Links are not allowed in candidates.');
      if (stat.isDirectory()) { check(folders.has(path), `Unexpected candidate directory: ${path}`); await visit(path); }
      else { check(path === MANIFEST || expected.has(path), `Unexpected candidate file: ${path}`); actual.add(path); }
    }
  }
  await visit('');
  check(actual.size === expected.size + 1, 'Candidate is missing files.');
  for (const entry of expected.values()) {
    const bytes = await readRegular(root, entry.path); scanCredentials(bytes, entry.path);
    check(bytes.length === entry.size && hash(bytes) === entry.sha256, `Candidate content changed: ${entry.path}`);
  }
  return { status: 'candidate-verified', files: expected.size, bytes: total, manifestSha256: hash(manifestBytes), productAccepted: false };
}

export async function main(args) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { output: { type: 'string' }, source: { type: 'string' } } });
  check(positionals.length === 1, 'Use create --output <new-directory>, or verify --source <candidate>.');
  if (positionals[0] === 'create') {
    check(values.output && !values.source, 'create requires --output and uses this script\'s source workspace.');
    return createSourceCandidate(resolve(dirname(fileURLToPath(import.meta.url)), '..'), values.output);
  }
  check(positionals[0] === 'verify' && values.source && !values.output, 'verify requires only --source.');
  return verifySourceCandidate(values.source);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Source candidate failed.'); process.exitCode = 1; }
}
