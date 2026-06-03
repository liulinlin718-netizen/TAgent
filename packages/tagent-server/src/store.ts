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

  forkSession(
    workspaceId: string,
    sourceSessionId: string,
    forkType: 'fork_full' | 'fork_summary',
    summaryText?: string,
  ): Session | null {
    const sourceSession = this.getSession(workspaceId, sourceSessionId);
    if (!sourceSession) return null;

    const newSession = this.createSession(
      workspaceId,
      `${sourceSession.title} (Fork)`,
      forkType,
      sourceSessionId
    );

    if (!newSession) return null;

    if (forkType === 'fork_full') {
      newSession.messages = JSON.parse(JSON.stringify(sourceSession.messages));
    } else if (forkType === 'fork_summary' && summaryText) {
      newSession.messages = [
        {
          id: `msg-${Date.now()}-sys`,
          role: 'assistant',
          content: `**[来自父分支的上下文摘要]**\n\n${summaryText}`,
          timestamp: new Date().toISOString(),
        }
      ];
    }

    return newSession;
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

  /**
   * D3: 结论摘取 — 从 Session 中提取关键结论标记
   * 返回带 [结论] 标记的消息片段，用于合并回主线或引用
   */
  extractConclusions(workspaceId: string, sessionId: string): string[] {
    const session = this.getSession(workspaceId, sessionId);
    if (!session) return [];

    const conclusions: string[] = [];
    for (const msg of session.messages) {
      if (msg.role !== 'assistant') continue;
      // 匹配结论性段落：以「结论」「总结」「关键发现」等开头的段落
      const patterns = [
        /(?:^|\n)(?:#{1,3}\s*)?(?:结论|总结|关键发现|核心结论|建议|摘要)[：:].*/gi,
        /(?:^|\n)\*\*(?:结论|总结|关键发现|核心结论|建议|摘要)\*\*[：:].*/gi,
        /(?:^|\n)(?:综上所述|总而言之|概括来说).*/gi,
      ];
      for (const pattern of patterns) {
        const matches = msg.content.match(pattern);
        if (matches) conclusions.push(...matches.map(m => m.trim()));
      }
      // 如果没有匹配到格式化结论，取最后 200 字作为隐式结论
      if (conclusions.length === 0 && msg === session.messages[session.messages.length - 1]) {
        const lastChunk = msg.content.slice(-200).trim();
        if (lastChunk.length > 20) conclusions.push(`[隐式结论] ${lastChunk}`);
      }
    }
    return conclusions;
  }

  /**
   * D4: 跨 Session 记忆继承 — 获取关联 Session 链的上下文摘要
   * 沿 parentSessionId 链条向上追溯，收集每个祖先的最后一条 assistant 消息
   */
  getSessionMemory(workspaceId: string, sessionId: string, maxDepth: number = 3): string[] {
    const memories: string[] = [];
    let currentId: string | null = sessionId;
    let depth = 0;

    while (currentId && depth < maxDepth) {
      const session = this.getSession(workspaceId, currentId);
      if (!session) break;

      // 收集该 Session 的最后 assistant 消息
      const lastAssistant = [...session.messages]
        .reverse()
        .find(m => m.role === 'assistant');
      if (lastAssistant) {
        memories.unshift(
          `[${session.title}] ${lastAssistant.content.slice(0, 500)}`
        );
      }

      currentId = session.parentSessionId;
      depth++;
    }
    return memories;
  }

  /** V3b.2: 获取 Session 消息列表（供 Diff 视图使用） */
  getMessages(workspaceId: string, sessionId: string): ChatMessage[] {
    const session = this.getSession(workspaceId, sessionId);
    return session?.messages || [];
  }
}

export const store = new Store();
