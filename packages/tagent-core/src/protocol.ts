/**
 * Agent 间通信协议 — plan §3.7
 *
 * 6 种标准化消息类型（参考 A2A Protocol + Hermes-Team）：
 * 1. TaskRequest      父→子: 委派任务
 * 2. TaskProgress     子→父: 进度汇报
 * 3. TaskComplete     子→父: 完成(含摘要)
 * 4. TaskFailed       子→父: 失败汇报
 * 5. GovernanceEvent  治理引擎→Agent
 * 6. HumanInputRequest Agent→用户
 */

// ─── Message Types ───────────────────────────────────

export type AgentMessageType =
  | 'TaskRequest'
  | 'TaskProgress'
  | 'TaskComplete'
  | 'TaskFailed'
  | 'GovernanceEvent'
  | 'HumanInputRequest';

export interface AgentMessage<T = unknown> {
  id: string;
  type: AgentMessageType;
  fromAgent: string;
  toAgent: string;
  timestamp: string;
  payload: T;
}

// ─── Payload Definitions ─────────────────────────────

/** 父→子: 委派任务，含目标、上下文、约束 */
export interface TaskRequestPayload {
  taskId: string;
  objective: string;
  context?: string;
  constraints?: {
    maxCost?: number;
    maxIterations?: number;
    allowedTools?: string[];
    fissionDepth?: number;
  };
}

/** 子→父: 进度汇报，含状态和中间结果 */
export interface TaskProgressPayload {
  taskId: string;
  progress: number; // 0-100
  currentStep: string;
  intermediateResult?: string;
}

/** 子→父: 完成汇报，含摘要结果（隔离上下文+摘要返回 ← Claude Code） */
export interface TaskCompletePayload {
  taskId: string;
  summary: string;          // 精简摘要给父 Agent
  fullResult: string;       // 完整结果（存储用）
  cost: number;
  tokens: { input: number; output: number };
  iterations: number;
}

/** 子→父: 失败汇报，含原因和已尝试方案 */
export interface TaskFailedPayload {
  taskId: string;
  error: string;
  attemptedStrategies: string[];
  partialResult?: string;
}

/** 治理引擎→Agent: 约束检查结果通知 */
export interface GovernanceEventPayload {
  policyType: 'resource' | 'security' | 'quality' | 'alignment' | 'organization';
  severity: 'hard' | 'soft' | 'info';
  result: 'passed' | 'blocked' | 'warning';
  message: string;
  suggestion?: string;
}

/** Agent→用户: 请求用户输入（← Hermes-Team request_human_input） */
export interface HumanInputRequestPayload {
  question: string;
  context: string;
  options?: string[];
  urgency: 'low' | 'medium' | 'high';
}

// ─── Message Bus ─────────────────────────────────────

type MessageHandler = (msg: AgentMessage) => void;

/**
 * Agent 间消息总线
 * 所有 Agent 通信通过此总线进行，支持订阅和广播。
 */
export class MessageBus {
  private handlers = new Map<string, Set<MessageHandler>>();
  private allHandlers = new Set<MessageHandler>();
  private history: AgentMessage[] = [];

  /** 订阅特定 Agent 的消息 */
  subscribe(agentId: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(agentId)) {
      this.handlers.set(agentId, new Set());
    }
    this.handlers.get(agentId)!.add(handler);
    return () => this.handlers.get(agentId)?.delete(handler);
  }

  /** 订阅所有消息（用于 SSE 广播到前端） */
  subscribeAll(handler: MessageHandler): () => void {
    this.allHandlers.add(handler);
    return () => this.allHandlers.delete(handler);
  }

  /** 发送消息 */
  send(msg: AgentMessage): void {
    this.history.push(msg);

    // 通知目标 Agent
    const handlers = this.handlers.get(msg.toAgent);
    if (handlers) {
      for (const h of handlers) h(msg);
    }

    // 通知全局监听器
    for (const h of this.allHandlers) h(msg);
  }

  /** 获取历史消息 */
  getHistory(agentId?: string): AgentMessage[] {
    if (!agentId) return this.history;
    return this.history.filter(m => m.fromAgent === agentId || m.toAgent === agentId);
  }

  /** 创建标准消息 */
  static createMessage<T>(
    type: AgentMessageType,
    fromAgent: string,
    toAgent: string,
    payload: T,
  ): AgentMessage<T> {
    return {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      fromAgent,
      toAgent,
      timestamp: new Date().toISOString(),
      payload,
    };
  }
}
