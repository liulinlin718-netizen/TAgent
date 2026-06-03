/**
 * MCP Tool Bridge — 将 MCP Server 转换为可执行的 ToolExecutor (D6)
 *
 * 当前支持 stdio 和 http 两种传输协议：
 * - stdio: 通过子进程的 stdin/stdout 进行 JSON-RPC 通信
 * - http:  通过 HTTP POST 调用 MCP 端点
 *
 * 将每个 MCP Server 注册为一个 ToolExecutor，
 * Agent 可以像使用内置工具一样调用 MCP 功能。
 */

import type { ToolExecutor } from './registry.js';
import type { MCPServerConfig } from '../mcp-registry.js';

// ─── Types ───────────────────────────────────────────

interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ─── MCP Tool Bridge ─────────────────────────────────

/**
 * D6: 将 MCP Server 配置转换为 ToolExecutor
 *
 * 返回的 ToolExecutor 作为代理工具：
 * - Agent 调用 `mcp:<server-name>` 工具
 * - Bridge 将参数转发到 MCP Server
 * - 返回 MCP Server 的响应
 */
export function createMCPBridgeTool(server: MCPServerConfig): ToolExecutor {
  return {
    definition: {
      name: `mcp_${server.name.replace(/[^a-zA-Z0-9_]/g, '_')}`,
      description: `[MCP] ${server.name} — 通过 MCP 协议调用外部服务 (${server.type})`,
      parameters: {
        type: 'object',
        properties: {
          method: {
            type: 'string',
            description: 'MCP 方法名 (如 tools/call, resources/read)',
          },
          params: {
            type: 'object',
            description: 'MCP 方法参数',
          },
        },
        required: ['method'],
      },
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const method = args.method as string;
      const params = (args.params || {}) as Record<string, unknown>;

      try {
        if (server.type === 'http' || server.type === 'sse') {
          return await callHTTP(server, method, params);
        }

        if (server.type === 'stdio') {
          return await callStdio(server, method, params);
        }

        return `不支持的 MCP 传输类型: ${server.type}`;
      } catch (err) {
        return `MCP 调用失败 [${server.name}]: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ─── HTTP Transport ──────────────────────────────────

async function callHTTP(
  server: MCPServerConfig,
  method: string,
  params: Record<string, unknown>,
): Promise<string> {
  if (!server.url) return 'MCP HTTP Server 未配置 URL';

  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    return `MCP HTTP 错误: ${response.status} ${response.statusText}`;
  }

  const result = await response.json() as { result?: unknown; error?: { message: string } };

  if (result.error) {
    return `MCP 错误: ${result.error.message}`;
  }

  return typeof result.result === 'string'
    ? result.result
    : JSON.stringify(result.result, null, 2);
}

// ─── Stdio Transport ─────────────────────────────────

async function callStdio(
  server: MCPServerConfig,
  method: string,
  params: Record<string, unknown>,
): Promise<string> {
  if (!server.command) return 'MCP Stdio Server 未配置 command';

  // 使用 Node.js child_process 通过 stdio 通信
  const { spawn } = await import('child_process');

  return new Promise<string>((resolve) => {
    const proc = spawn(server.command!, server.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...server.env },
    });

    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', () => {
      try {
        const result = JSON.parse(stdout) as { result?: unknown; error?: { message: string } };
        if (result.error) {
          resolve(`MCP Stdio 错误: ${result.error.message}`);
        } else {
          resolve(typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result, null, 2));
        }
      } catch {
        resolve(stdout || stderr || 'MCP Stdio: 无响应');
      }
    });

    proc.on('error', (err: Error) => {
      resolve(`MCP Stdio 启动失败: ${err.message}`);
    });

    // 发送请求并关闭 stdin
    proc.stdin.write(request + '\n');
    proc.stdin.end();

    // 30s 超时
    setTimeout(() => {
      proc.kill();
      resolve('MCP Stdio 超时 (30s)');
    }, 30000);
  });
}

/**
 * D6: 批量注册 MCP Servers 到 ToolRegistry
 */
export async function registerMCPTools(
  servers: MCPServerConfig[],
  registry: { register: (tool: ToolExecutor) => void },
): Promise<string[]> {
  const registered: string[] = [];
  for (const server of servers) {
    const tool = createMCPBridgeTool(server);
    registry.register(tool);
    registered.push(tool.definition.name);
  }
  return registered;
}
