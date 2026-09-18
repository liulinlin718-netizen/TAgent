import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['@tagent/ai', '@tagent/core', '@tagent/server', '@tagent/web'];
export const steps = [
  ...packages.slice(0, 3).map(name => ({ command: 'pnpm', args: ['--filter', name, 'build'] })),
  ...packages.map(name => ({ command: 'pnpm', args: ['--filter', name, 'typecheck'] })),
  ...packages.map(name => ({ command: 'pnpm', args: ['--filter', name, 'lint'] })),
  { command: 'node', args: ['--test', 'scripts/check-self-test.mjs', 'scripts/data-backup-self-test.mjs', 'scripts/release-source-self-test.mjs'] },
  { command: 'pnpm', args: ['exec', 'vitest', 'run'] },
  { command: 'pnpm', args: ['--filter', '@tagent/web', 'build'] },
  { command: 'node', args: ['scripts/verify-server-lifecycle.mjs'] },
  { command: 'node', args: ['scripts/verify-request-limits.mjs'] },
  { command: 'node', args: ['scripts/verify-provider-failures.mjs'] },
  { command: 'node', args: ['scripts/verify-model-connection.mjs'] },
  { command: 'node', args: ['scripts/verify-table-runtime.mjs'] },
  { command: 'node', args: ['scripts/verify-office-runtime.mjs'] },
  { command: 'node', args: ['scripts/verify-bound-capabilities.mjs'] },
  { command: 'node', args: ['scripts/verify-run-recovery.mjs'] },
];

export function checkEnvironment(source, workspace) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/^(TAGENT_|NEXT_PUBLIC_)|(?:API_KEY|TOKEN|SECRET|PASSWORD)$|^(DATABASE_URL|REDIS_URL|NODE_ENV)$/i.test(key)));
  return { ...env, TAGENT_ENV_FILE: '', TAGENT_WORKSPACE_ROOT: workspace,
    DATABASE_URL: '', REDIS_URL: '', NEXT_TELEMETRY_DISABLED: '1' };
}

export function runChecks(execute) {
  // Server tests import workspace dist exports. Never run them while these builds are writing.
  for (const step of steps) execute(step);
}

function main() {
  if (process.argv.length > 2) throw new Error('Use pnpm check without extra arguments.');
  const pnpm = process.env.npm_execpath;
  if (!pnpm || !/pnpm\.(?:c?js)$/i.test(pnpm)) throw new Error('Run this gate with pnpm check.');
  const workspace = mkdtempSync(join(tmpdir(), 'tagent-check-'));
  const env = checkEnvironment(process.env, workspace);
  try {
    runChecks(step => {
      console.log(`\n[check] ${step.command} ${step.args.join(' ')}`);
      const result = spawnSync(process.execPath, step.command === 'pnpm' ? [pnpm, ...step.args] : step.args,
        { cwd: root, env, stdio: 'inherit', windowsHide: true, shell: false });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Check failed (${result.status ?? result.signal}): ${step.command} ${step.args.join(' ')}`);
    });
    console.log('\n[check] Local release checks passed. Live task quality and deployment acceptance are separate gates.');
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : 'Check failed'); process.exitCode = 1; }
}
