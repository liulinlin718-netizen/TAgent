import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callMCP, testMCPConnection } from '../tools/mcp-client.js';
import { createMCPBridgeTool } from '../tools/mcp-bridge.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const remote = { id: 'r', name: 'Remote', type: 'http' as const, url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer secret-value' } };
const stdio = { id: 's', name: 'Fixture', type: 'stdio' as const, command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url)), '含空格的 参数'], env: { OWN_KEY: 'own-secret' }, executionApproved: true };

function mockServer(mode: 'json' | 'stream' | 'html' | 'unauthorized' = 'json') {
  const methods: string[] = [];
  const cancels: string[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-value');
    if (init.method === 'GET') return new Response(null, { status: 405 });
    if (init.method === 'DELETE') { methods.push('DELETE'); return new Response(null, { status: 204 }); }
    const request = JSON.parse(String(init.body)); methods.push(request.method);
    if (mode === 'html') return new Response('<html>not MCP</html>', { headers: { 'Content-Type': 'text/html' } });
    if (mode === 'unauthorized') return new Response('secret-value', { status: 401 });
    if (request.method !== 'initialize') {
      expect(new Headers(init.headers).get('mcp-session-id')).toBe('session-fixture');
      expect(new Headers(init.headers).get('mcp-protocol-version')).toBeTruthy();
    }
    if (!('id' in request)) return new Response(null, { status: 202 });
    const result = request.method === 'initialize'
      ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
      : request.method === 'tools/list' ? { tools: [{ name: request.params?.cursor ? 'second' : 'first', inputSchema: { type: 'object' } }], ...(!request.params?.cursor ? { nextCursor: 'page2' } : {}) }
      : { content: [{ type: 'text', text: 'result with secret-value' }] };
    const message = JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
    if (mode === 'stream') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${message}\n\n`)); }, cancel() { cancels.push(request.method); } }), { headers: { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'session-fixture' } });
    return new Response(message, { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-fixture' } });
  });
  vi.stubGlobal('fetch', fetch);
  return { methods, fetch, cancels };
}

describe('MCP official SDK lifecycle', () => {
  it.each(['json', 'stream'] as const)('initializes, negotiates, lists all pages and releases the %s session', async mode => {
    const fixture = mockServer(mode);
    const result = await testMCPConnection(remote);
    expect(result.ok).toBe(true);
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(['first', 'second']);
    expect(fixture.methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE']);
    if (mode === 'stream') expect(fixture.cancels).toContain('initialize');
  });
  it('performs tools/call only after initialization and redacts server echoes', async () => {
    const fixture = mockServer();
    const result = await callMCP(remote, 'tools/call', { name: 'echo', arguments: { text: 'test' } });
    expect(result).toContain('result with');
    expect(result).not.toContain('secret-value');
    expect(fixture.methods).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'DELETE']);
  });
  it.each(['html', 'unauthorized'] as const)('does not report a %s response as connected', async mode => {
    mockServer(mode);
    const result = await testMCPConnection(remote);
    expect(result.ok).toBe(false);
    expect(result.tools).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });
  it('rejects private endpoints and unknown RPC methods before network requests', async () => {
    const fixture = mockServer();
    expect((await testMCPConnection({ ...remote, url: 'http://127.0.0.1:8888' })).ok).toBe(false);
    await expect(callMCP(remote, 'arbitrary/execute', {})).rejects.toThrow('不支持');
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it('keeps stdio tests preview-only even after execution approval', async () => {
    const result = await testMCPConnection({ ...stdio, command: 'definitely-not-an-executable' });
    expect(result.status).toBe('preview_only');
    expect(result.ok).toBe(false);
  });
  it('supports authenticated legacy SSE and blocks an endpoint on another origin', async () => {
    let stream: ReadableStreamDefaultController<Uint8Array>;
    const methods: string[] = [];
    const cancel = vi.fn();
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-value');
      if ((init.method || 'GET') === 'GET') return new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode('event: endpoint\ndata: /messages\n\n')); }, cancel }), { headers: { 'Content-Type': 'text/event-stream' } });
      expect(String(url)).toBe('https://mcp.example/messages');
      const request = JSON.parse(String(init.body)); methods.push(request.method);
      if (request.id !== undefined) {
        const result = request.method === 'initialize' ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'legacy', version: '1' } } : { tools: [] };
        stream.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`));
      }
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal('fetch', fetch);
    expect((await testMCPConnection({ ...remote, type: 'sse' })).ok).toBe(true);
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(cancel).toHaveBeenCalledOnce();
    fetch.mockReset().mockResolvedValue(new Response('event: endpoint\ndata: https://evil.example/post\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    expect((await testMCPConnection({ ...remote, type: 'sse' })).ok).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('blocks runtime execution without an explicit approval', async () => {
    await expect(callMCP({ ...stdio, executionApproved: false }, 'tools/list', {})).rejects.toThrow('尚未授权');
  });
  it('calls a real stdio SDK server; preserves arguments and does not inherit provider secrets', async () => {
    vi.stubEnv('TAGENT_TEST_PRIVATE_KEY', 'should-never-be-inherited');
    const result = await callMCP(stdio, 'tools/call', { name: 'echo', arguments: { text: '中文 🙂' } });
    expect(result).toContain('中文 🙂');
    expect(result).toContain('含空格的 参数');
    expect(result).toContain('leaked\\":null');
    expect(result).not.toContain('own-secret');
    expect(result).not.toContain('should-never-be-inherited');
  }, 15000);
  it('cancels the owned stdio process and does not hang on an incomplete message', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    try { await expect(callMCP(stdio, 'tools/call', { name: 'echo', arguments: { wait: true } }, controller.signal)).rejects.toThrow(); }
    finally { clearTimeout(timer); }
    const output = await createMCPBridgeTool(stdio).execute({ method: 'tools/call', params: { name: 'echo', arguments: { oversized: true } } });
    expect(output).toContain('MCP 调用失败');
  }, 15000);
});
