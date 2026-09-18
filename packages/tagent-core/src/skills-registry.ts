import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'node:crypto';

export type SkillRiskLevel = 'low' | 'medium' | 'high';
export type SkillDocumentType = 'sop' | 'prompt' | 'reference' | 'checklist' | 'template' | 'policy' | 'example' | 'test' | 'notes';
export type SkillDocumentFormat = 'markdown' | 'text' | 'json' | 'yaml';

export interface SkillPackageManifest {
  name: string;
  category: string;
  version: string;
  triggers: string[];
  applicableAgents: string[];
  riskLevel: SkillRiskLevel;
  tags: string[];
  license?: string;
  compatibility?: string;
}

export interface SkillPackageFile {
  path: string;
  url: string;
  sha?: string;
  size: number;
  encoding?: 'utf8' | 'base64';
  content?: string;
  status: 'included' | 'reference_only';
  reason?: string;
}

export interface SkillPackageSource {
  url: string;
  kind: 'github' | 'url' | 'inline';
  repository?: string;
  ref?: string;
  commit?: string;
  root?: string;
  complete: boolean;
}

export interface SkillPackageIO {
  name: string;
  description: string;
  required?: boolean;
  schema?: Record<string, unknown>;
}

export interface SkillToolDependency {
  type: 'builtin' | 'mcp' | 'api' | 'browser';
  name: string;
  required?: boolean;
  notes?: string;
}

export interface SkillExample {
  input: string;
  expectedOutput: string;
}

export interface SkillTestCase {
  name: string;
  input: string;
  expectedIncludes: string[];
}

export interface SkillPackageDocument {
  id: string;
  type: SkillDocumentType;
  title: string;
  content: string;
  order: number;
  required?: boolean;
  format?: SkillDocumentFormat;
  description?: string;
}

export interface SkillPackage {
  manifest: SkillPackageManifest;
  instructions: string;
  documents: SkillPackageDocument[];
  inputs: SkillPackageIO[];
  outputs: SkillPackageIO[];
  tools: SkillToolDependency[];
  examples: SkillExample[];
  tests: SkillTestCase[];
  riskNotes: string[];
  files?: SkillPackageFile[];
  source?: SkillPackageSource;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  trigger?: string;
  body: string;
  createdAt: number;
  updatedAt?: number;
  package?: SkillPackage;
}

export type SkillInput = Omit<Skill, 'id' | 'createdAt' | 'updatedAt'>;

export function createSkillPackageDraft(input: Partial<Skill>): SkillPackage {
  const trigger = input.trigger?.trim();
  const instructions = input.package?.instructions || input.body || '';
  const documents = normalizeSkillDocuments(input.package?.documents, instructions);
  return {
    manifest: {
      name: input.name || 'untitled-skill',
      category: input.category || 'general',
      version: input.package?.manifest.version || '1.0.0',
      triggers: input.package?.manifest.triggers?.length
        ? input.package.manifest.triggers
        : trigger ? [trigger] : [],
      applicableAgents: input.package?.manifest.applicableAgents || [],
      riskLevel: input.package?.manifest.riskLevel || 'low',
      tags: input.package?.manifest.tags || [],
      license: input.package?.manifest.license,
      compatibility: input.package?.manifest.compatibility,
    },
    instructions,
    documents,
    inputs: input.package?.inputs || [],
    outputs: input.package?.outputs || [
      { name: 'result', description: '结构化任务产出', required: true },
    ],
    tools: input.package?.tools || [],
    examples: input.package?.examples || [],
    tests: input.package?.tests || [],
    riskNotes: input.package?.riskNotes || [],
    files: input.package?.files ? structuredClone(input.package.files) : undefined,
    source: input.package?.source ? structuredClone(input.package.source) : undefined,
  };
}

interface DefaultSkillDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  trigger: string;
  tags: string[];
  applicableAgents: string[];
  tools?: SkillToolDependency[];
  sop: string[];
  prompt?: string;
  checklist?: string[];
  outputs?: SkillPackageIO[];
  examples?: SkillExample[];
  tests?: SkillTestCase[];
  riskNotes?: string[];
}

