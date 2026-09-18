import type { OrchestratorConfig, OrchestratorEventHandler, OrchestratorResult } from './orchestrator.js';
import type { AgentPool } from './agent-pool.js';
import { runExplore } from './explore.js';
import { createWebResearchTool, buildFreshResearchQuery, getResearchDateContext } from './tools/web-research.js';
import { ToolRegistry } from './tools/registry.js';
import { requestToolApproval } from './tool-approval.js';
import { type ResearchSource } from './research-evidence.js';
import { runTermination } from './run-control.js';

export async function runExploration(config: OrchestratorConfig, task: string, pool: AgentPool, events?: OrchestratorEventHandler): Promise<OrchestratorResult> {
  const selected = pool.findBestAgentForTask('research', task);
  if (!selected) throw new Error('没有可用的研究 Agent。');
  const agent = structuredClone(selected), context = { taskId: 't-explore' };
  const startedAt = new Date(), dateContext = getResearchDateContext(startedAt);
  events?.onTaskDecomposition?.([{ id: context.taskId, objective: task, agentRole: 'research' }]);
  events?.onAgentSpawned?.(agent, { id: context.taskId, objective: task, agentRole: 'research' });
  events?.onAgentStage?.(agent.id, 'plan', '读取公开来源并整理探索摘要；不使用MCP、写入工具或创建子Agent。', context);
  const release = pool.beginExecution(agent.id);
  const allSources = new Map<string, ResearchSource>();
  try {
    const results = await runExplore({ provider: config.provider, model: config.model, signal: config.signal,
      researchDate: dateContext.isoDate,
      maxCost: Math.min(config.maxTotalCost ?? 0.15, agent.constraints.maxCostPerTask, 0.15),
      research: async query => {
        if (!agent.constraints.allowedTools.includes('web_research')) {
          events?.onGovernanceEvent?.(agent.id, { policyType: 'security', severity: 'hard', result: 'blocked',
            ruleName: 'explore_read_only', message: '研究 Agent 未被授权使用 web_research。' }, context);
          throw new Error('工具权限禁止联网调研。');
        }
        const args = { query: buildFreshResearchQuery(query, dateContext, task), maxResults: 5, maxPages: 3 };
        if (!await requestToolApproval('web_research', args, agent.constraints.approvalMode,
          events?.onApprovalRequest ? request => events.onApprovalRequest!(agent.id, request, context) : undefined, config.signal))
          throw new Error('尚未取得本次联网许可，未执行搜索。');
        const sources: ResearchSource[] = [], tools = new ToolRegistry(config.signal);
        tools.register(createWebResearchTool({ topic: task, now: startedAt, allowedDomains: agent.constraints.allowedDomains,
          searchProvider: config.searchProvider, searchSessionId: config.searchSessionId,
          onSources: items => {
            sources.push(...items);
            for (const item of items) allSources.set(item.url, item);
            events?.onResearchSources?.([...allSources.values()]);
          } }));
        events?.onAgentStage?.(agent.id, 'execute', '正在只读检索公开网页。', context);
        events?.onAgentToolCall?.(agent.id, 'web_research', args, context);
        const output = await tools.execute('web_research', args);
        events?.onAgentToolResult?.(agent.id, 'web_research', output.length, context);
        return [...new Map(sources.map(source => [source.url, source])).values()];
      },
    }, [{ query: task }]);
    const success = !config.signal?.aborted && results.every(result => result.status === 'complete');
    const output = ['# 只读探索', `检索日期：${dateContext.isoDate}（北京时间）`,
      '> 本结果是初步探索摘要，未经过完整报告的逐条事实核对；旧资料仅作背景。',
      ...results.map(result => [result.summary || '尚未形成可用摘要。', result.error ? `\n限制：${result.error}` : ''].join('\n')),
      '## 来源与可验证性', allSources.size ? [...allSources.values()].map(source => {
        const title = source.title.replace(/[\r\n]/g, ' ').replace(/([\\`*_{}[\]<>])/g, '\\$1');
        return `- [${title}](<${source.url.replace(/>/g, '%3E')}>)\n  来源日期：${source.publication.basis === 'publication_metadata' ? source.publication.date || '未核实' : '未核实，仅作背景'}；${source.readable ? '已读取正文' : '未取得可读正文'}；${source.relevant ? '主题相关' : '主题相关性不足'}；事实未经独立核实。`;
      }).join('\n') : '未取得可验证来源。',
    ].join('\n\n');
    const totalCost = results.reduce((total, item) => total + item.cost, 0);
    const result: OrchestratorResult = { success, output, totalCost,
      totalTokens: { input: results.reduce((total, item) => total + item.inputTokens, 0), output: results.reduce((total, item) => total + item.outputTokens, 0) },
      subResults: [{ agentId: agent.id, agentName: agent.name, taskId: context.taskId, summary: output, cost: totalCost }],
      ...(config.signal?.aborted ? { termination: runTermination(config.signal) } : {}) };
    events?.onAgentStage?.(agent.id, 'verify', '来源日期与读取状态已保留；摘要内容未作独立事实核查。', context);
    events?.onAgentComplete?.(agent.id, { success, output, iterations: 1, totalCost: result.totalCost,
      totalTokens: result.totalTokens, traceFile: '' }, context);
    events?.onSynthesisStart?.();
    events?.onTextDelta?.(output);
    events?.onComplete?.(result);
    return result;
  } finally { release(); }
}
