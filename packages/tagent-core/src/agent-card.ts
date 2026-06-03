/**
 * Agent Card — 标准化身份描述 (plan §3.5)
 *
 * 4 维状态模型（← Hermes-Team）:
 *   business          → 工作流节点动画
 *   runtime           → 健康状态指示灯
 *   human_interaction → 弹出用户决策卡片
 *   orchestration     → 节点展开显示子 Agent 树
 *
 * 三级审批模式（← Codex CLI）:
 *   suggest / auto_edit / full_auto
 */

// ─── Agent Card ──────────────────────────────────────

export interface AgentCard {
  id: string;
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
    maxCostPerTask: number;     // USD
    allowedTools: string[];
    approvalMode: ApprovalMode;
    /** URL 域名白名单（D12 安全协议）— 空数组=不限制 */
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
}

/** 三级审批模式 (← Codex CLI) */
export type ApprovalMode = 'suggest' | 'auto_edit' | 'full_auto';

/** 4 维状态模型 (← Hermes-Team) */
export interface AgentState {
  business: 'idle' | 'busy' | 'waiting';
  runtime: 'running' | 'stopped' | 'error';
  humanInteraction: 'idle' | 'waiting_human';
  orchestration: 'none' | 'waiting_workers' | 'fissioned';
}

// ─── State Helpers ───────────────────────────────────

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

// ─── Agent Card Factory ──────────────────────────────

export function createAgentCard(
  partial: Partial<AgentCard> & Pick<AgentCard, 'id' | 'name' | 'type' | 'description' | 'icon'>,
): AgentCard {
  return {
    capabilities: { skills: [], tools: ['web_search', 'read_url'], mcpServers: [] },
    constraints: {
      maxFissionDepth: 2,
      maxCostPerTask: 0.5,
      allowedTools: ['web_search', 'read_url'],
      approvalMode: 'full_auto',
      allowedDomains: [],
    },
    state: createIdleState(),
    stats: { tasksCompleted: 0, totalCost: 0, avgIterations: 0 },
    parentAgentId: null,
    childAgentIds: [],
    ...partial,
  };
}