const DEFAULT_SKILL_TIMESTAMP = 1781395200000;
const ALL_RESIDENT_AGENTS = [
  'research-agent',
  'document-agent',
  'data-agent',
  'project-agent',
  'communication-agent',
  'presentation-agent',
];

const DEFAULT_SKILL_DEFINITIONS: DefaultSkillDefinition[] = [
  {
    id: 'task-briefing',
    name: '任务澄清与简报',
    description: '把用户的自然语言需求整理成目标、受众、输入、输出和约束，降低 Agent 跑偏概率。',
    category: 'common',
    trigger: '任何任务开始前，需要先明确目标、范围、输出格式或约束。',
    tags: ['common', 'brief', 'planning'],
    applicableAgents: ALL_RESIDENT_AGENTS,
    sop: [
      '在执行前明确用户真正想完成的结果；除非用户要求，不把内部任务简报放入最终回复。',
      '识别受众、使用场景、已有输入、缺失信息和约束条件。',
      '把任务拆成“必须完成 / 可选增强 / 暂不处理”三类。',
      '先完成已知条件下能确定的结果；只对真正缺失且影响交付的信息提出问题，不能重复询问已给出的条件。必要假设标注为假设，不把建议变成已定事实。',
    ],
    checklist: ['目标明确', '输出形态明确', '关键假设显式列出', '不扩大任务范围'],
    outputs: [
      { name: 'brief', description: '执行用任务简报；仅当用户需要时作为交付内容', required: false },
    ],
  },
  {
    id: 'structured-output',
    name: '结构化输出',
    description: '把结果组织成摘要、依据、分项内容、风险和下一步，适合非技术用户快速浏览。',
    category: 'common',
    trigger: '需要生成报告、分析、计划、邮件、汇报或任何可交付内容。',
    tags: ['common', 'output', 'report'],
    applicableAgents: ALL_RESIDENT_AGENTS,
    sop: [
      '优先遵守用户要求的产出类型、篇幅和字段，邮件、短答、表格、逐页大纲不套用同一报告模板。',
      '报告需要时再使用摘要和主题分节；不要为了固定章节添加无关内容。',
      '把事实、判断、建议和风险分开表达。',
      '只在任务需要时给出下一步，用户仅要交付物时不追加分析或追问。',
    ],
    checklist: ['符合用户格式与篇幅', '只包含必要章节', '事实与判断分开', '保留关键限制'],
  },
  {
    id: 'quality-review',
    name: '交付质量复核',
    description: '在最终输出前做一次可读性、完整性、事实边界和行动性的复核。',
    category: 'common',
    trigger: '任何 Agent 准备输出最终结果前。',
    tags: ['common', 'quality', 'review'],
    applicableAgents: ALL_RESIDENT_AGENTS,
    sop: [
      '检查答案是否回应了用户原始问题。',
      '删除重复、空泛、无法验证的表达。',
      '确认关键结论有依据，无法确认的内容标注为推断或待验证。',
      '确认输出能被普通办公用户直接使用。',
      '检查是在执行中完成，不附自检打分、通过声明或未经计算的字数估算。',
    ],
    checklist: ['无明显遗漏', '无伪造事实', '术语可理解', '行动项可执行'],
  },
  {
    id: 'risk-boundary-check',
    name: '风险与边界检查',
    description: '识别安全、合规、成本、权限和信息不确定性，必要时降级或请求确认。',
    category: 'common',
    trigger: '任务涉及外部工具、联网资料、重要决策、成本或权限风险。',
    tags: ['common', 'governance', 'risk'],
    applicableAgents: ALL_RESIDENT_AGENTS,
    sop: [
      '识别任务是否需要调用工具、读取外部来源或依赖敏感信息。',
      '标注可能的成本、权限、时效和事实不确定性。',
      '遇到高风险操作时只生成预览和建议，不静默执行。',
      '最终输出里保留关键假设和限制。',
    ],
    checklist: ['风险已列出', '高风险未静默执行', '假设已标注'],
    riskNotes: ['默认不执行外部写入、安装、发送或删除操作。'],
  },
  {
    id: 'handoff-summary',
    name: '跨 Agent 交接摘要',
    description: '把一个 Agent 的结果整理成另一个 Agent 能继续使用的简短上下文。',
    category: 'common',
    trigger: '多 Agent 协作、需要把调研结果交给文档/项目/汇报/沟通 Agent 时。',
    tags: ['common', 'handoff', 'orchestration'],
    applicableAgents: ALL_RESIDENT_AGENTS,
    sop: [
      '只保留对下游任务有用的信息。',
      '按“已确认事实 / 推断 / 风险 / 待补充”组织。',
      '给出下游 Agent 应该继续处理的具体目标。',
      '保留必要来源或依据，避免上下文丢失。',
    ],
    checklist: ['事实和推断分开', '有下游任务目标', '有未解决问题'],
  },
  {
    id: 'web-research',
    name: '联网调研',
    description: '使用搜索、网页阅读和交叉验证获得可追溯资料。',
    category: 'research',
    trigger: '需要调研外部事实、竞品、新闻、政策、市场或技术资料。',
    tags: ['research', 'web', 'source'],
    applicableAgents: ['research-agent', 'document-agent', 'data-agent', 'presentation-agent'],
    tools: [
      { type: 'builtin', name: 'web_research', required: true, notes: '优先使用的综合调研工具' },
      { type: 'builtin', name: 'read_url', required: false, notes: '阅读关键来源原文' },
    ],
    sop: [
      '先构造 2-4 个具体检索词，包含时间、地域、主体和场景。',
      '优先读取官方网站、文档、新闻稿、权威媒体或一手资料。',
      '对关键事实至少寻找两个来源或明确说明只有单一来源。',
      '记录来源日期、访问日期和 URL。',
    ],
    checklist: ['来源可打开', '日期可识别', '结论和来源匹配'],
  },
  {
    id: 'last-30-days-research',
    name: '近 30 天信息识别',
    description: '面向“最新/近期/趋势”任务，优先寻找最近 30 天内的资料并标注时效。',
    category: 'research',
    trigger: '用户提到最新、实时、近况、新闻、趋势、近 30 天或当前月份。',
    tags: ['research', 'freshness', 'news'],
    applicableAgents: ['research-agent'],
    tools: [{ type: 'builtin', name: 'web_research', required: true }],
    sop: [
      '检索词必须带当前年份和月份，必要时同时使用中文和英文。',
      '优先保留最近 30 天来源；旧来源只能作为背景，不得写成最新。',
      '最终报告必须显示调研日期、来源日期和无法验证的信息。',
    ],
    checklist: ['检索词包含当前年月', '旧来源被标注为背景', '报告有调研日期'],
  },
  {
    id: 'source-verification',
    name: '来源验证',
    description: '检查信息来源的可信度、时效、归属和引用风险。',
    category: 'research',
    trigger: '输出包含事实、数据、新闻、竞品信息、价格或政策判断。',
    tags: ['research', 'verification', 'quality'],
    applicableAgents: ['research-agent', 'document-agent', 'data-agent', 'presentation-agent'],
    sop: [
      '区分一手来源、二手报道、社区讨论和模型推断。',
      '检查来源发布时间和内容更新时间。',
      '对不一致信息给出可能原因，不强行合并。',
      '引用时使用短说明，不大段复制原文。',
    ],
    checklist: ['来源等级明确', '日期明确', '不确定性明确'],
  },
  {
    id: 'document-structure',
    name: '文档结构设计',
    description: '为报告、方案、PRD、纪要等办公文档建立清晰结构。',
    category: 'document',
    trigger: '需要写报告、方案、说明文档、需求文档或纪要。',
    tags: ['document', 'structure'],
    applicableAgents: ['document-agent'],
    sop: [
      '先判断文档读者和使用场景。',
      '选择适合的结构：摘要、背景、分析、方案、风险、行动项。',
      '每个标题必须能概括该节观点。',
      '把长段落改成短段落、列表或表格。',
    ],
    checklist: ['标题层级清楚', '阅读路径顺畅', '行动项独立可见'],
  },
  {
    id: 'content-editing',
    name: '内容编辑与润色',
    description: '提升文字清晰度、语气一致性和可读性。',
    category: 'document',
    trigger: '需要改写、润色、压缩、扩写或统一风格。',
    tags: ['document', 'writing'],
    applicableAgents: ['document-agent', 'communication-agent', 'presentation-agent'],
    sop: [
      '保留原意，不新增未经确认的事实。',
      '删掉重复、空话和过度形容。',
      '根据受众调整正式程度和术语密度。',
      '让每段都有明确作用。',
    ],
    checklist: ['语气一致', '无无效重复', '事实未被改写失真'],
  },
  {
    id: 'report-generation',
    name: '报告生成',
    description: '把材料整理成可交付报告，包含摘要、分析、结论、风险和建议。',
    category: 'document',
    trigger: '需要生成调研报告、总结报告、复盘报告或管理层报告。',
    tags: ['document', 'report'],
    applicableAgents: ['document-agent', 'research-agent'],
    sop: [
      '先写管理摘要，再展开分析。',
      '每个结论后给依据或说明信息来源。',
      '使用表格对比复杂对象。',
      '最后给建议、风险和待补充信息。',
    ],
    checklist: ['有摘要', '有依据', '有建议', '适合直接转交'],
  },
  {
    id: 'data-analysis',
    name: '数据分析框架',
    description: '围绕指标、趋势、异常、原因和行动建议分析数据。',
    category: 'data',
    trigger: '任务包含数据、指标、表格、趋势、对比或异常。',
    tags: ['data', 'analysis'],
    applicableAgents: ['data-agent'],
    sop: [
      '先说明数据来源、时间范围和口径。',
      '识别核心指标、维度和对比基线。',
      '分析趋势、异常和可能原因。',
      '把结论转化为业务建议。',
    ],
    checklist: ['口径明确', '趋势明确', '异常明确', '建议可执行'],
  },
  {
    id: 'table-calculation',
    name: '原始表格计算',
    description: '从用户粘贴的CSV、TSV或Markdown表格计算分组指标和变化率，保留数据范围与异常说明。',
    category: 'data',
    trigger: '需要对用户提供的表格汇总、分组、比较或复核数字。',
    tags: ['data', 'table', 'calculation', 'verification'],
    applicableAgents: ALL_RESIDENT_AGENTS,
    tools: [{ type: 'builtin', name: 'read_data_source', required: true }, { type: 'builtin', name: 'analyze_table', required: true }],
    sop: [
      '先用read_data_source列出当前任务的完整用户原文并读取编号行，不把历史助手回复、摘要或模型重录的数据当成原表。',
      '选择含表头的完整表格范围，CSV/TSV不包含代码围栏或说明文字；先inspect确认字段、行数、缺失和非数值，再aggregate。',
      '按实际列名选指标和分组；不要只挑部分正常行隐藏异常。行范围必须回应用户范围，有排除需说明。',
      '无效数值默认拒绝计算；仅在任务允许排除时使用exclude，并报告排除数量和限制。空白不当零，不自动换算单位、百分号或货币。',
      '比较须明确基期与本期，使用工具返回的差值和变化率；基期为零或负数时不报告普通增长率。',
      '交付统计表和必要业务解释，保留来源行范围、样本数、异常、单位和舍入说明；计算正确不等于来源已核实或因果成立。',
    ],
    checklist: ['引用完整用户原表及行范围', '统计结果来自实际工具回执', '缺失或无效值未隐藏', '基期单位口径明确', '不执行公式或扩大工具权限'],
    riskNotes: ['仅本地只读计算；不读磁盘、不联网、不执行公式或脚本。工具返回进入当前任务模型上下文，仍属于用户任务的材料外发范围。'],
  },
  {
    id: 'metric-review',
    name: '指标口径复核',
    description: '检查指标定义、时间窗口、样本范围和可比性。',
    category: 'data',
    trigger: '分析依赖指标或不同来源数据需要比较。',
    tags: ['data', 'metric', 'quality'],
    applicableAgents: ['data-agent'],
    sop: [
      '列出所有关键指标定义。',
      '检查时间窗口、统计口径和样本范围是否一致。',
      '对无法比较的数据标注限制。',
      '避免把相关性写成因果关系。',
    ],
    checklist: ['指标定义明确', '可比性已检查', '限制已说明'],
  },
  {
    id: 'trend-insight',
    name: '趋势洞察',
    description: '从数据或资料中提炼方向、变化、驱动因素和业务意义。',
    category: 'data',
    trigger: '需要判断趋势、机会、风险或变化原因。',
    tags: ['data', 'trend', 'insight'],
    applicableAgents: ['data-agent', 'research-agent'],
    sop: [
      '识别上升、下降、波动或结构变化。',
      '把变化和可能驱动因素分开描述。',
      '标注证据强度：强证据、弱证据、待验证。',
      '给出对业务或项目的影响。',
    ],
    checklist: ['趋势有证据', '原因不过度确定', '影响说清楚'],
  },
  {
    id: 'task-breakdown',
    name: '任务拆解',
    description: '把模糊目标拆成可执行任务、输入、输出和验收标准。',
    category: 'project',
    trigger: '需要制定计划、拆需求、安排执行或分配工作。',
    tags: ['project', 'task'],
    applicableAgents: ['project-agent'],
    sop: [
      '先明确目标和最终交付物。',
      '保留用户已给出的任务、编号和依赖；目标模糊时才建议拆分阶段，不强凑固定数量。',
      '每个任务写清已知输入、输出与责任归属；材料未给的人员/岗位写“材料未提供”，建议分工须就近标明待确认，不等于现实中无人负责。',
      '用户已给出的完成条件直接沿用；新增验收标准明确标为建议，不冒充现行制度。',
      '标注任务依赖和阻塞风险。',
    ],
    checklist: ['任务可执行', '有验收标准', '依赖明确'],
  },
  {
    id: 'project-planning',
    name: '项目计划',
    description: '生成里程碑、节奏、依赖、风险和跟进机制。',
    category: 'project',
    trigger: '需要项目计划、迭代计划、时间表或推进方案。',
    tags: ['project', 'plan'],
    applicableAgents: ['project-agent'],
    sop: [
      '按用户给出的工期、依赖和工作日口径排期；不能为模板擅改任务或增加被排除的日期要求。',
      '区分材料已说明的交付物与建议完成标准；不知道责任归属不等于实际岗位空缺。',
      '列出关键依赖、资源假设和沟通节奏。',
      '风险以尚未发生的条件表达；保持给定工期与依赖，缩短工期的目标不代表可并行。改变原条件的备选方案须明确另需用户批准。',
    ],
    checklist: ['里程碑清楚', '节奏合理', '风险可追踪'],
  },
  {
    id: 'risk-tracking',
    name: '风险跟踪',
    description: '按材料依据、触发条件、可能影响和应对建议整理风险。',
    category: 'project',
    trigger: '任务涉及项目风险、延期、依赖、质量或资源不确定性。',
    tags: ['project', 'risk'],
    applicableAgents: ['project-agent'],
    sop: [
      '只列与任务有关且能说明依据的风险，不预设条数；按材料依据、尚未发生的触发条件、条件性影响、建议组织。',
      '区分已发生问题、潜在风险和材料缺口；人员信息未提供不能直接推断无法派工。',
      '局部岗位待定不扩为全部分配或验收职责空缺；返工时间和延期幅度没有依据时保持未知，不从原计划编造具体发生时间。',
      '影响、概率和触发信号须有依据；没有概率依据时省略该列或写“未评估”，不能把已知依赖条件当作高概率证据。',
      '预防和应急动作明确标为建议；未经用户确认不构成审批要求、截止时间或已采取措施。',
      '明确哪些风险需要用户决策。',
    ],
    checklist: ['风险有依据和条件', '风险与材料缺口分开', '概率未知未强行分级', '应对建议未冒充已批准规则'],
  },
  {
    id: 'stakeholder-communication',
    name: '干系人沟通',
    description: '根据对象、目的和语气生成清楚得体的沟通内容。',
    category: 'communication',
    trigger: '需要对客户、领导、团队或合作方沟通。',
    tags: ['communication', 'stakeholder'],
    applicableAgents: ['communication-agent', 'project-agent'],
    sop: [
      '先判断受众关系、沟通目的和期望动作。',
      '开头说明背景和目的。',
      '正文只保留对受众有用的信息。',
      '结尾给明确行动、时间或待确认事项。',
    ],
    checklist: ['受众明确', '目的明确', '下一步明确'],
  },
  {
    id: 'email-writing',
    name: '邮件写作',
    description: '生成可直接发送的商务邮件、说明邮件和跟进邮件。',
    category: 'communication',
    trigger: '需要写邮件、回复邮件、催办、说明或道歉。',
    tags: ['communication', 'email'],
    applicableAgents: ['communication-agent'],
    sop: [
      '主题行简短明确。',
      '第一段说明目的和上下文。',
      '中间用列表表达事项、原因和影响。',
      '结尾写清需要对方做什么。',
    ],
    checklist: ['主题明确', '语气得体', '行动项明确'],
  },
  {
    id: 'meeting-notes',
    name: '会议纪要',
    description: '把会议内容整理成决策、行动项、风险和待确认事项。',
    category: 'communication',
    trigger: '需要整理会议记录、讨论摘要或周会纪要。',
    tags: ['communication', 'meeting'],
    applicableAgents: ['communication-agent', 'project-agent'],
    sop: [
      '先提炼会议目的和结论。',
      '分离已决策事项、讨论要点和待确认问题。',
      '行动项必须包含任务、负责人角色和截止时间或待定标记。',
      '保留风险和依赖。',
    ],
    checklist: ['决策可见', '行动项清楚', '待确认问题清楚'],
  },
  {
    id: 'storytelling',
    name: '汇报叙事',
    description: '为汇报建立“背景-问题-洞察-方案-行动”的叙事线。',
    category: 'presentation',
    trigger: '需要做演示、汇报、路演或管理层沟通。',
    tags: ['presentation', 'story'],
    applicableAgents: ['presentation-agent'],
    sop: [
      '先确定听众和汇报目标。',
      '用一条主线串联背景、问题、证据、建议和行动。',
      '每一页只表达一个观点。',
      '把重要结论提前，不让听众等到最后。',
    ],
    checklist: ['听众明确', '主线明确', '每页一个观点'],
  },
  {
    id: 'presentation-outline',
    name: 'PPT 大纲',
    description: '生成页标题、页面目标、核心内容和建议图表。',
    category: 'presentation',
    trigger: '需要 PPT 大纲、汇报结构或演讲页设计。',
    tags: ['presentation', 'slides'],
    applicableAgents: ['presentation-agent'],
    sop: [
      '先给整体页数和叙事节奏。',
      '每页标题写成观点句。',
      '为每页补充内容要点、证据和图表建议。',
      '最后给演讲备注或讲述顺序。',
    ],
    checklist: ['页标题是观点', '内容不过载', '图表建议合理'],
  },
  {
    id: 'executive-summary',
    name: '高层摘要',
    description: '面向管理层提炼结论、影响、风险和决策请求。',
    category: 'presentation',
    trigger: '需要 CEO/管理层摘要、决策简报或一页纸汇报。',
    tags: ['presentation', 'summary'],
    applicableAgents: ['presentation-agent', 'document-agent'],
    sop: [
      '先写结论和建议，而不是过程。',
      '只保留影响决策的事实和判断。',
      '突出风险、机会、成本和需要拍板的事项。',
      '限制篇幅，适合快速阅读。',
    ],
    checklist: ['先结论', '有决策请求', '风险和影响明确'],
  },
];

