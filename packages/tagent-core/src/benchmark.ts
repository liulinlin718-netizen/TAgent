import type { AgentCard } from './agent-card.js';
import { createHash, randomUUID } from 'node:crypto';
import { reviewAgentRunEvidence, type AgentRunEvidenceReview, type AgentRunEvidenceInput } from './benchmark-evidence.js';

export type BenchmarkDimension =
  | 'research_verification'
  | 'instruction_following'
  | 'tool_use'
  | 'planning_decomposition'
  | 'office_deliverable'
  | 'governance_safety'
  | 'collaboration_handoff';

export type BenchmarkTaskType =
  | 'gold_answer'
  | 'rubric'
  | 'tool_trace'
  | 'browser_task'
  | 'governance_case'
  | 'handoff_case'
  | 'coding_task'
  | 'desktop_task';

export type BenchmarkRunStatus = 'completed' | 'failed';

export interface BenchmarkDimensionInfo {
  id: BenchmarkDimension;
  label: string;
  description: string;
}

export interface BenchmarkTask {
  id: string;
  title: string;
  description: string;
  type: BenchmarkTaskType;
  targetAgentIds?: string[];
  targetRoles?: string[];
  dimensions: Partial<Record<BenchmarkDimension, number>>;
  requiredSkills?: string[];
  requiredTools?: string[];
  requiredCardSignals?: string[];
  expectedPolicies?: string[];
  goldKeywords?: string[];
  enabledByDefault?: boolean;
  experimental?: boolean;
}

export interface BenchmarkSuite {
  id: string;
  name: string;
  version: string;
  description: string;
  references: string[];
  dimensions: BenchmarkDimensionInfo[];
  tasks: BenchmarkTask[];
}

export interface BenchmarkResult {
  taskId: string;
  title: string;
  type: BenchmarkTaskType;
  score: number;
  passed: boolean;
  dimensionScores: Partial<Record<BenchmarkDimension, number>>;
  findings: string[];
  missingCapabilities: string[];
  traceSummary: string[];
  dimensionWeights: Partial<Record<BenchmarkDimension, number>>;
}

export interface BenchmarkRun {
  runId: string;
  suiteId: string;
  suiteVersion: string;
  agentId: string;
  agentName: string;
  status: BenchmarkRunStatus;
  mode: 'static_capability' | 'trace_aware';
  startedAt: number;
  completedAt: number;
  estimatedCost: number;
  sampleCount: number;
  totalScore: number;
  passRate: number;
  dimensionScores: Record<BenchmarkDimension, number>;
  results: BenchmarkResult[];
  weakDimensions: BenchmarkDimension[];
  recommendations: string[];
  configurationFingerprint: string;
  configurationRevision: number;
  evidenceReview?: AgentRunEvidenceReview;
}

export type BenchmarkTraceInput = AgentRunEvidenceInput;

export interface AgentBenchmarkProfile {
  source: 'estimated' | 'benchmark';
  suiteId: string;
  suiteVersion: string;
  totalScore: number;
  passRate: number;
  sampleCount: number;
  dimensionScores: Record<BenchmarkDimension, number>;
  weakDimensions: BenchmarkDimension[];
  recommendations: string[];
  lastRunAt?: number;
  runId?: string;
  mode?: BenchmarkRun['mode'] | 'controlled_office';
}

export const BENCHMARK_DIMENSIONS: BenchmarkDimensionInfo[] = [
  { id: 'research_verification', label: '调研验证', description: '能否获取、核验和标注事实来源。' },
  { id: 'instruction_following', label: '指令遵循', description: '能否遵守用户格式、限制和任务目标。' },
  { id: 'tool_use', label: '工具使用', description: '能否使用合适工具、MCP 或浏览器能力。' },
  { id: 'planning_decomposition', label: '规划拆解', description: '能否把复杂目标拆成可执行步骤。' },
  { id: 'office_deliverable', label: '办公交付', description: '能否生成报告、表格、邮件、计划或汇报。' },
  { id: 'governance_safety', label: '治理安全', description: '能否遵守成本、权限和安全边界。' },
  { id: 'collaboration_handoff', label: '协作交接', description: '能否形成清晰上下文并支持多 Agent 协作。' },
];

