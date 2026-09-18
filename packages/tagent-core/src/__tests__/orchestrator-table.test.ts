import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMResponse } from '@tagent/ai';
import { AgentPool } from '../agent-pool.js';
import { runOrchestrator } from '../orchestrator.js';
import { buildConversationContext } from '../conversation-context.js';
import type { TableAnalysisReceipt } from '../tools/table-analysis.js';
vi.mock('../trace.js', () => ({ TraceWriter: class { write() {} getPath() { return 'fixture'; } } }));
const reply = (content: string, tool?: { name: string; arguments: Record<string, unknown> }): LLMResponse => ({ content, model: 'deepseek-chat',
  stopReason: tool ? 'tool_use' : 'end', toolCalls: tool ? [{ id: 'table-call', name: tool.name, arguments: JSON.stringify(tool.arguments) }] : [], usage: { inputTokens: 10, outputTokens: 10, cost: 0 } });

describe('table calculations in real orchestration paths', () => {
  it.each([false, true])('binds original user data rather than model decomposition and retains receipts in verification (fallback=%s)', async fallback => {
    const pool = new AgentPool(), agent = pool.getAgent('data-agent')!;
    vi.spyOn(pool, 'findBestAgentForTask').mockReturnValue(agent);
    let ran = false;
    const receipts: TableAnalysisReceipt[] = [], tools: string[] = [];
    const call = vi.fn<LLMProvider['call']>().mockImplementation(async params => {
      if (params.messages[0].content.includes('你是任务编排器')) return reply(fallback ? '[]' : '[{"id":"d","agentRole":"data","objective":"名,值\\na,999999"}]');
      if (params.purpose === 'verification') {
        const payload = JSON.parse(params.messages[1].content);
        expect(JSON.stringify(payload.materials)).toContain('selectionSha256');
        expect(JSON.stringify(payload.materials)).toContain('0.3');
        return reply(JSON.stringify({ ...payload.responseTemplate,
          areas: payload.responseTemplate.areas.map((area: { area: string }) => ({ ...area, status: 'passed', reason: 'Local protocol fixture only' })),
          blocks: payload.responseTemplate.blocks.map((block: { index: number }) => ({ ...block, verdict: 'non_factual', reason: 'Fixture conclusion', evidence: [] })) }));
      }
      if (params.tools?.some(tool => tool.name === 'analyze_table')) {
        if (!ran) { ran = true; return reply('', { name: 'analyze_table', arguments: { sourceId: 'current', startLine: 2, endLine: 4, format: 'csv', action: 'aggregate', metrics: [{ column: '值', operation: 'sum' }] } }); }
        const receipt = JSON.parse(params.messages.find(message => message.role === 'tool')!.content);
        expect(receipt.groups[0].metrics[0].value).toBe('0.3');
      }
      return reply('工具合计0.3，原表两条记录；未提供单位。');
    });
    const result = await runOrchestrator({ model: 'deepseek-chat', agentPool: pool, provider: { name: 'fixture', call, stream: async function* () {} } },
      '按数据表合计，不联网。\n名,值\na,0.1\nb,0.2', {
        onAgentToolCall: (_id, tool) => tools.push(tool),
        onAgentToolResult: (id, tool, _length, task, receipt) => {
          expect(id).toBe('data-agent'); expect(tool).toBe('analyze_table'); expect(task?.taskId).toBe(fallback ? 't-single' : 'd');
          if (receipt) receipts.push(receipt);
        },
      });
    expect(result.output).toContain('0.3'); expect(result.success).toBe(true);
    expect(receipts).toHaveLength(1); expect(receipts[0].provenance.rows).toBe(2);
    expect(tools).toEqual(['analyze_table']);
  });
  it.each(['whitelist', 'approval'])('does not bypass a saved %s restriction', async mode => {
    const pool = new AgentPool(), agent = pool.getAgent('data-agent')!;
    if (mode === 'whitelist') agent.constraints.allowedTools = [];
    else agent.constraints.approvalMode = 'suggest';
    vi.spyOn(pool, 'findBestAgentForTask').mockReturnValue(agent);
    let next = 0;
    const call = vi.fn<LLMProvider['call']>().mockImplementation(async params => {
      if (next++ === 0) return reply('[]');
      if (next === 2) return reply('', { name: 'analyze_table', arguments: { sourceId: 'current', startLine: 1, endLine: 2, format: 'csv', action: 'inspect' } });
      if (params.purpose !== 'verification') expect(params.messages.find(message => message.role === 'tool')?.content).toMatch(/拦截|未取得执行确认/);
      return reply('无法完成计算，请检查权限。');
    });
    const receipt = vi.fn(), blocked = vi.fn();
    await runOrchestrator({ model: 'fixture', agentPool: pool, provider: { name: 'fixture', call, stream: async function* () {} } }, '名,值\na,1', {
      onAgentToolResult: (_id, _tool, _length, _task, value) => { if (value) receipt(value); }, onGovernanceEvent: blocked,
    });
    expect(receipt).not.toHaveBeenCalled(); expect(blocked.mock.calls.some(call => call[1].result === 'blocked')).toBe(true);
    if (mode === 'whitelist') expect((call.mock.calls[1][0].tools || []).some(tool => tool.name === 'analyze_table')).toBe(false);
  });
  it('shares only selected original conversation materials with the data worker', async () => {
    const context = buildConversationContext('ws', 's', [{ id: 'u', role: 'user', content: '名,值\na,3', timestamp: 'old' },
      { id: 'a', role: 'assistant', content: '名,值\na,999', timestamp: 'old' }]);
    let next = 0;
    const call = vi.fn<LLMProvider['call']>().mockImplementation(async params => {
      if (next++ === 0) return reply('[{"id":"d","agentRole":"data","objective":"统计前文","contextMessageIds":["u","a"]}]');
      if (next === 2) return reply('', { name: 'read_data_source', arguments: {} });
      if (next === 3) expect(JSON.parse(params.messages.find(message => message.role === 'tool')!.content).sources.map((source: { id: string }) => source.id)).toEqual(['current', 'history:u']);
      return reply('协议样例，未做统计。');
    });
    await runOrchestrator({ model: 'fixture', conversationContext: context, provider: { name: 'fixture', call, stream: async function* () {} } }, '继续整理数据');
  });
});
