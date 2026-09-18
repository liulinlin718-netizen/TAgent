export type ApprovalMode = 'suggest' | 'auto_edit' | 'full_auto';

export interface AgentState {
  business: 'idle' | 'busy' | 'waiting';
  runtime: 'running' | 'stopped' | 'error';
  humanInteraction: 'idle' | 'waiting_human';
  orchestration: 'none' | 'waiting_workers' | 'fissioned';
}

export interface AgentScoreProfile {
  research: number;
  writing: number;
  data: number;
  planning: number;
  communication: number;
  presentation: number;
  governance: number;
  tooling: number;
  estimatedScore?: AgentScoreSnapshot;
  benchmarkScore?: AgentScoreSnapshot;
  benchmarkMetadata?: AgentBenchmarkMetadata;
}

export interface AgentScoreSnapshot {
  totalScore: number;
  dimensions: Record<string, number>;
  source: 'estimated' | 'benchmark';
}

export interface AgentBenchmarkMetadata {
  suiteId: string;
  suiteVersion: string;
  runId?: string;
  sampleCount: number;
  passRate: number;
  evaluatedAt: number;
  weakDimensions: string[];
  recommendations: string[];
}

export type AgentExecutionStage = 'understand' | 'plan' | 'execute' | 'verify' | 'synthesize' | 'handoff';

export interface AgentCapabilityGraph {
  domains: string[];
  primarySkills: string[];
  toolAffordances: string[];
  mcpAffordances: string[];
  handoffTargets: string[];
}

export interface AgentRuntimeProfile {
  planner: 'reactive' | 'plan_execute' | 'reflect_repair';
  executor: 'tool_first' | 'browser_enabled' | 'document_generator' | 'analysis_first';
  verifier: string[];
  toolPolicy: string[];
  memoryPolicy: string[];
  handoffPolicy: string[];
  fallbackPolicy: string[];
  artifactSchemas: string[];
  stages: AgentExecutionStage[];
}

export interface AgentCardV2 {
  version: 'v2';
  soul: string;
  responsibilities: string[];
  boundaries: string[];
  mcpPreferences: string[];
  qualityChecks: string[];
  fallbackStrategy: string;
  exampleTasks: string[];
  outputStandards: string[];
  scoreProfile: AgentScoreProfile;
  capabilityGraph: AgentCapabilityGraph;
  runtimeProfile: AgentRuntimeProfile;
}

export interface TaskAgentSpawnMeta {
  workspaceId?: string;
  parentName?: string;
  depth?: number;
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  completedAt?: number;
  result?: { output: string; success: boolean; cost: number; iterations: number; tokens: { input: number; output: number } };
  sessionId?: string;
  runId?: string;
  taskId?: string;
  objective: string;
  createdReason: string;
  inputSummary?: string;
  outputSummary?: string;
  createdAt: number;
  promotedAgentId?: string;
  promotedAt?: number;
}

export interface AgentCard {
  id: string;
  configurationRevision?: number;
  name: string;
  type: 'resident' | 'task_spawned';
  description: string;
  icon: string;

  capabilities: {
    skills: string[];
    tools: string[];
    mcpServers: string[];
  };

  constraints: {
    maxFissionDepth: number;
    maxCostPerTask: number;
    allowedTools: string[];
    approvalMode: ApprovalMode;
    allowedDomains: string[];
  };

  state: AgentState;

  stats: {
    tasksCompleted: number;
    totalCost: number;
    avgIterations: number;
  };

  parentAgentId: string | null;
  childAgentIds: string[];
  spawnMeta?: TaskAgentSpawnMeta;

  card: AgentCardV2;
}

export function createIdleState(): AgentState {
  return {
    business: 'idle',
    runtime: 'running',
    humanInteraction: 'idle',
    orchestration: 'none',
  };
}

export function createBusyState(): AgentState {
  return {
    business: 'busy',
    runtime: 'running',
    humanInteraction: 'idle',
    orchestration: 'none',
  };
}

export function createOrchestrationState(): AgentState {
  return {
    business: 'busy',
    runtime: 'running',
    humanInteraction: 'idle',
    orchestration: 'waiting_workers',
  };
}

export const defaultScoreProfile: AgentScoreProfile = {
  research: 50,
  writing: 50,
  data: 50,
  planning: 50,
  communication: 50,
  presentation: 50,
  governance: 60,
  tooling: 55,
};

export const defaultCapabilityGraph: AgentCapabilityGraph = {
  domains: ['office-work'],
  primarySkills: ['task-briefing', 'structured-output', 'quality-review'],
  toolAffordances: ['web_research', 'web_search', 'read_url'],
  mcpAffordances: [],
  handoffTargets: ['research-agent', 'document-agent', 'data-agent', 'project-agent'],
};