const ROLE_WEIGHTS: Record<string, Record<BenchmarkDimension, number>> = {
  'research-agent': {
    research_verification: 0.28,
    instruction_following: 0.12,
    tool_use: 0.18,
    planning_decomposition: 0.1,
    office_deliverable: 0.12,
    governance_safety: 0.12,
    collaboration_handoff: 0.08,
  },
  'document-agent': {
    research_verification: 0.1,
    instruction_following: 0.16,
    tool_use: 0.08,
    planning_decomposition: 0.12,
    office_deliverable: 0.3,
    governance_safety: 0.12,
    collaboration_handoff: 0.12,
  },
  'data-agent': {
    research_verification: 0.13,
    instruction_following: 0.13,
    tool_use: 0.12,
    planning_decomposition: 0.12,
    office_deliverable: 0.18,
    governance_safety: 0.12,
    collaboration_handoff: 0.08,
  },
  'project-agent': {
    research_verification: 0.08,
    instruction_following: 0.14,
    tool_use: 0.08,
    planning_decomposition: 0.28,
    office_deliverable: 0.14,
    governance_safety: 0.14,
    collaboration_handoff: 0.14,
  },
  'communication-agent': {
    research_verification: 0.08,
    instruction_following: 0.2,
    tool_use: 0.06,
    planning_decomposition: 0.1,
    office_deliverable: 0.24,
    governance_safety: 0.12,
    collaboration_handoff: 0.2,
  },
  'presentation-agent': {
    research_verification: 0.12,
    instruction_following: 0.14,
    tool_use: 0.08,
    planning_decomposition: 0.14,
    office_deliverable: 0.26,
    governance_safety: 0.1,
    collaboration_handoff: 0.16,
  },
  default: {
    research_verification: 0.15,
    instruction_following: 0.15,
    tool_use: 0.15,
    planning_decomposition: 0.15,
    office_deliverable: 0.15,
    governance_safety: 0.15,
    collaboration_handoff: 0.1,
  },
};

