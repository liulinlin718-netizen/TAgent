import { Hono, type Context } from 'hono';
import { MCPConfigError, MCPRegistry, getMCPToolName, redactMCPConfig, testMCPConnection, type MCPServerConfig } from '@tagent/core';
import { scanImportRisk } from './import-safety.js';

const publicConfig = (server: MCPServerConfig) => ({ ...redactMCPConfig(server), toolName: getMCPToolName(server) });

export function createMCPManagementRoutes(registry: MCPRegistry) {
  const app = new Hono();
  const body = async (c: Context) => {
    const value = await c.req.json().catch(() => { throw new MCPConfigError('请求正文必须是有效 JSON 对象。'); });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MCPConfigError('请求正文必须是对象。');
    return value;
  };
  app.onError((error, c) => {
    if (error instanceof MCPConfigError) return c.json({ error: error.message }, error.status);
    return c.json({ error: 'MCP 请求失败，未确认的更改不会生效。' }, 500);
  });
  app.get('/', async c => c.json({ servers: (await registry.getServers()).map(publicConfig) }));
  app.post('/', async c => c.json(publicConfig(await registry.addServer(await body(c))), 201));
  app.put('/:id', async c => c.json(publicConfig(await registry.updateServer(c.req.param('id'), await body(c)))));
  app.delete('/:id', async c => { await registry.deleteServer(c.req.param('id')); return c.json({ ok: true }); });
  app.post('/:id/approval', async c => {
    const input = await body(c);
    return c.json(publicConfig(await registry.setExecutionApproval(c.req.param('id'), input.revision, input.confirmed)));
  });
  app.post('/:id/test', async c => {
    const server = await registry.getServer(c.req.param('id'));
    if (!server) return c.json({ error: 'MCP Server 不存在。' }, 404);
    const safe = redactMCPConfig(server);
    const commandPreview = [safe.command, ...(safe.args || []).map(arg => JSON.stringify(arg))].filter(Boolean).join(' ');
    return c.json({
      ...await testMCPConnection(server, c.req.raw.signal),
      ...(server.type === 'stdio' ? { commandPreview, env: safe.env, risk: scanImportRisk(commandPreview, '', commandPreview), willExecute: false, willWrite: false } : {}),
    });
  });
  return app;
}
