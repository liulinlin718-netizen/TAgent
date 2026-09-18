import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMResponse } from '@tagent/ai';
import type { MCPRegistry } from '../mcp-registry.js';
import { AgentPool } from '../agent-pool.js';
vi.mock('../trace.js', () => ({ TraceWriter: class { write() {} getPath() { return 'fixture'; } } }));
vi.mock('../tools/browser.js', () => ({ createBrowserToolSession: () => ({ tools: [], close: async () => {} }) }));
import { runOrchestrator } from '../orchestrator.js';

const reply = (content: string): LLMResponse => ({ content, toolCalls: [], model: 'fixture', stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1, cost: 0 } });
describe('Agent with real isolated MCP runtime', () => {
  it.each([{ allowed: true, approved: true }, { allowed: false, approved: true }, { allowed: true, approved: false }])('enforces the Agent whitelist and config approval: %j', async ({ allowed, approved }) => {
    const pool = new AgentPool(), agent = pool.getAgent('communication-agent')!;
    agent.capabilities.mcpServers = ['office'];
    agent.constraints.allowedTools = allowed ? ['mcp_office'] : [];
    vi.spyOn(pool, 'findBestAgentForTask').mockReturnValue(agent);
    const registry = { getServer: async () => ({ id: 'office', name: 'office', type: 'stdio', command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))], executionApproved: approved }) } as unknown as MCPRegistry;
    let attempted = false;
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(reply('[]')).mockImplementation(async params => {
      expect((params.tools || []).map(tool => tool.name)).toEqual(allowed ? ['mcp_office'] : []);
      if (!attempted) { attempted = true; return { ...reply(''), stopReason: 'tool_use', toolCalls: [{ id: 'mcp-call', name: 'mcp_office', arguments: JSON.stringify({ method: 'tools/call', params: { name: 'echo', arguments: { text: '办公材料验收' } } }) }] }; }
      const output = [...params.messages].reverse().find(message => message.role === 'tool')?.content;
      expect(output).toContain(!allowed ? '白名单' : !approved ? '尚未授权' : '办公材料验收');
      return reply('主题：材料确认\n\n请核对办公材料。');
    });
    const provider: LLMProvider = { name: 'fixture', call, stream: async function* () {} };
    const result = await runOrchestrator({ provider, model: 'fixture', agentPool: pool, mcpRegistry: registry }, '根据已有材料写一封确认邮件');
    expect(result.output).toContain('材料确认');
    expect(pool.getAgent(agent.id)?.state.business).toBe('idle');
  }, 15000);
});