export const defaultRuntimeProfile: AgentRuntimeProfile = {
  planner: 'plan_execute',
  executor: 'tool_first',
  verifier: [
    'Check the answer responds to the user task.',
    'Separate facts, assumptions, risks, and recommendations.',
    'Return a readable fallback report when evidence or tools are insufficient.',
  ],
  toolPolicy: [
    'Use only tools present in allowedTools.',
    'Prefer preview-only behavior for external install, write, send, or delete actions.',
    'Do not expand permissions beyond the agent card.',
  ],
  memoryPolicy: [
    'Use only the current task, explicit session context, and verified tool results.',
    'Do not invent private workspace facts.',
  ],
  handoffPolicy: [
    'Summarize confirmed facts, assumptions, open questions, and downstream next steps.',
    'Keep handoff concise enough for another agent to continue safely.',
  ],
  fallbackPolicy: [
    'If a tool fails, explain the failure and continue with verified partial information.',
    'If freshness cannot be verified, mark the result as unverified or background only.',
  ],
  artifactSchemas: ['summary', 'evidence', 'analysis', 'risks', 'next_steps'],
  stages: ['understand', 'plan', 'execute', 'verify', 'synthesize', 'handoff'],
};

export function createDefaultAgentCardV2(partial?: Partial<AgentCardV2>): AgentCardV2 {
  return {
    version: 'v2',
    soul: '',
    responsibilities: [],
    boundaries: [],
    mcpPreferences: [],
    qualityChecks: [],
    fallbackStrategy: '当信息不足或工具失败时，说明不确定性，保留已验证事实并给出下一步建议。',
    exampleTasks: [],
    outputStandards: ['结构清晰', '事实与判断分开', '列出可验证来源或依据'],
    ...partial,
    scoreProfile: {
      ...defaultScoreProfile,
      ...(partial?.scoreProfile || {}),
    },
    capabilityGraph: {
      ...defaultCapabilityGraph,
      ...(partial?.capabilityGraph || {}),
      domains: partial?.capabilityGraph?.domains || defaultCapabilityGraph.domains,
      primarySkills: partial?.capabilityGraph?.primarySkills || defaultCapabilityGraph.primarySkills,
      toolAffordances: partial?.capabilityGraph?.toolAffordances || defaultCapabilityGraph.toolAffordances,
      mcpAffordances: partial?.capabilityGraph?.mcpAffordances || defaultCapabilityGraph.mcpAffordances,
      handoffTargets: partial?.capabilityGraph?.handoffTargets || defaultCapabilityGraph.handoffTargets,
    },
    runtimeProfile: {
      ...defaultRuntimeProfile,
      ...(partial?.runtimeProfile || {}),
      verifier: partial?.runtimeProfile?.verifier || defaultRuntimeProfile.verifier,
      toolPolicy: partial?.runtimeProfile?.toolPolicy || defaultRuntimeProfile.toolPolicy,
      memoryPolicy: partial?.runtimeProfile?.memoryPolicy || defaultRuntimeProfile.memoryPolicy,
      handoffPolicy: partial?.runtimeProfile?.handoffPolicy || defaultRuntimeProfile.handoffPolicy,
      fallbackPolicy: partial?.runtimeProfile?.fallbackPolicy || defaultRuntimeProfile.fallbackPolicy,
      artifactSchemas: partial?.runtimeProfile?.artifactSchemas || defaultRuntimeProfile.artifactSchemas,
      stages: partial?.runtimeProfile?.stages || defaultRuntimeProfile.stages,
    },
  };
}

export function createAgentCard(
  partial: Omit<Partial<AgentCard>, 'card'> &
    Pick<AgentCard, 'id' | 'name' | 'type' | 'description' | 'icon'> &
    { card?: Partial<AgentCardV2> },
): AgentCard {
  const capabilities = {
    skills: [],
    tools: ['web_research', 'web_search', 'read_url'],
    mcpServers: [],
    ...(partial.capabilities || {}),
  };

  const constraints = {
    maxFissionDepth: 2,
    maxCostPerTask: 0.5,
    allowedTools: ['web_research', 'web_search', 'read_url'],
    approvalMode: 'full_auto' as ApprovalMode,
    allowedDomains: [],
    ...(partial.constraints || {}),
  };

  return {
    ...partial,
    capabilities,
    constraints,
    state: partial.state || createIdleState(),
    stats: partial.stats || { tasksCompleted: 0, totalCost: 0, avgIterations: 0 },
    parentAgentId: partial.parentAgentId ?? null,
    childAgentIds: partial.childAgentIds || [],
    spawnMeta: partial.spawnMeta,
    card: createDefaultAgentCardV2(partial.card),
  };
}