export const TAGENT_UNIVERSAL_BENCHMARK: BenchmarkSuite = {
  id: 'tagent-universal-v1',
  name: 'TAgent Universal Benchmark',
  version: '1.1.0',
  description: '办公 Agent 配置检查：只核对声明、结构和权限，不代表真实任务通过率或外部金标准成绩。已保存任务可单独复核运行证据，不新增模型、联网或工具调用。',
  references: [
    'GAIA: general AI assistant tasks with browsing/tool requirements',
    'tau-bench: tool-agent-user rule following and tool usage',
    'WebArena/OSWorld: realistic browser and computer-use task framing',
    'IFEval: instruction-following verifiability',
    'GDPval: economically valuable office deliverables',
  ],
  dimensions: BENCHMARK_DIMENSIONS,
  tasks: [
    {
      id: 'universal-brief-001',
      title: '任务澄清与输出契约',
      description: '检查 Agent 是否具备把任务整理为目标、输入、输出和约束的能力。',
      type: 'rubric',
      dimensions: { instruction_following: 0.45, planning_decomposition: 0.25, office_deliverable: 0.2, collaboration_handoff: 0.1 },
      requiredSkills: ['task-briefing', 'structured-output'],
      requiredCardSignals: ['目标', '输出', '假设', '结构'],
      enabledByDefault: true,
    },
    {
      id: 'universal-quality-001',
      title: '最终交付质量复核',
      description: '检查 Agent 是否具备交付前质量检查和结构化输出标准。',
      type: 'rubric',
      dimensions: { office_deliverable: 0.35, instruction_following: 0.25, governance_safety: 0.2, collaboration_handoff: 0.2 },
      requiredSkills: ['quality-review', 'structured-output'],
      requiredCardSignals: ['质量', '事实', '判断', '下一步'],
      enabledByDefault: true,
    },
    {
      id: 'universal-governance-001',
      title: '高风险操作边界',
      description: '检查 Agent 是否有风险边界、工具白名单和失败降级策略。',
      type: 'governance_case',
      dimensions: { governance_safety: 0.55, instruction_following: 0.2, tool_use: 0.15, planning_decomposition: 0.1 },
      requiredSkills: ['risk-boundary-check'],
      expectedPolicies: ['allowedTools', 'approvalMode', 'fallbackStrategy'],
      requiredCardSignals: ['风险', '边界', '降级', '确认'],
      enabledByDefault: true,
    },
    {
      id: 'universal-handoff-001',
      title: '跨 Agent 交接摘要',
      description: '检查 Agent 是否能为其他 Agent 交接事实、推断、风险和待补充信息。',
      type: 'handoff_case',
      dimensions: { collaboration_handoff: 0.55, planning_decomposition: 0.2, office_deliverable: 0.15, instruction_following: 0.1 },
      requiredSkills: ['handoff-summary'],
      requiredCardSignals: ['交接', '事实', '推断', '风险'],
      enabledByDefault: true,
    },
    {
      id: 'universal-tool-001',
      title: '工具白名单一致性',
      description: '检查 Agent 声明工具和治理白名单是否一致。',
      type: 'tool_trace',
      dimensions: { tool_use: 0.55, governance_safety: 0.3, instruction_following: 0.15 },
      expectedPolicies: ['allowedTools'],
      enabledByDefault: true,
    },
    {
      id: 'research-freshness-001',
      title: '近 30 天调研',
      description: '检查研究类 Agent 是否具备实时检索、来源日期和旧来源降级能力。',
      type: 'browser_task',
      targetAgentIds: ['research-agent'],
      dimensions: { research_verification: 0.5, tool_use: 0.25, governance_safety: 0.15, office_deliverable: 0.1 },
      requiredSkills: ['web-research', 'last-30-days-research', 'source-verification'],
      requiredTools: ['web_research', 'read_url', 'browser_navigate'],
      requiredCardSignals: ['调研日期', '来源日期', 'URL', '近 30 天'],
      enabledByDefault: true,
    },
    {
      id: 'research-source-001',
      title: '来源可信度核验',
      description: '检查 Agent 是否能区分一手来源、二手报道、社区讨论和推断。',
      type: 'gold_answer',
      targetAgentIds: ['research-agent', 'data-agent', 'presentation-agent'],
      dimensions: { research_verification: 0.55, instruction_following: 0.15, office_deliverable: 0.15, governance_safety: 0.15 },
      requiredSkills: ['source-verification'],
      requiredCardSignals: ['来源', '日期', '不确定', '验证'],
      goldKeywords: ['来源', '日期', '不确定性'],
      enabledByDefault: true,
    },
    {
      id: 'document-report-001',
      title: '管理层报告生成',
      description: '检查文档类 Agent 是否具备摘要、结构、证据和行动建议能力。',
      type: 'rubric',
      targetAgentIds: ['document-agent'],
      dimensions: { office_deliverable: 0.5, instruction_following: 0.2, research_verification: 0.15, collaboration_handoff: 0.15 },
      requiredSkills: ['document-structure', 'content-editing', 'report-generation'],
      requiredCardSignals: ['摘要', '标题', '行动项', '证据'],
      enabledByDefault: true,
    },
    {
      id: 'data-metric-001',
      title: '指标口径与异常分析',
      description: '检查数据 Agent 是否能说明口径、趋势、异常和业务含义。',
      type: 'rubric',
      targetAgentIds: ['data-agent'],
      dimensions: { office_deliverable: 0.25, instruction_following: 0.15, planning_decomposition: 0.15, research_verification: 0.25, governance_safety: 0.2 },
      requiredSkills: ['data-analysis', 'metric-review', 'trend-insight'],
      requiredCardSignals: ['口径', '趋势', '异常', '行动'],
      enabledByDefault: true,
    },
    {
      id: 'project-plan-001',
      title: '项目计划与验收标准',
      description: '检查项目 Agent 是否能输出里程碑、依赖、风险和验收标准。',
      type: 'rubric',
      targetAgentIds: ['project-agent'],
      dimensions: { planning_decomposition: 0.5, office_deliverable: 0.2, governance_safety: 0.15, collaboration_handoff: 0.15 },
      requiredSkills: ['task-breakdown', 'project-planning', 'risk-tracking'],
      requiredCardSignals: ['里程碑', '依赖', '风险', '验收'],
      enabledByDefault: true,
    },
    {
      id: 'communication-email-001',
      title: '可发送商务沟通',
      description: '检查沟通 Agent 是否能识别受众、目的、语气和下一步。',
      type: 'rubric',
      targetAgentIds: ['communication-agent'],
      dimensions: { office_deliverable: 0.35, instruction_following: 0.25, collaboration_handoff: 0.25, governance_safety: 0.15 },
      requiredSkills: ['stakeholder-communication', 'email-writing', 'meeting-notes'],
      requiredCardSignals: ['受众', '目的', '语气', '下一步'],
      enabledByDefault: true,
    },
    {
      id: 'presentation-outline-001',
      title: '页面级汇报大纲',
      description: '检查汇报 Agent 是否能生成主线、页标题、证据和行动建议。',
      type: 'rubric',
      targetAgentIds: ['presentation-agent'],
      dimensions: { office_deliverable: 0.38, instruction_following: 0.18, planning_decomposition: 0.18, collaboration_handoff: 0.16, research_verification: 0.1 },
      requiredSkills: ['storytelling', 'presentation-outline', 'executive-summary'],
      requiredCardSignals: ['主线', '页', '观点', '建议'],
      enabledByDefault: true,
    },
    {
      id: 'experimental-coding-001',
      title: '实验性 Coding Agent 能力',
      description: '保留 coding 题型 schema，默认不启用，等待安全 runtime 完善。',
      type: 'coding_task',
      dimensions: { tool_use: 0.35, planning_decomposition: 0.25, governance_safety: 0.25, instruction_following: 0.15 },
      requiredTools: ['sandbox_exec'],
      experimental: true,
      enabledByDefault: false,
    },
    {
      id: 'experimental-desktop-001',
      title: '实验性桌面自动化能力',
      description: '保留桌面操作题型 schema，默认不启用。',
      type: 'desktop_task',
      dimensions: { tool_use: 0.45, governance_safety: 0.25, instruction_following: 0.2, office_deliverable: 0.1 },
      requiredTools: ['desktop_control'],
      experimental: true,
      enabledByDefault: false,
    },
  ],
};

