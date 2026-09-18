import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { assertRestoreComplete, loadServerEnvironment, modelConfigurationStatus, resolveModelConfig, resolveWorkspaceRoot, resolveTaskLimits } from '../config.js';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
describe('server startup configuration', () => {
  it('refuses an incomplete restore before initializing a new workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagent-restore-guard-'));
    directories.push(root);
    expect(() => assertRestoreComplete(root)).not.toThrow();
    mkdirSync(join(root, '.tagent-restore-incomplete'));
    expect(() => assertRestoreComplete(root)).toThrow('数据恢复尚未完成');
    mkdirSync(join(root, '.tagent'));
    expect(() => assertRestoreComplete(root)).toThrow('数据恢复尚未完成');
  });
  it('uses bounded task admission defaults and explicit deployment overrides', () => {
    expect(resolveTaskLimits({})).toEqual({ maxActiveRuns: 4, maxInputBytes: 65536 });
    expect(resolveTaskLimits({ TAGENT_MAX_ACTIVE_RUNS: '2', TAGENT_MAX_TASK_INPUT_BYTES: '131072' }))
      .toEqual({ maxActiveRuns: 2, maxInputBytes: 131072 });
  });
  it.each(['0', '-1', '1.5', '17', 'no-limit', 'Infinity'])('rejects invalid active-run limit %s', value => {
    expect(() => resolveTaskLimits({ TAGENT_MAX_ACTIVE_RUNS: value })).toThrow('TAGENT_MAX_ACTIVE_RUNS');
  });
  it.each(['0', '1023', '524289', 'NaN', 'Infinity', '2048.5'])('rejects invalid task byte limit %s', value => {
    expect(() => resolveTaskLimits({ TAGENT_MAX_TASK_INPUT_BYTES: value })).toThrow('TAGENT_MAX_TASK_INPUT_BYTES');
  });

  it('uses the same root for source and bundled entry points', () => {
    const root = resolve('fixture');
    for (const entry of ['src/index.ts', 'dist/index.js']) {
      expect(resolveWorkspaceRoot(pathToFileURL(join(root, 'packages/tagent-server', entry)).href)).toBe(root);
      expect(resolveWorkspaceRoot(pathToFileURL(join(root, 'packages/tagent-server', entry)).href, './isolated')).toBe(join(root, 'isolated'));
    }
  });
  it('parses quoted UTF-8 env values without overriding deployment values', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagent-env-'));
    directories.push(root);
    mkdirSync(join(root, 'packages/tagent-server'), { recursive: true });
    writeFileSync(join(root, 'packages/tagent-server/.env'), '\uFEFFPORT=3001\nDATABASE_URL=from-file\nLABEL="中文 # label"\n# ignore\n', 'utf8');
    const env: Record<string, string | undefined> = { PORT: '3091', DATABASE_URL: '' };
    loadServerEnvironment(root, env);
    expect(env).toEqual({ PORT: '3091', DATABASE_URL: '', LABEL: '中文 # label' });
  });
  it('supports each existing provider and an explicit choice', () => {
    expect(resolveModelConfig({ OPENAI_API_KEY: 'test' }).name).toBe('openai');
    expect(resolveModelConfig({ ANTHROPIC_API_KEY: 'test' }).name).toBe('anthropic');
    expect(resolveModelConfig({ DEEPSEEK_API_KEY: 'test' }).name).toBe('deepseek');
    expect(resolveModelConfig({ DEEPSEEK_API_KEY: 'test' }).model).toBe('deepseek-flash');
    expect(resolveModelConfig({ DEEPSEEK_API_KEY: 'test', TAGENT_LLM_MODEL: 'custom-model' }).model).toBe('custom-model');
    expect(resolveModelConfig({ TAGENT_LLM_PROVIDER: 'openai', DEEPSEEK_API_KEY: 'test', OPENAI_API_KEY: 'test', TAGENT_LLM_MODEL: 'custom-model' }).model).toBe('custom-model');
  });
  it('does not load default credentials when the env file is explicitly disabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagent-env-disabled-'));
    directories.push(root);
    mkdirSync(join(root, 'packages/tagent-server'), { recursive: true });
    writeFileSync(join(root, 'packages/tagent-server/.env'), 'DEEPSEEK_API_KEY=fixture-only\nPARALLEL_API_KEY=fixture-only\n', 'utf8');
    const env = { TAGENT_ENV_FILE: '' };
    loadServerEnvironment(root, env);
    expect(env).toEqual({ TAGENT_ENV_FILE: '' });
    expect(modelConfigurationStatus(env).status).toBe('unconfigured');
  });
  it('keeps office review on the task model unless deployment explicitly selects a priced same-provider profile', () => {
    const env = { DEEPSEEK_API_KEY: 'private-fixture-key' };
    expect(resolveModelConfig(env).officeReview).toEqual({ model: 'deepseek-flash', reasoning: 'disabled' });
    const selected = { ...env, TAGENT_OFFICE_REVIEW_MODEL: ' deepseek-v4-pro ', TAGENT_OFFICE_REVIEW_REASONING: 'low' };
    expect(resolveModelConfig(selected)).toMatchObject({ model: 'deepseek-flash', officeReview: { model: 'deepseek-v4-pro', reasoning: 'low' } });
    expect(modelConfigurationStatus(selected)).toMatchObject({ model: 'deepseek-flash', officeReview: { model: 'deepseek-v4-pro', reasoning: 'low' }, connectivity: 'unchecked' });
    expect(JSON.stringify(modelConfigurationStatus(selected))).not.toContain(env.DEEPSEEK_API_KEY);
    expect(resolveModelConfig({ ...env, TAGENT_LLM_MODEL: 'unpriced-main-model' }).officeReview.model).toBe('unpriced-main-model');
  });
  it.each(['unknown-price', 'gpt-4o', 'claude-sonnet-4-20250514', '__proto__'])('rejects an unpriced or cross-provider office review model: %s', model => {
    expect(() => resolveModelConfig({ DEEPSEEK_API_KEY: 'fixture', TAGENT_OFFICE_REVIEW_MODEL: model })).toThrow('TAGENT_OFFICE_REVIEW_MODEL');
  });
  it.each([
    { DEEPSEEK_API_KEY: 'fixture', TAGENT_OFFICE_REVIEW_REASONING: 'high' },
    { DEEPSEEK_API_KEY: 'fixture', TAGENT_OFFICE_REVIEW_MODEL: 'deepseek-chat', TAGENT_OFFICE_REVIEW_REASONING: 'low' },
    { OPENAI_API_KEY: 'fixture', TAGENT_OFFICE_REVIEW_REASONING: 'low' },
  ])('rejects unsupported office thinking configuration', env => {
    expect(() => resolveModelConfig(env)).toThrow('TAGENT_OFFICE_REVIEW_REASONING');
  });
  it('validates endpoint and timeout and does not expose keys in health', () => {
    const env = { OPENAI_API_KEY: 'secret-do-not-expose', OPENAI_BASE_URL: 'http://localhost:1234/v1', TAGENT_LLM_TIMEOUT_MS: '2000' };
    expect(resolveModelConfig(env).timeoutMs).toBe(2000);
    expect(JSON.stringify(modelConfigurationStatus(env))).not.toContain(env.OPENAI_API_KEY);
    expect(modelConfigurationStatus(env).connectivity).toBe('unchecked');
    expect(() => resolveModelConfig({ ...env, OPENAI_BASE_URL: 'file:///tmp/key' })).toThrow();
    expect(() => resolveModelConfig({ ...env, TAGENT_LLM_TIMEOUT_MS: '0' })).toThrow();
    expect(modelConfigurationStatus({}).status).toBe('unconfigured');
  });
});