export const DEFAULT_RESIDENT_SKILLS: Skill[] = DEFAULT_SKILL_DEFINITIONS.map(createDefaultSkill);

function createDefaultSkill(definition: DefaultSkillDefinition): Skill {
  const instructions = definition.sop.map((step, index) => `${index + 1}. ${step}`).join('\n');
  const documents: SkillPackageDocument[] = [
    {
      id: `${definition.id}-sop`,
      type: 'sop',
      title: '使用步骤',
      content: instructions,
      order: 1,
      required: true,
      format: 'markdown',
    },
  ];

  if (definition.prompt) {
    documents.push({
      id: `${definition.id}-prompt`,
      type: 'prompt',
      title: '提示词',
      content: definition.prompt,
      order: documents.length + 1,
      required: false,
      format: 'markdown',
    });
  }

  if (definition.checklist?.length) {
    documents.push({
      id: `${definition.id}-checklist`,
      type: 'checklist',
      title: '检查清单',
      content: definition.checklist.map(item => `- ${item}`).join('\n'),
      order: documents.length + 1,
      required: true,
      format: 'markdown',
    });
  }

  const base: SkillInput = {
    name: definition.name,
    description: definition.description,
    category: definition.category,
    trigger: definition.trigger,
    body: instructions,
    package: {
      manifest: {
        name: definition.name,
        category: definition.category,
        version: '1.0.0',
        triggers: [definition.trigger],
        applicableAgents: definition.applicableAgents,
        riskLevel: 'low',
        tags: definition.tags,
      },
      instructions,
      documents,
      inputs: [{ name: 'task', description: '用户任务或待处理材料', required: true }],
      outputs: definition.outputs || [{ name: 'result', description: '可直接使用的结构化结果', required: true }],
      tools: definition.tools || [],
      examples: definition.examples || [],
      tests: definition.tests || [
        { name: `${definition.id}-shape`, input: `使用 ${definition.name} 处理任务`, expectedIncludes: [definition.name.split(' ')[0]] },
      ],
      riskNotes: definition.riskNotes || [],
    },
  };

  return normalizeDefaultSkill({
    ...base,
    id: definition.id,
    createdAt: DEFAULT_SKILL_TIMESTAMP,
    updatedAt: DEFAULT_SKILL_TIMESTAMP,
  });
}

