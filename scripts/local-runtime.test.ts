import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { localEnvironment } from './local-runtime.mjs';

describe('local deployment environment', () => {
  const root = process.cwd();
  it('keeps existing provider settings but fixes loopback, file data and G-root-relative storage', () => {
    const env = localEnvironment({ DEEPSEEK_API_KEY: 'fixture', TAGENT_SEARCH_PROVIDER: 'parallel', PORT: '8888',
      TAGENT_HOST: '0.0.0.0', DATABASE_URL: 'postgres://unused', TAGENT_WORKSPACE_ROOT: 'elsewhere' }, root, 'backend');
    expect(env).toMatchObject({ DEEPSEEK_API_KEY: 'fixture', TAGENT_SEARCH_PROVIDER: 'parallel', TAGENT_HOST: '127.0.0.1',
      PORT: '3001', DATABASE_URL: '', REDIS_URL: '', TAGENT_WORKSPACE_ROOT: root, NODE_ENV: 'development' });
    expect(env.TAGENT_ENV_FILE).toBe(join(root, 'packages', 'tagent-server', '.env'));
    expect(env.TEMP).toBe(join(root, '.tmp', 'local-app'));
  });
  it('does not turn a public-origin configuration into insecure local mode', () => {
    expect(() => localEnvironment({ TAGENT_PUBLIC_ORIGIN: 'https://tagent.example' }, root, 'backend')).toThrow(/HTTPS/);
  });
  it.each(['web', 'build'])('isolates %s credentials and shares the fixed local API and build directory flag', role => {
    const env = localEnvironment({ DEEPSEEK_API_KEY: 'fixture', TAGENT_ACCESS_TOKEN: 'fixture',
      NEXT_PUBLIC_API_URL: 'https://wrong.example', NEXT_PUBLIC_SECRET: 'fixture', TAGENT_SMOKE_MODE: '1' }, root, role);
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.TAGENT_ACCESS_TOKEN).toBeUndefined();
    expect(env.TAGENT_SMOKE_MODE).toBeUndefined();
    expect(env.NEXT_PUBLIC_SECRET).toBeUndefined();
    expect(env).toMatchObject({ TAGENT_ENV_FILE: '', TAGENT_LOCAL_WEB: '1', NODE_ENV: 'production', NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3001' });
  });
  it('refuses unrecognized roles before startup', () => {
    expect(() => localEnvironment({}, root, 'unknown')).toThrow();
  });
  it('excludes local build artifacts without disabling source lint in either entry point', async () => {
    const web = join(root, 'packages', 'tagent-web');
    const webLint = new ESLint({ cwd: web });
    const rootLint = new ESLint({ cwd: root });
    expect(await webLint.isPathIgnored(join(web, '.next-local', 'server', 'app', 'page.js'))).toBe(true);
    expect(await rootLint.isPathIgnored(join(web, '.next-local', 'server', 'app', 'page.js'))).toBe(true);
    expect(await webLint.isPathIgnored(join(web, 'src', 'app', 'page.tsx'))).toBe(false);
    expect(await rootLint.isPathIgnored(join(root, 'packages', 'tagent-core', 'src', 'office-delivery.ts'))).toBe(false);
  }, 15000);
});