export function getBenchmarkSuites(): BenchmarkSuite[] {
  return [TAGENT_UNIVERSAL_BENCHMARK];
}

export function estimateAgentBenchmarkProfile(agent: AgentCard): AgentBenchmarkProfile {
  const tasks = selectTasksForAgent(agent, TAGENT_UNIVERSAL_BENCHMARK);
  const results = tasks.map(task => scoreTask(agent, task));
  const dimensionScores = aggregateDimensionScores(results);
  const totalScore = weightedTotal(agent, dimensionScores);
  const weakDimensions = findWeakDimensions(dimensionScores);

  return {
    source: 'estimated',
    suiteId: TAGENT_UNIVERSAL_BENCHMARK.id,
    suiteVersion: TAGENT_UNIVERSAL_BENCHMARK.version,
    totalScore,
    passRate: ratio(results.filter(result => result.passed).length, results.length),
    sampleCount: results.length,
    dimensionScores,
    weakDimensions,
    recommendations: buildRecommendations(agent, weakDimensions, results),
  };
}

export function runAgentBenchmark(
  agent: AgentCard,
  suite = TAGENT_UNIVERSAL_BENCHMARK,
  traceInput?: BenchmarkTraceInput,
): BenchmarkRun {
  const startedAt = Date.now();
  const tasks = selectTasksForAgent(agent, suite);
  const results = tasks.map(task => scoreTask(agent, task));
  const dimensionScores = aggregateDimensionScores(results);
  const weakDimensions = findWeakDimensions(dimensionScores);

  return {
    runId: `bench-${randomUUID()}`,
    suiteId: suite.id,
    suiteVersion: suite.version,
    agentId: agent.id,
    agentName: agent.name,
    status: 'completed',
    mode: traceInput ? 'trace_aware' : 'static_capability',
    startedAt,
    completedAt: Date.now(),
    estimatedCost: 0,
    sampleCount: results.length,
    totalScore: weightedTotal(agent, dimensionScores),
    passRate: ratio(results.filter(result => result.passed).length, results.length),
    dimensionScores,
    results,
    weakDimensions,
    recommendations: buildRecommendations(agent, weakDimensions, results),
    configurationFingerprint: fingerprintAgentConfiguration(agent),
    configurationRevision: agent.configurationRevision || 0,
    ...(traceInput ? { evidenceReview: reviewAgentRunEvidence(agent.id, traceInput) } : {}),
  };
}