function normalizeDefaultSkill(skill: Skill): Skill {
  return {
    ...skill,
    package: createSkillPackageDraft(skill),
  };
}

function cloneSkill(skill: Skill): Skill {
  return JSON.parse(JSON.stringify(skill)) as Skill;
}

function mergeDefaultSkills(skills: Skill[]): Skill[] {
  const byId = new Map(DEFAULT_RESIDENT_SKILLS.map(skill => [skill.id, cloneSkill(skill)]));
  for (const skill of skills) byId.set(skill.id, skill);
  return Array.from(byId.values());
}

export function normalizeSkillDocuments(
  documents: SkillPackageDocument[] | undefined,
  fallbackInstructions = '',
): SkillPackageDocument[] {
  const normalized = (documents || [])
    .map((document, index) => ({
      id: document.id || `doc-${document.type || 'notes'}-${index + 1}`,
      type: document.type || 'notes',
      title: document.title || labelSkillDocumentType(document.type || 'notes'),
      content: document.content || '',
      order: Number.isFinite(document.order) ? document.order : index + 1,
      required: document.required,
      format: document.format || 'markdown',
      description: document.description,
    }))
    .filter(document => document.content.trim() || document.title.trim())
    .sort((a, b) => a.order - b.order);

  if (!normalized.length && fallbackInstructions.trim()) {
    return [{
      id: 'doc-core-sop',
      type: 'sop',
      title: '核心 SOP',
      content: fallbackInstructions,
      order: 1,
      required: true,
      format: 'markdown',
      description: '从旧版 Skill body/instructions 自动迁移的核心执行步骤。',
    }];
  }

  return normalized;
}

