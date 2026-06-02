/**
 * Workspace 数据模型
 *
 * Workspace = 一个项目/任务空间，包含多个 Session。
 * 对应 plan §4.2 主界面布局中的"工作空间"侧栏。
 *
 * Phase 1 使用内存存储，Phase 2+ 可替换为 SQLite。
 */

export interface Workspace {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  sessions: Session[];
  /** 常驻 Agent 列表（Phase 1: 仅 Research Agent） */
  residentAgents: string[];
}

/**
 * Session 数据模型
 *
 * 对应 plan §3.9 的三种创建方式：
 * ① 新建 Session
 * ② 完整 Fork（基于当前上下文完整复制）
 * ③ 摘要 Fork（基于摘要复制，低成本）
 *
 * Phase 1 实现 ① 新建，②③ 在 Phase 3b 实现。
 */
export interface Session {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 创建方式 */
  creationType: 'new' | 'fork_full' | 'fork_summary';
  /** Fork 来源（如果是 Fork 创建的） */
  parentSessionId: string | null;
  /** 消息历史 */
  messages: ChatMessage[];
  /** 成本统计 */
  totalCost: number;
  totalTokens: { input: number; output: number };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  /** Agent 执行追踪数据 */
  traces?: TraceEvent[];
  /** 成本 */
  cost?: number;
  tokens?: { input: number; output: number };
  iterations?: number;
}

export interface TraceEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

// ─── In-Memory Store (Phase 1) ───────────────────────

class Store {
  private workspaces: Map<string, Workspace> = new Map();

  constructor() {
    // 创建默认 workspace
    this.createWorkspace('默认工作空间', '你的第一个 AI 工作空间');
  }

  // ── Workspace CRUD ──

  createWorkspace(name: string, description: string = ''): Workspace {
    const ws: Workspace = {
      id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessions: [],
      residentAgents: ['research-agent'],
    };
    this.workspaces.set(ws.id, ws);
    return ws;
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  listWorkspaces(): Workspace[] {
    return Array.from(this.workspaces.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  deleteWorkspace(id: string): boolean {
    return this.workspaces.delete(id);
  }

  // ── Session CRUD ──

  createSession(
    workspaceId: string,
    title: string = '新对话',
    creationType: Session['creationType'] = 'new',
    parentSessionId: string | null = null,
  ): Session | null {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return null;

    const session: Session = {
      id: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      workspaceId,
      title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      creationType,
      parentSessionId,
      messages: [],
      totalCost: 0,
      totalTokens: { input: 0, output: 0 },
    };

    ws.sessions.push(session);
    ws.updatedAt = new Date().toISOString();
    return session;
  }

  getSession(workspaceId: string, sessionId: string): Session | undefined {
    const ws = this.workspaces.get(workspaceId);
    return ws?.sessions.find(s => s.id === sessionId);
  }

  listSessions(workspaceId: string): Session[] {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return [];
    return ws.sessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  deleteSession(workspaceId: string, sessionId: string): boolean {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    const idx = ws.sessions.findIndex(s => s.id === sessionId);
    if (idx === -1) return false;
    ws.sessions.splice(idx, 1);
    ws.updatedAt = new Date().toISOString();
    return true;
  }

  addMessage(workspaceId: string, sessionId: string, msg: ChatMessage): void {
    const session = this.getSession(workspaceId, sessionId);
    if (!session) return;
    session.messages.push(msg);
    session.updatedAt = new Date().toISOString();
    if (msg.cost) session.totalCost += msg.cost;
    if (msg.tokens) {
      session.totalTokens.input += msg.tokens.input;
      session.totalTokens.output += msg.tokens.output;
    }
    // Auto-title from first user message
    if (session.messages.length === 1 && msg.role === 'user') {
      session.title = msg.content.slice(0, 30) + (msg.content.length > 30 ? '...' : '');
    }
  }
}

export const store = new Store();
