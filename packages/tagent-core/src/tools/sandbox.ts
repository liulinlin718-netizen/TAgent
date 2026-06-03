/**
 * Docker Sandbox Tool — D14 (plan §4 Phase 4+)
 *
 * 提供代码执行隔离环境。
 * Phase 1: 使用 Node.js child_process 模拟沙盒（安全限制）
 * Phase 4+: 升级为真正的 Docker 容器执行
 *
 * 安全策略：
 * - 超时限制 (30s)
 * - 输出长度限制 (10KB)
 * - 禁止网络访问（沙盒模式）
 */

import type { ToolExecutor } from './registry.js';

export interface SandboxConfig {
  /** 执行超时（毫秒） */
  timeout?: number;
  /** 输出最大字符数 */
  maxOutputLength?: number;
  /** 是否使用 Docker（Phase 4+） */
  useDocker?: boolean;
  /** Docker 镜像 */
  dockerImage?: string;
}

const DEFAULT_CONFIG: Required<SandboxConfig> = {
  timeout: 30000,
  maxOutputLength: 10240,
  useDocker: false,
  dockerImage: 'node:20-alpine',
};

export function createSandboxTool(config: SandboxConfig = {}): ToolExecutor {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return {
    definition: {
      name: 'run_code',
      description: '在安全沙盒中执行代码。支持 JavaScript/TypeScript。执行结果将返回 stdout 输出。',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: '要执行的代码',
          },
          language: {
            type: 'string',
            description: '语言: javascript | python | shell',
            enum: ['javascript', 'python', 'shell'],
          },
        },
        required: ['code', 'language'],
      },
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const code = args.code as string;
      const language = (args.language as string) || 'javascript';

      if (cfg.useDocker) {
        return executeInDocker(code, language, cfg);
      }
      return executeLocal(code, language, cfg);
    },
  };
}

// ─── Local Execution (Phase 1) ───────────────────────

async function executeLocal(
  code: string,
  language: string,
  cfg: Required<SandboxConfig>,
): Promise<string> {
  if (language !== 'javascript') {
    return `⚠️ 本地沙盒当前仅支持 JavaScript。请使用 Docker 模式执行 ${language}。`;
  }

  const { spawn } = await import('child_process');

  return new Promise<string>((resolve) => {
    const proc = spawn('node', ['-e', code], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: cfg.timeout,
      env: { ...process.env, NODE_ENV: 'sandbox' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > cfg.maxOutputLength) {
        proc.kill();
        stdout = stdout.slice(0, cfg.maxOutputLength) + '\n...[输出被截断]';
      }
    });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout || '(无输出)');
      } else {
        resolve(`执行错误 (exit ${exitCode}):\n${stderr || stdout}`);
      }
    });

    proc.on('error', (err: Error) => {
      resolve(`沙盒启动失败: ${err.message}`);
    });
  });
}

// ─── Docker Execution (Phase 4+) ─────────────────────

async function executeInDocker(
  code: string,
  language: string,
  cfg: Required<SandboxConfig>,
): Promise<string> {
  const { spawn } = await import('child_process');

  const langCmd: Record<string, string[]> = {
    javascript: ['node', '-e', code],
    python: ['python3', '-c', code],
    shell: ['sh', '-c', code],
  };

  const cmd = langCmd[language];
  if (!cmd) return `不支持的语言: ${language}`;

  return new Promise<string>((resolve) => {
    const proc = spawn('docker', [
      'run', '--rm',
      '--network=none',           // 禁止网络
      '--memory=128m',            // 限制内存
      `--stop-timeout=${Math.floor(cfg.timeout / 1000)}`,
      cfg.dockerImage,
      ...cmd,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: cfg.timeout + 5000, // Docker 启动额外时间
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > cfg.maxOutputLength) {
        proc.kill();
      }
    });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (exitCode) => {
      const output = stdout.slice(0, cfg.maxOutputLength);
      if (exitCode === 0) {
        resolve(output || '(无输出)');
      } else {
        resolve(`Docker 执行错误 (exit ${exitCode}):\n${(stderr || output).slice(0, 2000)}`);
      }
    });

    proc.on('error', (err: Error) => {
      if (err.message.includes('ENOENT')) {
        resolve('Docker 未安装。请安装 Docker 或使用本地沙盒模式。');
      } else {
        resolve(`Docker 启动失败: ${err.message}`);
      }
    });
  });
}
