import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkEnvironment } from './check.mjs';

export function localEnvironment(source, root, role) {
  if (!['backend', 'web', 'build'].includes(role)) throw new Error('Unknown local runtime role.');
  const temp = join(root, '.tmp', 'local-app');
  const shared = { TEMP: temp, TMP: temp, NODE_COMPILE_CACHE: join(temp, 'node-cache'), NEXT_TELEMETRY_DISABLED: '1' };
  if (role === 'backend') {
    if (source.TAGENT_PUBLIC_ORIGIN) throw new Error('Use the HTTPS deployment procedure for a public origin.');
    return { ...source, ...shared,
      // Loopback-only policy, compiled code without a watcher. Not a public production deployment.
      NODE_ENV: 'development', TAGENT_HOST: '127.0.0.1', PORT: '3001',
      TAGENT_ENV_FILE: join(root, 'packages', 'tagent-server', '.env'), TAGENT_WORKSPACE_ROOT: root,
      TAGENT_WEB_ORIGINS: 'http://127.0.0.1:3000,http://localhost:3000', DATABASE_URL: '', REDIS_URL: '',
    };
  }
  return { ...checkEnvironment(source, root), ...shared, NODE_ENV: 'production', TAGENT_LOCAL_WEB: '1',
    NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3001' };
}

async function main() {
  const role = process.argv[2];
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const env = localEnvironment(process.env, root, role);
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  mkdirSync(env.TEMP, { recursive: true });
  if (role === 'backend') {
    await import(pathToFileURL(join(root, 'packages/tagent-server/dist/index.js')).href);
  } else {
    const web = join(root, 'packages', 'tagent-web');
    const next = join(web, 'node_modules', 'next', 'dist', 'bin', 'next');
    if (role === 'web') readFileSync(join(web, '.next-local', 'BUILD_ID'), 'utf8');
    process.chdir(web);
    process.argv = [process.execPath, next, ...(role === 'build' ? ['build'] : ['start', '--hostname', '127.0.0.1', '--port', '3000'])];
    await import(pathToFileURL(next).href);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