export function profileFromBenchmarkRun(run: BenchmarkRun): AgentBenchmarkProfile {
  return {
    source: 'estimated',
    mode: run.mode,
    suiteId: run.suiteId,
    suiteVersion: run.suiteVersion,
    totalScore: run.totalScore,
    passRate: run.passRate,
    sampleCount: run.sampleCount,
    dimensionScores: run.dimensionScores,
    weakDimensions: run.weakDimensions,
    recommendations: run.recommendations,
    lastRunAt: run.completedAt,
    runId: run.runId,
  };
}

function selectTasksForAgent(agent: AgentCard, suite: BenchmarkSuite): BenchmarkTask[] {
  const role = roleFromAgent(agent);
  return suite.tasks.filter(task => {
    if (task.experimental || task.enabledByDefault === false) return false;
    if (task.targetAgentIds?.length) return task.targetAgentIds.includes(agent.id) || task.targetAgentIds.includes(`${role}-agent`);
    if (task.targetRoles?.length) return task.targetRoles.includes(role);
    return true;
  });
}

function scoreTask(agent: AgentCard, task: BenchmarkTask): BenchmarkResult {
  const findings: string[] = [];
  const missingCapabilities: string[] = [];
  const traceSummary: string[] = [];
  let earned = 0, possible = 0;
  const add = (score: number, weight: number) => { earned += score * weight; possible += weight; };

  const skillScore = coverage(task.requiredSkills || [], agent.capabilities.skills);
  if (task.requiredSkills?.length) add(skillScore, 24);
  if (task.requiredSkills?.length) {
    traceSummary.push(`Skills 覆盖率 ${(skillScore * 100).toFixed(0)}%`);
    missingCapabilities.push(...task.requiredSkills.filter(skill => !agent.capabilities.skills.includes(skill)));
  }

  const availableTools = new Set(agent.capabilities.tools.filter(tool => agent.constraints.allowedTools.includes(tool)));
  const toolScore = coverage(task.requiredTools || [], Array.from(availableTools));
  if (task.requiredTools?.length) add(toolScore, 18);
  if (task.id === 'universal-tool-001') {
    const denied = agent.capabilities.tools.filter(tool => !availableTools.has(tool));
    add(coverage(agent.capabilities.tools, [...availableTools]), 24);
    missingCapabilities.push(...denied.map(tool => `工具权限不一致：${tool}`));
    traceSummary.push(`声明工具与白名单一致：${denied.length ? '否' : '是'}（未验证工具连接）`);
  }
  if (task.requiredTools?.length) {
    traceSummary.push(`工具覆盖率 ${(toolScore * 100).toFixed(0)}%`);
    missingCapabilities.push(...task.requiredTools.filter(tool => !availableTools.has(tool)));
  }

  const policyScore = scorePolicies(agent, task.expectedPolicies || []);
  if (task.expectedPolicies?.length) add(policyScore, 14);
  if (task.expectedPolicies?.length) traceSummary.push(`治理配置 ${(policyScore * 100).toFixed(0)}%`);

  const textScore = scoreCardSignals(agent, task.requiredCardSignals || []);
  if (task.requiredCardSignals?.length) add(textScore, 22);
  if (task.requiredCardSignals?.length) traceSummary.push(`Agent Card 信号 ${(textScore * 100).toFixed(0)}%`);

  const structureScore = scoreAgentStructure(agent);
  add(structureScore, 10);
  const score = clamp(earned / possible * 100);
  if (missingCapabilities.length) findings.push(`缺少能力: ${Array.from(new Set(missingCapabilities)).join(', ')}`);
  if (score >= 82) findings.push('主要配置检查通过；尚未执行此基准任务。');
  if (score < 70) findings.push('建议补齐相关 Skill、工具白名单或质量检查规则。');

  return {
    taskId: task.id,
    title: task.title,
    type: task.type,
    score,
    passed: score >= 70,
    dimensionScores: scaleDimensions(task.dimensions, score),
    findings,
    missingCapabilities: Array.from(new Set(missingCapabilities)),
    traceSummary,
    dimensionWeights: { ...task.dimensions },
  };
}

