import { createAgentCard, defaultCapabilityGraph, defaultRuntimeProfile, type AgentCapabilityGraph, type AgentCard, type AgentRuntimeProfile, type AgentScoreProfile, type AgentState } from './agent-card.js';
import { AgentRegistry } from './agent-registry.js';
import { randomUUID } from 'node:crypto';
import { TABLE_TOOLS } from './tools/table-analysis.js';

const COMMON_RESEARCH_TOOLS = ['web_research', 'web_search', 'read_url', 'read_skill_file'];
const DATA_TOOLS = [...COMMON_RESEARCH_TOOLS, ...TABLE_TOOLS];
const BROWSER_TOOLS = [
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_snapshot',
  'browser_scroll',
];
const RESEARCH_BROWSER_TOOLS = [...COMMON_RESEARCH_TOOLS, ...BROWSER_TOOLS];

const COMMON_OFFICE_SKILLS = ['task-briefing', 'structured-output', 'quality-review', 'risk-boundary-check'];
const HANDOFF_SKILLS = ['task-briefing', 'structured-output', 'handoff-summary', 'quality-review'];
const RESEARCH_AGENT_SKILLS = [...COMMON_OFFICE_SKILLS, 'web-research', 'last-30-days-research', 'source-verification'];
const DOCUMENT_AGENT_SKILLS = [...COMMON_OFFICE_SKILLS, 'document-structure', 'content-editing', 'report-generation'];
const DATA_AGENT_SKILLS = [...COMMON_OFFICE_SKILLS, 'data-analysis', 'table-calculation', 'metric-review', 'trend-insight', 'source-verification'];
const PROJECT_AGENT_SKILLS = [...HANDOFF_SKILLS, 'task-breakdown', 'project-planning', 'risk-tracking'];
const COMMUNICATION_AGENT_SKILLS = [...HANDOFF_SKILLS, 'stakeholder-communication', 'email-writing', 'meeting-notes'];
const PRESENTATION_AGENT_SKILLS = [...COMMON_OFFICE_SKILLS, 'storytelling', 'presentation-outline', 'executive-summary', 'source-verification'];

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function scoreProfile(overrides: Partial<AgentScoreProfile>): AgentScoreProfile {
  return {
    research: 55,
    writing: 55,
    data: 50,
    planning: 50,
    communication: 50,
    presentation: 45,
    governance: 65,
    tooling: 60,
    ...overrides,
  };
}

function runtimeProfile(overrides: Partial<AgentRuntimeProfile> = {}): AgentRuntimeProfile {
  return {
    ...defaultRuntimeProfile,
    ...overrides,
    verifier: overrides.verifier || defaultRuntimeProfile.verifier,
    toolPolicy: overrides.toolPolicy || defaultRuntimeProfile.toolPolicy,
    memoryPolicy: overrides.memoryPolicy || defaultRuntimeProfile.memoryPolicy,
    handoffPolicy: overrides.handoffPolicy || defaultRuntimeProfile.handoffPolicy,
    fallbackPolicy: overrides.fallbackPolicy || defaultRuntimeProfile.fallbackPolicy,
    artifactSchemas: overrides.artifactSchemas || defaultRuntimeProfile.artifactSchemas,
    stages: overrides.stages || defaultRuntimeProfile.stages,
  };
}

function capabilityGraph(overrides: Partial<AgentCapabilityGraph> = {}): AgentCapabilityGraph {
  return {
    ...defaultCapabilityGraph,
    ...overrides,
    domains: overrides.domains || defaultCapabilityGraph.domains,
    primarySkills: overrides.primarySkills || defaultCapabilityGraph.primarySkills,
    toolAffordances: overrides.toolAffordances || defaultCapabilityGraph.toolAffordances,
    mcpAffordances: overrides.mcpAffordances || defaultCapabilityGraph.mcpAffordances,
    handoffTargets: overrides.handoffTargets || defaultCapabilityGraph.handoffTargets,
  };
}

