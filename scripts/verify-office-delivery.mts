import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LLMProvider } from '../packages/tagent-ai/src/index.js';
import type { OrchestratorEventHandler } from '../packages/tagent-core/src/orchestrator.js';
import { checkOfficeTable, officeTable } from './office-acceptance.js';
import { acceptanceOptions, createAcceptanceProvider, reserveAcceptanceCost } from './model-acceptance.js';

// Manual model acceptance, never included in CI or automatic Benchmark runs.
const limits = acceptanceOptions(process.argv.slice(2));
assert.ok(limits.positional.length > 0, 'Select at least one explicitly authorized office role.');
const { AnthropicProvider, OpenAIProvider } = await import('../packages/tagent-ai/src/index.js');
const { runOrchestrator } = await import('../packages/tagent-core/src/orchestrator.js');
const { AgentPool } = await import('../packages/tagent-core/src/agent-pool.js');
const { SkillsRegistry } = await import('../packages/tagent-core/src/skills-registry.js');
const { closeSharedBrowser } = await import('../packages/tagent-core/src/tools/browser-pool.js');
const { loadServerEnvironment, resolveModelConfig } = await import('../packages/tagent-server/src/config.js');
const { TABLE_TOOLS } = await import('../packages/tagent-core/src/tools/table-analysis.js');
const root = fileURLToPath(new URL('../', import.meta.url));
loadServerEnvironment(root);
const config = resolveModelConfig();
const underlying: LLMProvider = config.name === 'anthropic'
  ? new AnthropicProvider({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: config.timeoutMs, maxRetries: 0 })
  : new OpenAIProvider({ apiKey: config.apiKey, baseURL: config.baseURL, name: config.name, timeout: config.timeoutMs, maxRetries: 0 });
const acceptance = createAcceptanceProvider(underlying, limits, reserveAcceptanceCost);
const provider = acceptance.provider;
const cases = [
  { role: 'research', task: '核对两份来源材料的矛盾，给出可确认事实、不能确认的结论和补证清单，不擅自选其中一份为真。来源A：内部简报说试点覆盖240家门店，但未说明统计日期。来源B：项目台账记载2026年8月31日启用210家门店、其中30家暂停。', checks: [/240/, /210/, /来源A|来源 A/, /来源B|来源 B/, /不能|不足|不确定|无法|待核实/] },
  { role: 'document', maxCharacters: 300, task: '将材料整理成300字以内团队周报（按非空白字符计，含数字、标点和Markdown符号），包含“本周完成”“风险”“下周计划”，区分完成与计划，不新增事实。材料：完成登录页；支付接口联调未完成，依赖供应商反馈；测试覆盖率从60%到75%；下周计划完成联调并补测试。', checks: [/本周完成/, /风险/, /下周计划/, /75%/, /供应商/] },
  { role: 'data', maxCharacters: 300, task: '使用原始表格工具读取下方CSV、按月份汇总收入并比较两次环比，回答总额、口径和异常，不把相关性当成原因。单位为万元，三个数口径一致、均为月收入，未给出成本与业务原因。用300字以内回答（按非空白字符计，含数字、标点和Markdown符号）。\n' + officeTable, checks: [/310/, /20\s*%/, /25\s*%/, /万元/, /不能|未提供|未给|缺乏|无法|不足/] },
  { role: 'project', task: '给出任务排期表和风险/验收标准。A需求确认2个工作日；B设计3日依赖A；C开发4日依赖B；D测试2日依赖C。第1工作日开始，无并行条件，不指定日历日期；研发负责人待定。标出总工期和责任缺口，不虚构人员。', checks: [/11/, /依赖/, /验收/, /待定/, /风险/] },
  { role: 'communication', task: '只给出可发送的邮件主题和正文，正文120字以内，不附分析，不声称已发送。收件人：项目组。内部演示由周四改到周五下午3点，原因是补充测试；请大家周三前回执确认。', checks: [/主题/, /周五/, /3点|三点|15:00|15点/, /周三/, /回执|回复|确认/] },
  { role: 'presentation', task: '为管理层输出5页PPT大纲，每页给出结论式标题、2个要点和一句讲稿；最后一页明确待决策事项。材料：试点10家门店，平均等待时间从8分钟降到5分钟；样本小，尚无收入数据；建议下一轮扩大到30家，需要批准测试预算但金额未定。不得声称已生成PPT文件。', checks: [/第?\s*5\s*页|页面\s*5|Slide\s*5/i, /讲稿|演讲|讲解/, /10/, /30/, /预算/, /未定|待定|待确认|待批准/] },
];
const selected = limits.positional;
assert.ok(selected.every(role => cases.some(test => test.role === role)), 'Unknown case role');
const directory = resolve(root, 'output', `office-delivery-${Date.now()}`);
await mkdir(directory, { recursive: true });
const previousDirectory = process.cwd();
process.chdir(directory);
console.log(JSON.stringify({ directory, provider: config.name, model: config.model, live: true,
  limits: acceptance.snapshot(),
  policy: 'Given material only; isolated default agents/skills; data case permits only existing read-only table tools. No external tools, files sent, user configuration or session writes. Protocol traces and acceptance artifacts are written locally.' }));
