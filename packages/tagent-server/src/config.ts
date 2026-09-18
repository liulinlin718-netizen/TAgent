import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

type Environment = Record<string, string | undefined>;

export function resolveTaskLimits(env: Environment = process.env) {
  const maxActiveRuns = Number(env.TAGENT_MAX_ACTIVE_RUNS || 4);
  const maxInputBytes = Number(env.TAGENT_MAX_TASK_INPUT_BYTES || 65536);
  if (!Number.isInteger(maxActiveRuns) || maxActiveRuns < 1 || maxActiveRuns > 16) {
    throw new Error('TAGENT_MAX_ACTIVE_RUNS must be between 1 and 16');
  }
  if (!Number.isInteger(maxInputBytes) || maxInputBytes < 1024 || maxInputBytes > 524288) {
    throw new Error('TAGENT_MAX_TASK_INPUT_BYTES must be between 1024 and 524288');
  }
  return { maxActiveRuns, maxInputBytes };
}

// Root, package and production starts must use the same data directory.
export function resolveWorkspaceRoot(moduleUrl: string, override?: string): string {
  const repositoryRoot = resolve(dirname(fileURLToPath(moduleUrl)), '../../..');
  return override ? resolve(repositoryRoot, override) : repositoryRoot;
}

export function assertRestoreComplete(root: string): void {
  if (existsSync(join(root, '.tagent-restore-incomplete'))) {
    throw new Error('数据恢复尚未完成，拒绝启动以免创建空工作区。请保留该目录，在新的空路径重新恢复并确认成功后再启动。');
  }
}

export function loadServerEnvironment(root: string, env: Environment = process.env): void {
  const configured = env.TAGENT_ENV_FILE;
  // An explicit empty path disables dotenv loading for isolated checks/deployments.
  if (configured === '') return;
  const envFile = configured
    ? (isAbsolute(configured) ? configured : resolve(root, configured))
    : join(root, 'packages/tagent-server/.env');
  if (!existsSync(envFile)) {
    if (configured) throw new Error('TAGENT_ENV_FILE does not exist');
    return;
  }
  const values = parseEnv(readFileSync(envFile, 'utf8').replace(/^\uFEFF/, ''));
  for (const [key, value] of Object.entries(values)) {
    // Shell/deployment values win, including explicit blank values.
    if (env[key] === undefined) env[key] = value;
  }
}

export type ModelProviderName = 'deepseek' | 'anthropic' | 'openai';

export function resolveModelConfig(env: Environment = process.env) {
  const provider = env.TAGENT_LLM_PROVIDER?.trim() || (
    env.DEEPSEEK_API_KEY ? 'deepseek' : env.ANTHROPIC_API_KEY ? 'anthropic' : env.OPENAI_API_KEY ? 'openai' : undefined
  );
  if (!provider) throw new Error('请配置模型 API Key：DEEPSEEK_API_KEY、ANTHROPIC_API_KEY 或 OPENAI_API_KEY。');
  if (!['deepseek', 'anthropic', 'openai'].includes(provider)) {
    throw new Error('TAGENT_LLM_PROVIDER must be deepseek, anthropic or openai');
  }
  const prefix = provider.toUpperCase();
  const apiKey = env[`${prefix}_API_KEY`]?.trim();
  if (!apiKey) throw new Error(`所选模型 ${provider} 缺少 ${prefix}_API_KEY，请检查服务端配置。`);
  const defaultModels = { deepseek: 'deepseek-flash', anthropic: 'claude-sonnet-4-20250514', openai: 'gpt-4o-mini' };
  const defaultUrls = { deepseek: 'https://api.deepseek.com', anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com/v1' };
  const name = provider as ModelProviderName;
  const baseURL = env[`${prefix}_BASE_URL`]?.trim() || defaultUrls[name];
  const url = new URL(baseURL);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${prefix}_BASE_URL must be an HTTP(S) URL without credentials, query or fragment`);
  }
  const timeoutMs = Number(env.TAGENT_LLM_TIMEOUT_MS || 60000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
    throw new Error('TAGENT_LLM_TIMEOUT_MS must be between 1000 and 300000');
  }
  return { name, apiKey, baseURL, model: env.TAGENT_LLM_MODEL?.trim() || defaultModels[name], timeoutMs };
}

export function modelConfigurationStatus(env: Environment = process.env) {
  try {
    const config = resolveModelConfig(env);
    return { status: 'configured' as const, provider: config.name, model: config.model, connectivity: 'unchecked' as const };
  } catch (error) {
    return { status: 'unconfigured' as const, provider: 'none', connectivity: 'unchecked' as const,
      message: error instanceof TypeError ? '模型服务地址格式不正确。' : (error as Error).message };
  }
}