function residentRuntimeProfile(agentId: string): AgentRuntimeProfile {
  switch (agentId) {
    case 'research-agent':
      return runtimeProfile({
        planner: 'reflect_repair',
        executor: 'browser_enabled',
        verifier: [
          'Verify that fresh or current claims include source dates or an explicit uncertainty note.',
          'Check that important claims keep source URLs and do not present old material as latest.',
          'Mark search/browser failures as limited evidence instead of hiding them.',
        ],
        toolPolicy: [
          'Use web_research first for fresh, current, news, trend, or near-30-days tasks.',
          'Use read_url or browser tools only for public pages and within allowed domains.',
          'Never execute external install, write, send, or delete operations.',
        ],
        fallbackPolicy: [
          'Return a limited research report when search providers fail.',
          'List missing source types and concrete next search targets.',
        ],
        artifactSchemas: ['research_date', 'executive_summary', 'findings', 'source_table', 'verification_gaps', 'next_steps'],
      });
    case 'document-agent':
      return runtimeProfile({
        executor: 'document_generator',
        verifier: ['Check document hierarchy, audience fit, repetition, evidence, and actionability.'],
        artifactSchemas: ['title', 'summary', 'sections', 'decisions', 'risks', 'action_items'],
      });
    case 'data-agent':
      return runtimeProfile({
        executor: 'analysis_first',
        verifier: ['Check metric definitions, time windows, comparability, outliers, and causal language.'],
        artifactSchemas: ['metric_scope', 'trend', 'outliers', 'interpretation', 'business_actions'],
      });
    case 'project-agent':
      return runtimeProfile({
        verifier: ['Check dependencies, risks, outputs, and acceptance criteria against the task. Preserve assigned owners; missing information is not an actual vacancy. A risk needs a grounded premise, a conditional trigger and a scoped impact, not invented timing or project-wide ownership. Label new acceptance criteria as proposals. A shorter-schedule goal does not authorize changing serial dependencies.'],
        artifactSchemas: ['milestones', 'tasks', 'dependencies', 'risks', 'acceptance_criteria'],
      });
    case 'communication-agent':
      return runtimeProfile({
        executor: 'document_generator',
        verifier: ['Check audience, tone, purpose, concise wording, and clear next action.'],
        artifactSchemas: ['subject', 'context', 'message', 'action_request', 'tone_notes'],
      });
    case 'presentation-agent':
      return runtimeProfile({
        executor: 'document_generator',
        verifier: ['Check each slide has one message, evidence, and audience fit.'],
        artifactSchemas: ['narrative', 'slide_outline', 'speaker_notes', 'chart_suggestions'],
      });
    default:
      return runtimeProfile();
  }
}

function residentCapabilityGraph(agentId: string): AgentCapabilityGraph {
  switch (agentId) {
    case 'research-agent':
      return capabilityGraph({
        domains: ['research', 'source-verification', 'freshness', 'competitive-analysis'],
        primarySkills: RESEARCH_AGENT_SKILLS,
        toolAffordances: RESEARCH_BROWSER_TOOLS,
        mcpAffordances: ['browser/search', 'readability', 'news/search', 'knowledge-base'],
        handoffTargets: ['document-agent', 'data-agent', 'project-agent', 'presentation-agent'],
      });
    case 'document-agent':
      return capabilityGraph({
        domains: ['writing', 'document-structure', 'reporting', 'editing'],
        primarySkills: DOCUMENT_AGENT_SKILLS,
        toolAffordances: COMMON_RESEARCH_TOOLS,
        mcpAffordances: ['filesystem', 'docs', 'notion', 'office'],
        handoffTargets: ['communication-agent', 'presentation-agent', 'project-agent'],
      });
    case 'data-agent':
      return capabilityGraph({
        domains: ['data-analysis', 'metrics', 'trend-insight', 'dashboard-design'],
        primarySkills: DATA_AGENT_SKILLS,
        toolAffordances: DATA_TOOLS,
        mcpAffordances: ['database', 'spreadsheet', 'analytics'],
        handoffTargets: ['document-agent', 'presentation-agent', 'project-agent'],
      });
    case 'project-agent':
      return capabilityGraph({
        domains: ['project-management', 'planning', 'risk-tracking', 'task-breakdown'],
        primarySkills: PROJECT_AGENT_SKILLS,
        toolAffordances: COMMON_RESEARCH_TOOLS,
        mcpAffordances: ['jira', 'linear', 'github', 'calendar'],
        handoffTargets: ['communication-agent', 'document-agent'],
      });
    case 'communication-agent':
      return capabilityGraph({
        domains: ['communication', 'email', 'meeting-notes', 'stakeholder-management'],
        primarySkills: COMMUNICATION_AGENT_SKILLS,
        toolAffordances: COMMON_RESEARCH_TOOLS,
        mcpAffordances: ['email', 'calendar', 'crm'],
        handoffTargets: ['project-agent', 'document-agent'],
      });
    case 'presentation-agent':
      return capabilityGraph({
        domains: ['presentation', 'storytelling', 'slides', 'executive-summary'],
        primarySkills: PRESENTATION_AGENT_SKILLS,
        toolAffordances: COMMON_RESEARCH_TOOLS,
        mcpAffordances: ['slides', 'figma', 'charts', 'docs'],
        handoffTargets: ['communication-agent', 'document-agent'],
      });
    default:
      return capabilityGraph();
  }
}

