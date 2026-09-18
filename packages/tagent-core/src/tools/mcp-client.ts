import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { publicFetch, assertPublicUrl } from '../public-network.js';
import { isMCPRecord, redactMCPText, redactMCPValue, validateMCPConfig, type MCPServerConfig } from '../mcp-config.js';
import { OwnedMCPStdioTransport } from './mcp-stdio.js';

export async function withMCPClient<T>(server: MCPServerConfig, operation: (client: Client, signal: AbortSignal) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
  validateMCPConfig(server);
  if (server.type === 'stdio' && server.executionApproved !== true) throw new Error('此 MCP 命令尚未授权执行，请先在管理中心核对并确认。');
  const scope = new AbortController();
  const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(30_000), ...(parentSignal ? [parentSignal] : [])]);
  signal.throwIfAborted();
  let transport: Transport;
  if (server.type === 'stdio') transport = new OwnedMCPStdioTransport(server);
  else {
    const target = assertPublicUrl(server.url!);
    const guardedFetch: FetchLike = async (input, init = {}) => {
      const url = assertPublicUrl(input instanceof Request ? input.url : String(input));
      // Legacy SSE announces its POST endpoint. It may not redirect credentials to another host.
      if (url.origin !== target.origin) throw new Error('MCP 服务要求跨站发送请求，已拦截。');
      const response = await publicFetch(url, {
        ...init, redirect: 'error', streamBody: true, maxBytes: 256 * 1024,
        signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]),
      });
      if (!response.ok && response.status !== 405) { await response.body?.cancel(); throw new Error(`MCP HTTP ${response.status}${response.status === 401 || response.status === 403 ? '：请检查认证配置。' : ''}`); }
      return response;
    };
    const requestInit = { headers: server.headers || {} };
    transport = server.type === 'sse'
      ? new SSEClientTransport(target, { fetch: guardedFetch, requestInit, eventSourceInit: { fetch: guardedFetch } })
      : new StreamableHTTPClientTransport(target, { fetch: guardedFetch, requestInit, reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
  }
  const client = new Client({ name: 'TAgent', version: '0.1.0' }, { capabilities: {} });
  const close = () => { void transport.close().catch(() => {}); };
  signal.addEventListener('abort', close, { once: true });
  try {
    await client.connect(transport, { signal, timeout: 30_000 });
    signal.throwIfAborted();
    return await operation(client, signal);
  } finally {
    signal.removeEventListener('abort', close);
    // A successful HTTP operation also releases the server-side session, not just the socket.
    if (!signal.aborted && transport instanceof StreamableHTTPClientTransport) await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
    scope.abort();
    await transport.close();
  }
}

export const MCP_METHODS = ['tools/list', 'tools/call', 'resources/list', 'resources/read', 'prompts/list', 'prompts/get'] as const;

export async function callMCP(server: MCPServerConfig, method: unknown, params: unknown, signal?: AbortSignal): Promise<string> {
  if (!MCP_METHODS.includes(method as typeof MCP_METHODS[number]) || !isMCPRecord(params)) throw new Error('不支持的 MCP 方法或无效参数。');
  const result = await withMCPClient(server, async (client, signal) => {
    const options = { signal, timeout: 30_000 };
    const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
    switch (method) {
      case 'tools/list': return client.listTools({ cursor }, options);
      case 'resources/list': return client.listResources({ cursor }, options);
      case 'prompts/list': return client.listPrompts({ cursor }, options);
      case 'tools/call':
        if (typeof params.name !== 'string' || (params.arguments !== undefined && !isMCPRecord(params.arguments))) throw new Error('工具名称或参数无效。');
        return client.callTool({ name: params.name, arguments: params.arguments as Record<string, unknown> | undefined }, undefined, options);
      case 'resources/read':
        if (typeof params.uri !== 'string') throw new Error('资源 URI 无效。');
        return client.readResource({ uri: params.uri }, options);
      case 'prompts/get':
        if (typeof params.name !== 'string' || (params.arguments !== undefined && (!isMCPRecord(params.arguments) || Object.values(params.arguments).some(value => typeof value !== 'string')))) throw new Error('Prompt 名称或参数无效。');
        return client.getPrompt({ name: params.name, arguments: params.arguments as Record<string, string> | undefined }, options);
    }
  }, signal);
  return JSON.stringify(redactMCPValue(result, server));
}

export async function testMCPConnection(server: MCPServerConfig, signal?: AbortSignal) {
  if (server.type === 'stdio') return { ok: false, status: 'preview_only', message: 'stdio 测试仅预览配置，不启动进程、不安装依赖。授权后，仅绑定且允许该工具的 Agent 可在任务中调用。', tools: [] };
  try {
    return await withMCPClient(server, async (client, signal) => {
      const tools = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      if (client.getServerCapabilities()?.tools) do {
        const page = await client.listTools({ cursor }, { signal, timeout: 30_000 });
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (tools.length > 200 || (cursor && seen.has(cursor)) || seen.size >= 10) throw new Error('MCP 工具列表超过预览限制或分页重复。');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return redactMCPValue({ ok: true, status: 'connected', message: `MCP 握手成功，发现 ${tools.length} 个工具。未执行工具。`, serverInfo: client.getServerVersion(), tools }, server);
    }, signal);
  } catch (error) {
    return { ok: false, status: 'failed', message: redactMCPText(error instanceof Error ? error.message : 'MCP 握手失败。', server), tools: [] };
  }
}