function aggregateDimensionScores(results: BenchmarkResult[]): Record<BenchmarkDimension, number> {
  const totals = Object.fromEntries(BENCHMARK_DIMENSIONS.map(dimension => [dimension.id, 0])) as Record<BenchmarkDimension, number>;
  const weights = Object.fromEntries(BENCHMARK_DIMENSIONS.map(dimension => [dimension.id, 0])) as Record<BenchmarkDimension, number>;

  for (const result of results) {
    for (const dimension of BENCHMARK_DIMENSIONS) {
      const score = result.dimensionScores[dimension.id];
      if (score === undefined) continue;
      const weight = result.dimensionWeights[dimension.id] || 0;
      totals[dimension.id] += score * weight;
      weights[dimension.id] += weight;
    }
  }

  for (const dimension of BENCHMARK_DIMENSIONS) {
    totals[dimension.id] = weights[dimension.id] ? clamp(totals[dimension.id] / weights[dimension.id]) : 0;
  }

  return totals;
}

export function weightedTotal(agent: AgentCard, dimensions: Record<BenchmarkDimension, number>): number {
  const weights = ROLE_WEIGHTS[`${roleFromAgent(agent)}-agent`] || ROLE_WEIGHTS.default;
  const denominator = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  return clamp(Object.entries(weights).reduce((sum, [dimension, weight]) =>
    sum + dimensions[dimension as BenchmarkDimension] * weight, 0) / denominator);
}

function scaleDimensions(weights: Partial<Record<BenchmarkDimension, number>>, score: number): Partial<Record<BenchmarkDimension, number>> {
  const output: Partial<Record<BenchmarkDimension, number>> = {};
  for (const dimension of Object.keys(weights) as BenchmarkDimension[]) output[dimension] = score;
  return output;
}

function scorePolicies(agent: AgentCard, policies: string[]): number {
  if (!policies.length) return 1;
  let matched = 0;
  for (const policy of policies) {
    if (policy === 'allowedTools' && Array.isArray(agent.constraints.allowedTools)) matched++;
    if (policy === 'approvalMode' && agent.constraints.approvalMode) matched++;
    if (policy === 'fallbackStrategy' && agent.card.fallbackStrategy?.trim()) matched++;
  }
  return ratio(matched, policies.length);
}

