import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { AgentPool, DEFAULT_RESIDENT_SKILLS, estimateAgentBenchmarkProfile, snapshotAgentForWorkflow, type WorkflowEvent } from '../packages/tagent-core/src/index.ts';

// Public synthetic display data only. Never load the user's stores, env or API keys.
const agents = new AgentPool().getResidentAgents();
const timestamp = Date.parse('2026-09-01T09:00:00Z');
const sessionId = 'readme-office-demo', runId = 'run-readme-demo';
const dataAgent = agents.find(agent => agent.id === 'data-agent')!;
const documentAgent = agents.find(agent => agent.id === 'document-agent')!;
const traces: WorkflowEvent[] = [];
const event = (type: string, summary: string, data: Record<string, unknown>, extra: Partial<WorkflowEvent> = {}) => {
  traces.push({ eventId: `readme-${traces.length}`, runId, sessionId, type, summary, timestamp: timestamp + traces.length * 1000,
    status: 'complete', data, ...extra });
};
event('task_decomposition', '整理任务：先计算营收，再生成简报', { tasks: [
  { id: 'data', agentRole: 'data', objective: '核对三个月的营收与合计' },
  { id: 'document', agentRole: 'document', objective: '整理可编辑的经营简报', dependsOn: ['data'] },
] });
event('agent_spawn', '数据分析接收计算任务', { agentId: dataAgent.id, agentName: dataAgent.name, taskId: 'data', objective: '核对营收与合计' },
  { agentId: dataAgent.id, taskId: 'data', agentSnapshot: snapshotAgentForWorkflow(dataAgent, 'data', timestamp) });
event('agent_tool_call', '核对用户提供的表格', { agentId: dataAgent.id, taskId: 'data', tool: 'analyze_table' },
  { agentId: dataAgent.id, taskId: 'data', toolName: 'analyze_table' });
event('agent_tool_result', '合计 320 万元；不推断未提供的成本或利润', { agentId: dataAgent.id, taskId: 'data', tool: 'analyze_table', resultLength: 286 },
  { agentId: dataAgent.id, taskId: 'data', toolName: 'analyze_table', resultLength: 286 });
event('agent_complete', '数据摘要已交接', { agentId: dataAgent.id, taskId: 'data', success: true, outputSummary: '100 + 120 + 100 = 320 万元' },
  { agentId: dataAgent.id, taskId: 'data' });
event('agent_spawn', '文档助手接收已核对的数据', { agentId: documentAgent.id, agentName: documentAgent.name, taskId: 'document', objective: '整理经营简报' },
  { agentId: documentAgent.id, taskId: 'document', agentSnapshot: snapshotAgentForWorkflow(documentAgent, 'document', timestamp) });
event('governance', '仅使用所给数据，不扩写为已发生的业务原因', { agentId: documentAgent.id, taskId: 'document', ruleName: 'output_quality', action: 'warn', severity: 'info' },
  { agentId: documentAgent.id, taskId: 'document' });
event('agent_complete', '经营简报已整理', { agentId: documentAgent.id, taskId: 'document', success: true, outputSummary: '营收概览、材料边界与下月行动建议' },
  { agentId: documentAgent.id, taskId: 'document' });
event('synthesis_start', '汇总为一份结构化简报', {});
event('complete', '示例任务结束', { success: true });

const output = `# 三个月营收简报

> 合成示例数据，仅用于展示界面。此演示没有调用模型、联网或执行工具。

## 一、营收概览

| 月份 | 营收（万元） |
| --- | ---: |
| 1 月 | 100 |
| 2 月 | 120 |
| 3 月 | 100 |
| **合计** | **320** |

## 二、材料边界

- 2 月营收高于 1 月，3 月回到 100 万元。
- 未提供成本、利润或业务原因，不能据此判断盈利水平。

## 三、下月行动建议

1. 补齐分产品营收与成本口径。
2. 由业务负责人核对波动原因，再决定行动。
3. 将补充材料带回当前会话继续整理。`;
const session = { id: sessionId, title: '营收简报 · 合成示例', creationType: 'new', parentSessionId: null,
  totalCost: 0, updatedAt: new Date(timestamp).toISOString(), messages: [
    { id: 'readme-user', role: 'user', content: '请把这份三个月营收整理为简报：1 月 100 万元，2 月 120 万元，3 月 100 万元。说明材料边界，并给出下月行动建议。', traces: [] },
    { id: 'readme-answer', role: 'assistant', content: output, traces, run: { id: runId, status: 'finished' } },
  ] };
const fixture = { agents, skills: DEFAULT_RESIDENT_SKILLS.map(({ id, name, category, description }) => ({ id, name, category, description })),
  benchmarks: Object.fromEntries(agents.map(agent => [agent.id, { profile: estimateAgentBenchmarkProfile(agent) }])),
  session, workspace: { id: 'readme-workspace', name: '办公协作示例', description: '仅含合成数据', residentAgents: agents.map(agent => agent.id), sessions: [session] } };
await mkdir('output/playwright', { recursive: true });
await writeFile('output/playwright/readme-fixture.json', JSON.stringify(fixture), 'utf8');
const browserTemplate = await readFile('scripts/readme-visuals-browser.js', 'utf8');
await writeFile('output/playwright/readme-capture.js', browserTemplate.replace('const fixture = null; // generated display data',
  `const fixture = ${JSON.stringify(fixture)};`), 'utf8');
console.log('Prepared public display fixture; no user data or external calls.');
