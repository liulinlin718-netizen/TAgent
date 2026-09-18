import { describe, expect, it } from 'vitest';
import { AgentPool } from '../agent-pool.js';
import { runAgentBenchmark, type BenchmarkTraceInput } from '../benchmark.js';
import type { WorkflowEvent } from '../protocol.js';

describe('trace-aware benchmark', () => {
  it('rejects legacy keyword-only trace input without an attributable stored run', () => {
    const agent = new AgentPool().getAgent('research-agent');
    expect(agent).toBeTruthy();

    const events: WorkflowEvent[] = [
      {
        eventId: 'evt-tool-call',
        type: 'agent_tool_call',
        agentId: 'research-agent',
        status: 'running',
        summary: '研究助手调用工具 web_research',
        timestamp: 1,
        toolName: 'web_research',
        data: { tool: 'web_research' },
      },
      {
        eventId: 'evt-tool-result',
        type: 'agent_tool_result',
        agentId: 'research-agent',
        status: 'complete',
        summary: 'web_research 返回 1200 字符',
        timestamp: 2,
        toolName: 'web_research',
        resultLength: 1200,
        data: { tool: 'web_research', resultLength: 1200 },
      },
      {
        eventId: 'evt-complete',
        type: 'complete',
        status: 'complete',
        summary: '任务完成',
        timestamp: 3,
        data: { success: true },
      },
    ];
    const output = [
      '- 调研日期: 2026-06-18',
      '- 来源日期线索: 2026-06-18',
      '- URL: https://example.com/ai-agent-news',
      '- 可验证性: 中高',
      '- 不足以验证的信息: 未读取到公开来源时不得称为最新。',
    ].join('\n');

    expect(() => runAgentBenchmark(agent!, undefined, { events, output } as unknown as BenchmarkTraceInput)).toThrow();
  });
});