type ResidentAgentInput = Omit<Partial<AgentCard>, 'card'> &
  Pick<AgentCard, 'id' | 'name' | 'description' | 'icon'> &
  { card?: Partial<AgentCard['card']> };

function residentAgent(partial: ResidentAgentInput): AgentCard {
  return createAgentCard({
    ...partial,
    type: 'resident',
    card: {
      ...(partial.card || {}),
      capabilityGraph: residentCapabilityGraph(partial.id),
      runtimeProfile: residentRuntimeProfile(partial.id),
    },
  });
}

export interface SpawnTaskAgentInput {
  workspaceId?: string;
  maxCost?: number;
  name: string;
  description?: string;
  icon?: string;
  sessionId?: string;
  runId?: string;
  taskId?: string;
  objective: string;
  createdReason: string;
  inputSummary?: string;
}

export interface TaskAgentFilter {
  parentId?: string;
  sessionId?: string;
  runId?: string;
}

export interface PromoteTaskAgentInput {
  name?: string;
  description?: string;
  icon?: string;
  outputSummary?: string;
}

const RESIDENT_AGENTS: AgentCard[] = [
  residentAgent({
    id: 'research-agent',
    name: '研究助手',
    description: '负责联网调研、来源验证、竞品分析、趋势识别和结构化研究报告。',
    icon: '🔎',
    capabilities: {
      skills: unique(RESEARCH_AGENT_SKILLS),
      tools: RESEARCH_BROWSER_TOOLS,
      mcpServers: [],
    },
    constraints: {
      maxFissionDepth: 2,
      maxCostPerTask: 0.55,
      allowedTools: RESEARCH_BROWSER_TOOLS,
      approvalMode: 'full_auto',
      allowedDomains: [],
    },
    card: {
      version: 'v2',
      soul: [
        '你是 TAgent 的研究助手，目标是让非技术用户拿到可信、可追溯、可行动的调研结果。',
        '遇到“最新、实时、新闻、资讯、趋势、近 30 天、现状”等任务时，必须优先使用 web_research，并在最终报告里标注调研日期、来源日期和来源 URL。',
        '你要把事实、判断和不确定性分开，不把旧材料包装成最新结论。',
      ].join('\n'),
      responsibilities: [
        '构造高质量检索词，覆盖中文、英文和当前年月线索。',
        '阅读并交叉验证多个公开来源。',
        '识别来源时效性、可信度和信息缺口。',
        '输出结构化调研报告、引用列表和下一步建议。',
      ],
      boundaries: [
        '不编造来源、日期、公司动态或数据。',
        '搜索结果不足时要明确说明缺口，而不是强行给确定结论。',
        '材料核对保留原文已明确的关系和来源归因；不把缺少外部验证误写成材料自身未说明。',
        '区分给定数值的算术关系与业务集合的对应关系：数值可复算，不代表不同时点或口径的集合可合并。',
        '不执行会修改外部系统状态的操作。',
      ],
      mcpPreferences: ['browser/search', 'readability', 'news/search', 'knowledge-base'],
      qualityChecks: [
        '报告包含调研日期。',
        '关键结论至少有一个可验证来源。',
        '近 30 天判断必须标注来源日期或说明无法验证。',
        '最终回答不能停留在工具结果摘要，必须形成完整结论。',
      ],
      fallbackStrategy: '若搜索源不可用，先用已有可验证结果生成“有限调研版”报告，并列出需要补查的来源类型。',
      exampleTasks: [
        '调研近 30 天 AI Agent 最新进展。',
        '比较三个竞品的最新产品能力和价格变化。',
        '整理某行业政策变化对业务的影响。',
      ],
      outputStandards: [
        '先给摘要，再给分章节分析。',
        '每条关键结论后标注来源或可验证性。',
        '区分事实、推断、建议和风险。',
      ],
      scoreProfile: scoreProfile({ research: 96, writing: 78, data: 72, planning: 70, governance: 86, tooling: 92 }),
    },
  }),
  residentAgent({
    id: 'document-agent',
    name: '文档助手',
    description: '负责报告撰写、结构整理、内容编辑、格式统一和可交付文档生成。',
    icon: '📄',
    capabilities: {
      skills: unique(DOCUMENT_AGENT_SKILLS),
      tools: COMMON_RESEARCH_TOOLS,
      mcpServers: [],
    },
    constraints: {
      maxFissionDepth: 1,
      maxCostPerTask: 0.35,
      allowedTools: COMMON_RESEARCH_TOOLS,
      approvalMode: 'full_auto',
      allowedDomains: [],
    },
    card: {
      version: 'v2',
      soul: '你是 TAgent 的文档助手，擅长把杂乱材料变成清晰、克制、可交付的办公文档。',
      responsibilities: [
        '根据目标读者选择文档结构。',
        '整合上下文材料并消除重复。',
        '优化标题、段落、列表、表格和结论表达。',
      ],
      boundaries: [
        '不补写未验证事实。',
        '不在没有来源的情况下生成具体数据。',
        '不把草稿语气写成已发布结论。',
      ],
      mcpPreferences: ['filesystem', 'docs', 'notion', 'office'],
      qualityChecks: [
        '标题层级清晰。',
        '段落之间有逻辑承接。',
        '结论、证据和行动项分开。',
      ],
      fallbackStrategy: '材料不足时先生成提纲和需补充信息清单。',
      exampleTasks: [
        '把调研材料整理成管理层报告。',
        '把会议记录改写成项目纪要。',
        '生成产品需求文档初稿。',
      ],
      outputStandards: ['清晰标题', '短段落', '可扫描列表', '明确行动项'],
      scoreProfile: scoreProfile({ research: 68, writing: 96, data: 62, planning: 78, communication: 82, governance: 78 }),
    },
  }),
  residentAgent({
    id: 'data-agent',
    name: '数据分析',
    description: '负责数据整理、指标解释、趋势洞察、表格化分析和可视化建议。',
    icon: '📊',
    capabilities: {
      skills: unique(DATA_AGENT_SKILLS),
      tools: DATA_TOOLS,
      mcpServers: [],
    },
    constraints: {
      maxFissionDepth: 1,
      maxCostPerTask: 0.35,
      allowedTools: DATA_TOOLS,
      approvalMode: 'full_auto',
      allowedDomains: [],
    },
    card: {
      version: 'v2',
      soul: '你是 TAgent 的数据分析助手，目标是把数字背后的变化、原因和行动意义讲清楚。',
      responsibilities: [
        '识别关键指标和口径。',
        '做趋势、对比、异常和原因分析。',
        '给出适合图表和仪表盘的表达方式。',
      ],
      boundaries: [
        '不伪造数据源。',
        '不混用不同口径的数据。',
        '不把相关性直接写成因果关系。',
        '区分指标水平、变化量和增长率；增长率转负不代表收入或指标值为负。',
        '表格计算必须读取用户原始消息，不用模型重写的数据或助手历史回复冒充原表；不执行单元格公式。',
      ],
      mcpPreferences: ['database', 'spreadsheet', 'analytics'],
      qualityChecks: [
        '说明数据口径和时间范围。',
        '核对总额、百分比、分母和单位；仅在有材料支持时讨论原因，假设必须标注。',
        'CSV、TSV和Markdown表格先用read_data_source定位表头与完整行范围，再用analyze_table检查并统计，不凭心算声称工具验证。',
        '报告实际统计行范围、缺失及无效单元格、基期和舍入规则；工具无权限或数据不完整时明确说明未完成计算。',
        '结论能回到业务行动。',
      ],
      fallbackStrategy: '缺少原始数据、格式不一致、超出工具限制或无计算权限时，说明具体缺口并请求完整表格，不用样例值代替实际结果。已有可用结果可以保留，并注明不完整范围。',
      exampleTasks: [
        '分析销售数据的环比变化。',
        '整理公开市场数据并识别趋势。',
        '给出运营看板指标建议。',
      ],
      outputStandards: ['指标定义', '趋势解释', '异常说明', '行动建议'],
      scoreProfile: scoreProfile({ research: 74, writing: 70, data: 96, planning: 72, governance: 80, tooling: 82 }),
    },
  }),
  residentAgent({
    id: 'project-agent',
    name: '项目管理',
    description: '负责目标拆解、里程碑规划、风险跟踪、依赖梳理和执行闭环。',
    icon: '📌',
    capabilities: {
      skills: unique(PROJECT_AGENT_SKILLS),
      tools: COMMON_RESEARCH_TOOLS,
      mcpServers: [],
    },
    constraints: {
      maxFissionDepth: 1,
      maxCostPerTask: 0.3,
      allowedTools: COMMON_RESEARCH_TOOLS,
      approvalMode: 'full_auto',
      allowedDomains: [],
    },
    card: {
      version: 'v2',
      soul: '你是 TAgent 的项目管理助手，擅长把模糊目标变成可执行、可追踪、可验收的计划。',
      responsibilities: [
        '拆解任务、依赖、里程碑和风险。',
        '生成可执行行动项和验收标准。',
        '识别阻塞点和需要用户决策的事项。',
      ],
      boundaries: [
        '不替用户承诺未确认的时间和资源。',
        '不隐藏风险或假设。',
        '不生成不可验收的空泛任务。',
      ],
      mcpPreferences: ['jira', 'linear', 'github', 'calendar'],
      qualityChecks: [
        '每个任务注明已知责任归属；未给出的责任人或角色写“材料未提供”，仅对原文明示待定的岗位写“待定”，不强行把某个角色分配到全部任务。',
        '材料未提供人员信息与实际岗位空缺分开陈述；风险概率缺乏依据时写未评估，不用已知依赖条件推断概率高。',
        '输入、输出、依赖与用户条件一致；新增验收标准标为建议，已明确条件不再追问。',
        '每条风险区分材料依据、触发条件、条件性影响和建议；不虚构发生时间、责任空缺或风险数量，不因缩短工期的目标擅改串行条件。',
        '关键依赖和风险被显式列出。',
        '计划粒度适合直接执行。',
      ],
      fallbackStrategy: '先按已知条件完成可确定的排期；只列真实缺口，假设和建议明确标注，不把已确定条件改成待确认。',
      exampleTasks: [
        '把产品优化需求拆成两周迭代计划。',
        '整理项目风险清单。',
        '生成跨团队协作的行动项。',
      ],
      outputStandards: ['里程碑', '任务清单', '风险', '依赖', '验收标准'],
      scoreProfile: scoreProfile({ research: 66, writing: 72, planning: 96, communication: 78, governance: 84 }),
    },
  }),
  residentAgent({
    id: 'communication-agent',
    name: '沟通邮件',
    description: '负责邮件、通知、会议纪要、对外说明和团队同步内容。',
    icon: '✉️',
    capabilities: {
      skills: unique(COMMUNICATION_AGENT_SKILLS),
      tools: COMMON_RESEARCH_TOOLS,
      mcpServers: [],
    },
    constraints: {
      maxFissionDepth: 1,
      maxCostPerTask: 0.25,
      allowedTools: COMMON_RESEARCH_TOOLS,
      approvalMode: 'full_auto',
      allowedDomains: [],
    },
    card: {
      version: 'v2',
      soul: '你是 TAgent 的沟通邮件助手，擅长把复杂信息改写成清楚、得体、可发送的沟通内容。',
      responsibilities: [
        '识别受众、目的、语气和期望动作。',
        '生成邮件、公告、纪要和同步稿。',
        '提炼决策、行动项和待确认事项。',
      ],
      boundaries: [
        '不虚构承诺、日期或人名。',
        '不替用户发送外部消息。',
        '不使用过度营销或含糊措辞。',
      ],
      mcpPreferences: ['email', 'calendar', 'crm'],
      qualityChecks: [
        '开头说明目的。',
        '中段给关键事实。',
        '结尾给明确下一步。',
      ],
      fallbackStrategy: '缺少受众或语气时，先提供默认商务版并列出可调整选项。',
      exampleTasks: [
        '把会议记录整理成发送给客户的邮件。',
        '写一封项目延期说明。',
        '生成团队周同步模板。',
      ],
      outputStandards: ['目的明确', '语气得体', '行动项清楚', '可直接发送'],
      scoreProfile: scoreProfile({ writing: 88, planning: 72, communication: 96, governance: 78 }),
    },
  }),
  residentAgent({
    id: 'presentation-agent',
    name: '演示汇报',
    description: '负责汇报结构、PPT 大纲、演讲稿、高层摘要和叙事线设计。',
    icon: '🧩',
    capabilities: {
      skills: unique(PRESENTATION_AGENT_SKILLS),
      tools: COMMON_RESEARCH_TOOLS,
      mcpServers: [],
    },
    constraints: {
      maxFissionDepth: 1,
      maxCostPerTask: 0.3,
      allowedTools: COMMON_RESEARCH_TOOLS,
      approvalMode: 'full_auto',
      allowedDomains: [],
    },
    card: {
      version: 'v2',
      soul: '你是 TAgent 的演示汇报助手，擅长把复杂材料变成有重点、有叙事、有决策价值的汇报。',
      responsibilities: [
        '设计汇报叙事线和页面结构。',
        '生成高层摘要、PPT 大纲和演讲备注。',
        '把证据、图表和建议放到合适页面。',
      ],
      boundaries: [
        '不把未经验证的观点写成结论。',
        '不堆砌信息造成每页过载。',
        '不生成无法追溯的数据图表。',
        '标题和讲稿的结论不得强于材料；单指标前后变化不是方案因果效果或整体效率的证明。',
      ],
      mcpPreferences: ['slides', 'figma', 'charts', 'docs'],
      qualityChecks: [
        '每页只有一个主旨。',
        '结论、证据、行动建议可分辨。',
        '适配目标听众。',
        '每句讲稿与标题分别核对证据；建议就近标明，不虚构决策会议、审批期限或已确定预算。',
      ],
      fallbackStrategy: '材料不足时先输出汇报骨架、关键缺口和建议补充图表。',
      exampleTasks: [
        '把调研报告改成 8 页汇报大纲。',
        '生成 CEO 版高层摘要。',
        '为产品发布会设计演讲结构。',
      ],
      outputStandards: ['先结论', '页标题即观点', '证据可追溯', '行动建议明确'],
      scoreProfile: scoreProfile({ research: 66, writing: 86, planning: 78, communication: 82, presentation: 96, governance: 78 }),
    },
  }),
];

