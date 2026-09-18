import assert from 'node:assert/strict';
import test from 'node:test';
import { checkEnvironment, runChecks, steps } from './check.mjs';
import testConfig from '../vitest.config.mjs';
import { sourceFiles } from './release-source.mjs';

test('discovers only source-package and script tests and ships the discovery config', () => {
  assert.deepEqual(testConfig.test.include, [
    'packages/tagent-{ai,core,server,web}/src/**/*.{test,spec}.?(c|m)[jt]s?(x)',
    'scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)',
  ]);
  assert.ok(sourceFiles.includes('vitest.config.mjs'));
});

test('builds all runtime exports before tests and stops immediately on failure', () => {
  assert.deepEqual(steps.slice(0, 3).map(step => step.args), [
    ['--filter', '@tagent/ai', 'build'], ['--filter', '@tagent/core', 'build'], ['--filter', '@tagent/server', 'build'],
  ]);
  for (const failureIndex of [0, 2, 7, steps.length - 1]) {
    const visited = [];
    assert.throws(() => runChecks(step => { visited.push(step); if (visited.length === failureIndex + 1) throw new Error('fixture failure'); }), /fixture failure/);
    assert.equal(visited.length, failureIndex + 1);
  }
});

test('runs every step without including Desktop, live models, installs or service commands', () => {
  const visited = []; runChecks(step => visited.push(step));
  assert.deepEqual(visited, steps);
  assert.doesNotMatch(JSON.stringify(visited), /desktop|verify-live|verify-office-delivery|install|--serve|--live/);
  assert.equal(steps.filter(step => step.args[0] === 'scripts/verify-office-runtime.mjs').length, 1);
  assert.equal(steps.filter(step => step.args[0] === 'scripts/verify-bound-capabilities.mjs').length, 1);
  assert.equal(steps.filter(step => step.args.includes('scripts/release-source-self-test.mjs')).length, 1);
  assert.equal(steps.filter(step => step.args.includes('typecheck')).length, 4);
  assert.equal(steps.filter(step => step.args.includes('lint')).length, 4);
});

test('isolates test data and removes inherited model keys, deployment settings and browser API overrides', () => {
  const original = { PATH: 'path', DEEPSEEK_API_KEY: 'secret', anthropic_api_key: 'secret', GITHUB_TOKEN: 'secret',
    TAGENT_ENV_FILE: 'real.env', TAGENT_WORKSPACE_ROOT: 'real-data', TAGENT_HOST: '0.0.0.0', NEXT_PUBLIC_API_BASE: 'https://production',
    DATABASE_URL: 'postgres://production', REDIS_URL: 'redis://production', npm_execpath: 'pnpm.cjs' };
  const env = checkEnvironment(original, 'temporary-data');
  assert.equal(env.PATH, 'path'); assert.equal(env.npm_execpath, 'pnpm.cjs');
  assert.equal(env.TAGENT_WORKSPACE_ROOT, 'temporary-data'); assert.equal(env.TAGENT_ENV_FILE, '');
  assert.equal(env.DATABASE_URL, ''); assert.equal(env.REDIS_URL, '');
  assert.doesNotMatch(JSON.stringify(env), /secret|production|real-data|real.env|0\.0\.0\.0/);
  assert.equal(original.TAGENT_WORKSPACE_ROOT, 'real-data');
});