function scoreCardSignals(agent: AgentCard, signals: string[]): number {
  if (!signals.length) return 1;
  const text = [
    agent.name,
    agent.description,
    agent.card.soul,
    agent.card.fallbackStrategy,
    ...agent.card.responsibilities,
    ...agent.card.boundaries,
    ...agent.card.qualityChecks,
    ...agent.card.outputStandards,
    ...agent.card.exampleTasks,
  ].join('\n').toLowerCase();
  return ratio(signals.filter(signal => text.includes(signal.toLowerCase())).length, signals.length);
}

function scoreAgentStructure(agent: AgentCard): number {
  const checks = [
    Boolean(agent.card.soul?.trim()),
    agent.card.responsibilities.length > 0,
    agent.card.boundaries.length > 0,
    agent.card.qualityChecks.length > 0,
    agent.card.outputStandards.length > 0,
    Boolean(agent.card.fallbackStrategy?.trim()),
  ];
  return ratio(checks.filter(Boolean).length, checks.length);
}

function coverage(required: string[], actual: string[]): number {
  if (!required.length) return 1;
  const actualSet = new Set(actual);
  return ratio(required.filter(item => actualSet.has(item)).length, required.length);
}

function findWeakDimensions(dimensions: Record<BenchmarkDimension, number>): BenchmarkDimension[] {
  return BENCHMARK_DIMENSIONS
    .map(dimension => dimension.id)
    .filter(dimension => dimensions[dimension] < 72)
    .sort((a, b) => dimensions[a] - dimensions[b])
    .slice(0, 3);
}

function buildRecommendations(agent: AgentCard, weakDimensions: BenchmarkDimension[], results: BenchmarkResult[]): string[] {
  const missing = Array.from(new Set(results.flatMap(result => result.missingCapabilities))).slice(0, 5);
  const recommendations = missing.map(item => `补齐能力或工具：${item}`);

  for (const dimension of weakDimensions) {
    if (dimension === 'research_verification') recommendations.push('补充来源验证、日期标注和近 30 天检索 Skill。');
    if (dimension === 'instruction_following') recommendations.push('增加任务澄清和格式约束检查。');
    if (dimension === 'tool_use') recommendations.push('检查工具白名单和 MCP/浏览器工具绑定是否一致。');
    if (dimension === 'planning_decomposition') recommendations.push('补充任务拆解、里程碑和验收标准。');
    if (dimension === 'office_deliverable') recommendations.push('补充输出模板、报告结构或交付质量规则。');
    if (dimension === 'governance_safety') recommendations.push('补充风险边界、降级策略和审批模式。');
    if (dimension === 'collaboration_handoff') recommendations.push('补充跨 Agent 交接摘要和上下文传递规则。');
  }

  if (!agent.card.qualityChecks.length) recommendations.push('为 Agent Card 添加质量检查规则。');
  return Array.from(new Set(recommendations)).slice(0, 6);
}

export function roleFromAgent(agent: AgentCard): string {
  if (ROLE_WEIGHTS[agent.id]) return agent.id.replace(/-agent$/, '');
  const domains = agent.card.capabilityGraph.domains;
  for (const [domain, role] of Object.entries({ research: 'research', writing: 'document', 'data-analysis': 'data',
    'project-management': 'project', communication: 'communication', presentation: 'presentation' })) {
    if (domains.includes(domain)) return role;
  }
  return 'default';
}

export function fingerprintAgentConfiguration(agent: AgentCard): string {
  const { scoreProfile: _score, ...card } = agent.card;
  return createHash('sha256').update(JSON.stringify({ id: agent.id, name: agent.name, description: agent.description,
    capabilities: agent.capabilities, constraints: agent.constraints, card })).digest('hex');
}

function ratio(value: number, total: number): number {
  return total > 0 ? value / total : 1;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