try {
  for (const test of cases.filter(test => selected.includes(test.role))) {
    const started = Date.now(), before = acceptance.snapshot();
    const pool = new AgentPool();
    for (const agent of pool.getAllAgents()) {
      agent.constraints.allowedTools = test.role === 'data' && agent.id === 'data-agent'
        ? agent.constraints.allowedTools.filter(tool => TABLE_TOOLS.includes(tool)) : [];
      agent.constraints.maxCostPerTask = 0.2;
      agent.capabilities.mcpServers = [];
    }
    const events: Array<{ type: string; args: unknown[] }> = [];
    const handlers: OrchestratorEventHandler = Object.fromEntries([
      'onTaskDecomposition', 'onAgentSpawned', 'onAgentStage', 'onAgentProgress', 'onAgentToolCall',
      'onAgentToolResult', 'onAgentComplete', 'onAgentFailed', 'onGovernanceEvent', 'onSynthesisStart', 'onComplete',
    ].map(type => [type, (...args: unknown[]) => events.push({ type, args: structuredClone(args) })]));
    const task = `仅根据以下给定材料完成办公任务，不联网、不创建文件、不发送消息。\n${test.task}`;
    try {
      const result = await runOrchestrator({ provider, model: config.model, maxTotalCost: Math.min(0.3, limits.maxRecordedCost),
        agentPool: pool, skillsRegistry: new SkillsRegistry(directory), signal: AbortSignal.timeout(180_000) }, task, handlers);
      const automaticChecks = test.checks.map(pattern => ({ pattern: pattern.source, passed: pattern.test(result.output) }));
      if (test.role === 'data') automaticChecks.push(...checkOfficeTable(task, events));
      automaticChecks.push({ pattern: 'no unexpected tool requests', passed: events
        .filter(event => event.type === 'onAgentToolCall')
        .every(event => test.role === 'data' && event.args[0] === 'data-agent' && TABLE_TOOLS.includes(String(event.args[1]))) });
      if (test.maxCharacters) automaticChecks.push({ pattern: `non-whitespace characters <= ${test.maxCharacters}`,
        passed: Array.from(result.output.replace(/\s/g, '')).length <= test.maxCharacters });
      const routed = result.subResults.some(item => item.agentId === `${test.role}-agent`);
      const after = acceptance.snapshot();
      const record = { role: test.role, task, model: config.model, provider: config.name, calls: after.calls - before.calls,
        cost: after.recordedCost - before.recordedCost, acceptance: after, elapsedMs: Date.now() - started, routed, automaticChecks,
        contentReview: 'pending human review; these checks do not prove factual or professional quality', result, events };
      await writeFile(resolve(directory, `${test.role}.json`), JSON.stringify(record, null, 2), 'utf8');
      console.log(JSON.stringify({ role: test.role, success: result.success, routed, checks: automaticChecks,
        cost: record.cost, calls: record.calls, elapsedMs: record.elapsedMs, outputLength: result.output.length }));
      if (!result.success || !routed || automaticChecks.some(check => !check.passed)) process.exitCode = 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const after = acceptance.snapshot();
      await writeFile(resolve(directory, `${test.role}.json`), JSON.stringify({ role: test.role, task, error: message, events,
        calls: after.calls - before.calls, cost: after.recordedCost - before.recordedCost, acceptance: after, elapsedMs: Date.now() - started }, null, 2), 'utf8');
      console.error(JSON.stringify({ role: test.role, error: message })); process.exitCode = 1;
    }
  }
} finally {
  await closeSharedBrowser();
  process.chdir(previousDirectory);
  console.log(JSON.stringify({ directory, totalCalls: acceptance.snapshot().calls, ...acceptance.snapshot(), userWrites: 0 }));
}