function labelSkillDocumentType(type: SkillDocumentType): string {
  const labels: Record<SkillDocumentType, string> = {
    sop: '核心 SOP',
    prompt: 'Prompt',
    reference: '参考资料',
    checklist: '检查清单',
    template: '输出模板',
    policy: '约束策略',
    example: '示例',
    test: '测试样例',
    notes: '补充说明',
  };
  return labels[type] || '补充说明';
}

export class SkillsRegistry {
  private skillsFile: string;
  private skillsCache: Skill[] | null = null;
  private loading?: Promise<Skill[]>;
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(workspaceRoot: string) {
    const dotTagentDir = path.join(workspaceRoot, '.tagent');
    this.skillsFile = path.join(dotTagentDir, 'skills.json');
  }

  private async ensureDir(): Promise<void> {
    const dir = path.dirname(this.skillsFile);
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  private normalize(skill: Skill): Skill {
    const normalized: Skill = {
      ...skill,
      body: skill.body || skill.package?.instructions || '',
    };
    normalized.package = createSkillPackageDraft(normalized);
    return normalized;
  }

  private async load(): Promise<Skill[]> {
    if (this.skillsCache) return this.skillsCache;
    if (!this.loading) this.loading = this.read().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async read(): Promise<Skill[]> {
    try {
      const data = await fs.readFile(this.skillsFile, 'utf-8');
      const parsed = JSON.parse(data) as Skill[];
      if (!Array.isArray(parsed) || parsed.some(skill => !skill || typeof skill.id !== 'string' || typeof skill.name !== 'string')) throw new Error('Skill 存储格式损坏，未覆盖文件。');
      this.skillsCache = mergeDefaultSkills(parsed.map(skill => this.normalize(skill)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.skillsCache = mergeDefaultSkills([]);
      } else {
        throw error;
      }
    }
    return this.skillsCache;
  }

  private async save(next: Skill[]): Promise<void> {
    await this.ensureDir();
    const temporaryPath = `${this.skillsFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx', flush: true });
      await fs.rename(temporaryPath, this.skillsFile);
      this.skillsCache = next;
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }

  private mutate<T>(operation: (next: Skill[]) => T): Promise<T> {
    const result = this.mutations.then(async () => {
      const next = structuredClone(await this.load());
      const value = operation(next);
      await this.save(next);
      return structuredClone(value);
    });
    this.mutations = result.catch(() => undefined);
    return result;
  }

  async getSkills(): Promise<Skill[]> {
    return structuredClone(await this.load());
  }

  async getSkill(id: string): Promise<Skill | undefined> {
    const skills = await this.load();
    return structuredClone(skills.find(skill => skill.id === id));
  }

  async addSkill(skill: SkillInput): Promise<Skill> {
    const newSkill = this.normalize({
      ...skill,
      id: `sk-${randomUUID()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return this.mutate(skills => { skills.push(structuredClone(newSkill)); return newSkill; });
  }

  async updateSkill(id: string, updates: Partial<SkillInput>): Promise<Skill> {
    const copy = structuredClone(updates);
    return this.mutate(skills => {
      const idx = skills.findIndex(skill => skill.id === id);
      if (idx === -1) throw new Error(`Skill ${id} not found`);
      const updated = this.normalize({ ...skills[idx], ...copy, id, updatedAt: Date.now() });
      skills[idx] = updated;
      return updated;
    });
  }

  async deleteSkill(id: string): Promise<void> {
    await this.mutate(skills => {
      const idx = skills.findIndex(skill => skill.id === id);
      if (idx !== -1) skills.splice(idx, 1);
    });
  }
}