export const AGENT_SOULS: Record<string, string> = Object.fromEntries(
  RESIDENT_AGENTS.map(agent => [agent.id, agent.card.soul]),
);

export class AgentPool {
  private agents = new Map<string, AgentCard>();
  private executions = new Map<string, number>();
  private registry: AgentRegistry | null = null;

  constructor() {
    for (const agent of RESIDENT_AGENTS) {
      this.agents.set(agent.id, structuredClone(agent));
    }
  }

  async initialize(workspaceRoot: string): Promise<void> {
    this.registry = new AgentRegistry(workspaceRoot);
    const overrides = await this.registry.getOverrides();
    for (const [id, override] of Object.entries(overrides)) {
      const agent = this.agents.get(id);
      if (agent) {
        if (override.skills) agent.capabilities.skills = override.skills;
        if (override.mcpServers) agent.capabilities.mcpServers = override.mcpServers;
      }
    }
  }

  async updateAgentOverride(id: string, skills?: string[], mcpServers?: string[]): Promise<void> {
    if (!this.registry) throw new Error('AgentPool not initialized');
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Agent ${id} not found`);

    const override = await this.registry.updateOverride(id, { skills, mcpServers });
    if (override.skills) agent.capabilities.skills = override.skills;
    if (override.mcpServers) agent.capabilities.mcpServers = override.mcpServers;
  }

  getResidentAgents(): AgentCard[] {
    return Array.from(this.agents.values()).filter(agent => agent.type === 'resident');
  }

  getAllAgents(): AgentCard[] {
    return Array.from(this.agents.values());
  }

  getAgent(id: string): AgentCard | undefined {
    return this.agents.get(id);
  }

  updateState(id: string, state: Partial<AgentState>): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.state = { ...agent.state, ...state };
    }
  }

  updateAgent(id: string, card: AgentCard): void {
    if (this.executions.has(id)) card = { ...card, state: { ...card.state, business: 'busy' } };
    this.agents.set(id, card);
  }

  beginExecution(id: string): () => void {
    const agent = this.agents.get(id);
    if (!agent || agent.state.runtime !== 'running') throw new Error(`Agent ${id} is not available`);
    this.executions.set(id, (this.executions.get(id) || 0) + 1);
    this.updateState(id, { business: 'busy' });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.executions.get(id) || 1) - 1;
      if (remaining) this.executions.set(id, remaining);
      else { this.executions.delete(id); this.updateState(id, { business: 'idle' }); }
    };
  }

  getTaskAgents(filter: TaskAgentFilter = {}): AgentCard[] {
    return Array.from(this.agents.values()).filter(agent => {
      if (agent.type !== 'task_spawned') return false;
      if (filter.parentId && agent.parentAgentId !== filter.parentId) return false;
      if (filter.sessionId && agent.spawnMeta?.sessionId !== filter.sessionId) return false;
      if (filter.runId && agent.spawnMeta?.runId !== filter.runId) return false;
      return true;
    });
  }

  spawnTaskAgent(parentId: string, input: SpawnTaskAgentInput): AgentCard;
  spawnTaskAgent(parentId: string, name: string, description: string, icon?: string): AgentCard;
  spawnTaskAgent(parentId: string, inputOrName: SpawnTaskAgentInput | string, description?: string, icon = '⚡'): AgentCard {
    return this.publishTaskAgent(this.prepareTaskAgent(parentId, typeof inputOrName === 'string' ? {
      name: inputOrName, description, icon, objective: description || inputOrName,
      createdReason: '由主 Agent 根据当前任务拆解创建。',
    } : inputOrName));
  }

  /** Build without publishing so the server can commit history before exposing a child. */
  prepareTaskAgent(parentId: string, input: SpawnTaskAgentInput, parentSnapshot?: AgentCard): AgentCard {
    const id = `task-agent-${randomUUID()}`;
    const parent = parentSnapshot || this.agents.get(parentId);
    if (parentSnapshot && parentSnapshot.id !== parentId) throw new Error('Parent snapshot mismatch');
    if (!parent) {
      throw new Error(`Parent agent ${parentId} not found`);
    }
    const depth = parent.type === 'resident' ? 1 : (parent.spawnMeta?.depth || 1) + 1;
    if (parent.constraints.maxFissionDepth <= 0 || depth > 2) {
      throw new Error(`Agent ${parentId} has reached max fission depth`);
    }
    if (parent.type === 'resident' && parent.state.runtime !== 'running') throw new Error('父 Agent 已停止，不能创建子 Agent。');
    if (!input.name?.trim() || !input.objective?.trim() || !input.createdReason?.trim()) throw new Error('子 Agent 需要名称、目标和创建原因。');
    const budget = Math.min(parent.constraints.maxCostPerTask * 0.5, input.maxCost ?? Infinity);
    if (!Number.isFinite(budget) || budget <= 0) throw new Error('子 Agent 无可用预算。');
    const inheritedTools = parent.constraints.allowedTools;
    const card = createAgentCard({
      id,
      name: input.name,
      type: 'task_spawned',
      description: input.description || input.objective,
      icon: input.icon || '⚡',
      capabilities: {
        skills: [...parent.capabilities.skills],
        tools: [...parent.capabilities.tools],
        mcpServers: [...parent.capabilities.mcpServers],
      },
      constraints: {
        maxFissionDepth: Math.max(0, Math.min(2 - depth, parent.constraints.maxFissionDepth - 1)),
        maxCostPerTask: budget,
        allowedTools: [...inheritedTools],
        approvalMode: parent.constraints.approvalMode,
        allowedDomains: [...parent.constraints.allowedDomains],
      },
      parentAgentId: parentId,
      spawnMeta: {
        workspaceId: input.workspaceId,
        parentName: parent.name,
        depth,
        status: 'queued',
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        objective: input.objective,
        createdReason: input.createdReason,
        inputSummary: input.inputSummary,
        createdAt: Date.now(),
      },
      card: {
        ...structuredClone(parent.card),
        version: 'v2',
        soul: [
          parent.card.soul,
          '',
          `## 当前子任务定位`,
          input.createdReason,
          `目标：${input.objective}`,
        ].join('\n').trim(),
        responsibilities: [...parent.card.responsibilities],
        boundaries: [
          ...parent.card.boundaries,
          '这是任务期子 Agent，不会在用户确认前保存为常驻 Agent。',
          '不得扩大父 Agent 的工具白名单、预算或治理边界。',
        ],
        mcpPreferences: [...parent.card.mcpPreferences],
        qualityChecks: [...parent.card.qualityChecks],
        fallbackStrategy: parent.card.fallbackStrategy || '说明不确定性并返回部分结果。',
        exampleTasks: input.objective ? [input.objective] : [],
        outputStandards: [...parent.card.outputStandards],
        scoreProfile: structuredClone(parent.card.scoreProfile || scoreProfile({})),
      },
    });

    return card;
  }

  publishTaskAgent(card: AgentCard): AgentCard {
    if (card.type !== 'task_spawned' || !card.spawnMeta || !card.parentAgentId) throw new Error('Invalid task agent');
    card.childAgentIds = [...new Set([...card.childAgentIds, ...(this.agents.get(card.id)?.childAgentIds || [])])];
    this.updateAgent(card.id, card);
    const parent = this.agents.get(card.parentAgentId);
    if (parent && !parent.childAgentIds.includes(card.id)) parent.childAgentIds.push(card.id);
    return this.agents.get(card.id)!;
  }

  createResidentFromTaskAgent(id: string, input: PromoteTaskAgentInput = {}): AgentCard {
    const source = this.agents.get(id);
    if (!source) throw new Error(`Agent ${id} not found`);
    if (source.type !== 'task_spawned') throw new Error(`Agent ${id} is not a task-spawned agent`);

    const residentId = `agent-from-task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return createAgentCard({
      ...structuredClone(source),
      id: residentId,
      name: input.name || `${source.name} 常驻版`,
      type: 'resident',
      description: input.description || source.description || source.spawnMeta?.objective || '从任务子 Agent 沉淀的常驻 Agent',
      icon: input.icon || source.icon,
      parentAgentId: null,
      childAgentIds: [],
      spawnMeta: undefined,
      state: { business: 'idle', runtime: 'running', humanInteraction: 'idle', orchestration: 'none' },
      stats: { tasksCompleted: 0, totalCost: 0, avgIterations: 0 },
      card: {
        ...structuredClone(source.card),
        boundaries: source.card.boundaries.filter(boundary => ![
          '这是任务期子 Agent，不会在用户确认前保存为常驻 Agent。',
          '不得扩大父 Agent 的工具白名单、预算或治理边界。',
        ].includes(boundary)),
        soul: [
          source.card.soul,
          '',
          '## 任务沉淀来源',
          `来源子 Agent：${source.name}`,
          source.spawnMeta?.objective ? `原始目标：${source.spawnMeta.objective}` : '',
          input.outputSummary ? `沉淀摘要：${input.outputSummary}` : '',
        ].filter(Boolean).join('\n'),
        exampleTasks: unique([
          ...(source.card.exampleTasks || []),
          source.spawnMeta?.objective || '',
        ].filter(Boolean)),
        version: 'v2',
      },
    });
  }

  promoteTaskAgent(id: string, input: PromoteTaskAgentInput = {}): AgentCard {
    const source = this.agents.get(id);
    const resident = this.createResidentFromTaskAgent(id, input);
    this.agents.set(resident.id, resident);
    if (source?.spawnMeta) {
      source.spawnMeta.promotedAgentId = resident.id;
      source.spawnMeta.promotedAt = Date.now();
      if (input.outputSummary) source.spawnMeta.outputSummary = input.outputSummary;
    }
    return resident;
  }

  archiveAgent(id: string): void {
    const agent = this.agents.get(id);
    if (agent && agent.type === 'task_spawned') {
      agent.state.runtime = 'stopped';
      agent.state.business = 'idle';
    }
  }

  findBestAgent(requiredCapabilities: string[]): AgentCard | null {
    const residents = this.getResidentAgents().filter(agent =>
      agent.state.business === 'idle' || agent.state.business === 'waiting',
    );

    let best: AgentCard | null = null;
    let bestScore = 0;

    for (const agent of residents) {
      const text = [
        agent.name,
        agent.description,
        agent.card.soul,
        ...agent.capabilities.skills,
        ...agent.card.responsibilities,
      ].join(' ').toLowerCase();
      const score = requiredCapabilities.filter(capability =>
        text.includes(capability.toLowerCase()),
      ).length;
      if (score > bestScore) {
        bestScore = score;
        best = agent;
      }
    }
    return best;
  }

  findBestAgentForTask(agentRole: string, objective: string): AgentCard | null {
    const residents = this.getResidentAgents().filter(agent =>
      agent.state.runtime === 'running',
    );
    if (!residents.length) return null;

    const role = agentRole.toLowerCase();
    const text = objective.toLowerCase();
    const roleHints: Record<string, string[]> = {
      research: ['research', 'source', 'freshness', 'web_research', 'trend', 'news', 'latest'],
      document: ['writing', 'document', 'report', 'editing', 'structure'],
      data: ['data', 'metric', 'analysis', 'trend', 'dashboard'],
      project: ['project', 'planning', 'task', 'risk', 'milestone'],
      management: ['project', 'planning', 'task', 'risk', 'milestone'],
      communication: ['communication', 'email', 'meeting', 'stakeholder'],
      email: ['communication', 'email', 'meeting', 'stakeholder'],
      presentation: ['presentation', 'slides', 'storytelling', 'summary'],
      slide: ['presentation', 'slides', 'storytelling', 'summary'],
    };
    const hints = unique([
      role,
      ...(roleHints[role] || []),
      ...text.split(/[\s,.;:!?，。；：！？、]+/).filter(token => token.length > 2).slice(0, 12),
    ]);

    let best: AgentCard | null = null;
    let bestScore = -Infinity;

    for (const agent of residents) {
      const searchable = [
        agent.id,
        agent.name,
        agent.description,
        agent.card.soul,
        ...agent.capabilities.skills,
        ...agent.capabilities.tools,
        ...agent.capabilities.mcpServers,
        ...agent.card.responsibilities,
        ...agent.card.outputStandards,
        ...agent.card.capabilityGraph.domains,
        ...agent.card.capabilityGraph.primarySkills,
        ...agent.card.capabilityGraph.toolAffordances,
        ...agent.card.capabilityGraph.mcpAffordances,
      ].join(' ').toLowerCase();

      let score = 0;
      for (const hint of hints) {
        if (hint && searchable.includes(hint.toLowerCase())) score += 4;
      }

      const profile = agent.card.scoreProfile;
      if (role === 'research') score += profile.research / 20 + profile.tooling / 25;
      if (role === 'document') score += profile.writing / 20;
      if (role === 'data') score += profile.data / 20;
      if (role === 'project' || role === 'management') score += profile.planning / 20;
      if (role === 'communication' || role === 'email') score += profile.communication / 20;
      if (role === 'presentation' || role === 'slide') score += profile.presentation / 20;
      score += profile.governance / 100;

      if (score > bestScore) {
        bestScore = score;
        best = agent;
      }
    }

    return best;
  }
}
