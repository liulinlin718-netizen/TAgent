import type { WorkflowEvent } from '@tagent/core';

export interface ResearchSmokePayload {
  output: string;
  events: Array<{
    type: string;
    data: Record<string, unknown>;
    summary?: string;
    status?: WorkflowEvent['status'];
    agentSnapshot?: WorkflowEvent['agentSnapshot'];
  }>;
}

export function buildResearchSmokePayload(message: string, now = new Date()): ResearchSmokePayload {
  const date = researchDate(now);
  const query = `${message.trim()} ${date.year}年 ${date.month}月 最新`;
  const sourceUrl = 'https://example.com/tagent-smoke/ai-agent-progress-2026-06-18';
  const output = [
    '# 近 30 天 AI Agent 最新进展（Smoke 验收样例）',
    '',
    `- 调研日期: ${date.isoDate}`,
    '- 运行模式: research_smoke，本模式不调用模型、不联网、不执行外部命令，用于验证 UI、SSE、Trace 和最终报告闭环。',
    `- 实际检索词: ${query}`,
    '',
    '## 来源与可验证性',
    '',
    '| 来源 | URL | 来源日期线索 | 可验证性 | 说明 |',
    '| --- | --- | --- | --- | --- |',
    `| TAgent smoke fixture | ${sourceUrl} | 2026-06-18 | 中：固定验收样例 | 用于验证报告字段和 trace 结构，不代表真实新闻来源 |`,
    '',
    '## 结论',
    '',
    '- 已完成本地验收链路：用户提问、web_research 工具事件、治理事件、综合输出和 complete 事件都会出现。',
    '- 当前结果是 stub，不应被产品展示为真实最新资讯。',
    '- 如果真实 web_research 不可用，最终回答必须明确说明“当前可验证来源不足”，不能把训练知识或旧资料称为最新。',
    '',
    '## 不足以验证的信息',
    '',
    '- 本 smoke 模式没有访问真实互联网，因此不能证明近 30 天真实行业进展。',
    '- 真实模式下必须使用公开来源 URL、来源日期线索和可验证性字段替换本样例。',
  ].join('\n');

  return {
    output,
    events: [
      {
        type: 'task_decomposition',
        data: {
          tasks: [{ id: 'smoke-research', agentRole: 'research', objective: message }],
        },
        summary: 'Smoke 调研任务拆解为 1 个研究任务',
        status: 'complete',
      },
      {
        type: 'agent_spawn',
        agentSnapshot: {
          version: 1, capturedAt: now.getTime(), id: 'research-agent', name: '研究助手（验收样例）',
          description: '仅生成固定验收事件，不运行实际 Agent。', icon: '', type: 'resident', role: 'research', parentAgentId: null,
          capabilities: { skills: [], tools: ['web_research'], mcpServers: [] },
          constraints: { allowedTools: ['web_research'], allowedDomains: [], maxCostPerTask: 0, maxFissionDepth: 0, approvalMode: 'suggest' },
          card: { responsibilities: ['固定事件验收'], boundaries: ['不联网、不调用模型'], qualityChecks: ['验收字段完整'], outputStandards: ['明确标记模拟输出'] },
        },
        data: {
          agentId: 'research-agent',
          agentName: '研究助手',
          taskId: 'smoke-research',
          objective: message,
        },
        summary: '研究助手接手 smoke 调研任务',
        status: 'running',
      },
      {
        type: 'agent_tool_call',
        data: {
          taskId: 'smoke-research',
          agentId: 'research-agent',
          tool: 'web_research',
          args: { query, maxResults: 5, maxPages: 3, mode: 'stub' },
        },
        summary: '研究助手调用工具 web_research',
        status: 'running',
      },
      {
        type: 'agent_tool_result',
        data: {
          taskId: 'smoke-research',
          agentId: 'research-agent',
          tool: 'web_research',
          resultLength: output.length,
        },
        summary: `web_research 返回 ${output.length} 字符`,
        status: 'complete',
      },
      {
        type: 'governance',
        data: {
          taskId: 'smoke-research',
          agentId: 'research-agent',
          policyType: 'quality',
          severity: 'info',
          result: 'passed',
          message: 'Smoke 输出包含调研日期、来源日期线索、URL、可验证性和不足以验证说明。',
        },
        summary: '治理检查通过：调研报告字段完整',
        status: 'passed',
      },
      {
        type: 'synthesis_start',
        data: {},
        summary: '进入 smoke 综合整理阶段',
        status: 'running',
      },
      {
        type: 'agent_complete',
        data: {
          taskId: 'smoke-research',
          outputSummary: output.slice(0, 2000),
          agentId: 'research-agent',
          success: true,
          iterations: 1,
          cost: 0,
        },
        summary: '研究助手完成 smoke 调研任务',
        status: 'complete',
      },
    ],
  };
}

function researchDate(now: Date): { isoDate: string; year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)?.value || '00';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  return {
    isoDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    year,
    month,
    day,
  };
}
