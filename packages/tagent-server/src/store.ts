import { buildConversationContext, conversationContextReceipt, extractSummary, SummaryForkError, summarySourceHash } from '@tagent/core';
import type { SummaryForkRecord } from '@tagent/core';
import { snapshotContext, type ExecutionSnapshot, type ScheduledOccurrence } from '@tagent/core';
import { isDeepStrictEqual } from 'node:util';
import { validateSummaryRecord } from './summary-forks.js';
import type { ConversationContext, ConversationContextReceipt, SessionQuote, OrchestratorResult, PersistenceAdapter, WorkflowEvent } from '@tagent/core';
import { previewSessionQuote, SessionQuoteError, type QuoteSelection } from './session-quotes.js';

/**
 * Workspace 数据模型
 *
 * Workspace = 一个项目/任务空间，包含多个 Session。
 * 对应 plan §4.2 主界面布局中的"工作空间"侧栏。
 *
 * 服务端在启动时读取存储，写入成功后再发布新的内存状态。
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
  scheduleOrigin?: { occurrenceId: string; jobId: string; dueAt: number; taskMessage: string };
  snapshotOrigin?: { id: string; runId: string; agentId: string; iteration: number; timestamp: string };
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
  summaryForks?: SummaryForkRecord[];
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
  /** Source passages and per-finding review remain available after session reload. */
  research?: OrchestratorResult['research'];
  deliveryReview?: OrchestratorResult['deliveryReview'];
  run?: { id: string; status: 'running' | 'finished' | 'interrupted'; startedAt: string; completedAt?: string; context?: ConversationContextReceipt };
  quote?: SessionQuote;
  contextKind?: 'fork_summary';
}

export class ActiveRunError extends Error {
  constructor() { super('任务仍在运行或等待恢复，请先停止任务并等待保存完成。'); }
}

export function sessionIsBusy(session: Session): boolean {
  return session.messages.some(message => message.run?.status === 'running')
    || !!session.summaryForks?.some(record => ['running', 'ready'].includes(record.status));
}

export type TraceEvent = WorkflowEvent & {
  data: Record<string, unknown>;
};

// Workspace state and serialized durable mutations.

export class Store {
  private workspaces: Map<string, Workspace> = new Map();

  private persistence?: PersistenceAdapter;
  private pending: Promise<unknown> = Promise.resolve();
  private revision = 0;

  getRevision(): number { return this.revision; }
  hasSession(workspaceId: string, sessionId: string): boolean {
    return !!this.workspaces.get(workspaceId)?.sessions.some(session => session.id === sessionId);
  }

  constructor(seed = true) {
    if (seed) this.createWorkspaceDraft('默认工作空间', '你的第一个 AI 工作空间');
  }

  static async open(persistence: PersistenceAdapter): Promise<Store> {
    const store = new Store();
    const saved = await persistence.load<unknown>('workspaces', null);
    if (saved !== null) {
      validateWorkspaces(saved);
      store.workspaces = new Map(saved.map(ws => [ws.id, ws]));
    } else {
      await persistence.save('workspaces', store.listWorkspaces());
    }
    store.persistence = persistence;
    return store;
  }

  // A failed write cannot leak uncommitted changes or block subsequent writes.
  private commit<T>(change: (draft: Store) => T): Promise<T> {
    const operation = this.pending.then(async () => {
      const draft = new Store(false);
      draft.workspaces = structuredClone(this.workspaces);
      const result = change(draft);
      if (this.persistence) await this.persistence.save('workspaces', draft.listWorkspaces());
      this.workspaces = draft.workspaces;
      this.revision++;
      return structuredClone(result);
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  createWorkspace(name: string, description = ''): Promise<Workspace> {
    return this.commit(draft => draft.createWorkspaceDraft(name, description));
  }

  deleteWorkspace(id: string): Promise<boolean> {
    return this.commit(draft => draft.deleteWorkspaceDraft(id));
  }

  createSession(workspaceId: string, title = '新对话', creationType: Session['creationType'] = 'new', parentSessionId: string | null = null): Promise<Session | null> {
    return this.commit(draft => draft.createSessionDraft(workspaceId, title, creationType, parentSessionId));
  }

  forkSession(workspaceId: string, sourceSessionId: string, forkType: 'fork_full' | 'fork_summary', summaryText?: string): Promise<Session | null> {
    return this.commit(draft => draft.forkSessionDraft(workspaceId, sourceSessionId, forkType, summaryText));
  }

  forkExecutionSnapshot(input: ExecutionSnapshot): Promise<Session> {
    const snapshot = structuredClone(input);
    return this.commit(draft => {
      const source = draft.getSession(snapshot.workspaceId, snapshot.sessionId);
      if (!source || !source.messages.some(message => message.run?.id === snapshot.runId)) throw new Error('快照来源任务不存在。');
      const existing = draft.listSessions(snapshot.workspaceId).find(session => session.parentSessionId === source.id && session.snapshotOrigin?.id === snapshot.id);
      if (existing) return existing;
      const branch = draft.createSessionDraft(snapshot.workspaceId, `${source.title} · 第${snapshot.iteration}轮快照`, 'fork_full', source.id);
      if (!branch) throw new Error('工作空间不存在。');
      branch.snapshotOrigin = { id: snapshot.id, runId: snapshot.runId, agentId: snapshot.agentId,
        iteration: snapshot.iteration, timestamp: snapshot.timestamp };
      branch.messages = [{ id: `${snapshot.id}-context`, role: 'assistant', content: snapshotContext(snapshot),
        timestamp: new Date().toISOString(), contextKind: 'fork_summary', traces: [] }];
      return branch;
    });
  }

  prepareScheduledSession(input: ScheduledOccurrence): Promise<Session> {
    const occurrence = structuredClone(input);
    return this.commit(draft => {
      const existing = draft.listSessions(occurrence.workspaceId).find(session => session.scheduleOrigin?.occurrenceId === occurrence.id);
      if (existing) return existing;
      if (occurrence.status === 'prepared') throw new Error('原待办会话已删除，不自动重建。');
      const session = draft.createSessionDraft(occurrence.workspaceId, occurrence.name, 'new', null);
      if (!session) throw new Error('工作空间不存在。');
      session.scheduleOrigin = { occurrenceId: occurrence.id, jobId: occurrence.jobId, dueAt: occurrence.dueAt, taskMessage: occurrence.taskMessage };
      return session;
    });
  }

  deleteSession(workspaceId: string, sessionId: string): Promise<boolean> {
    return this.commit(draft => draft.deleteSessionDraft(workspaceId, sessionId));
  }

  addMessage(workspaceId: string, sessionId: string, msg: ChatMessage): Promise<void> {
    const message = structuredClone(msg);
    return this.commit(draft => draft.addMessageDraft(workspaceId, sessionId, message));
  }

  beginRun(workspaceId: string, sessionId: string, runId: string, content: string): Promise<ConversationContext> {
    if (!/^run-[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Invalid run ID');
    return this.commit(draft => {
      if (draft.findRun(runId)) throw new Error('Run already exists');
      const session = draft.getSession(workspaceId, sessionId);
      if (session && sessionIsBusy(session)) {
        throw new ActiveRunError();
      }
      const timestamp = new Date().toISOString();
      const context = buildConversationContext(workspaceId, sessionId, draft.getMessages(workspaceId, sessionId));
      draft.addMessageDraft(workspaceId, sessionId, {
        id: `${runId}-user`, role: 'user', content, timestamp,
      });
      draft.addMessageDraft(workspaceId, sessionId, {
        id: `${runId}-assistant`, role: 'assistant', timestamp,
        content: '任务已接收，尚未生成最终结果。',
        run: { id: runId, status: 'running', startedAt: timestamp, context: conversationContextReceipt(context) },
      });
      return context;
    });
  }

  quoteToParent(workspaceId: string, sourceSessionId: string, selection: QuoteSelection) {
    const input = structuredClone(selection);
    return this.commit(draft => {
      if (input.confirmed !== true) throw new SessionQuoteError('保存引用需要用户确认。', 400);
      const source = draft.getSession(workspaceId, sourceSessionId);
      const parent = source?.parentSessionId ? draft.getSession(workspaceId, source.parentSessionId) : undefined;
      if ((source && sessionIsBusy(source)) || (parent && sessionIsBusy(parent))) throw new ActiveRunError();
      const preview = previewSessionQuote(source, parent, input);
      if (input.fingerprint !== preview.fingerprint) throw new SessionQuoteError('引用来源已变化，请重新预览。', 409);
      const id = `quote-${preview.fingerprint}`;
      const existing = parent!.messages.find(message => message.id === id);
      if (existing) return { ok: true, parentSessionId: parent!.id, message: existing, created: false };
      const message: ChatMessage = { id, role: 'assistant', content: preview.text, quote: preview.quote, timestamp: preview.quote.quotedAt, traces: [] };
      draft.addMessageDraft(workspaceId, parent!.id, message);
      return { ok: true, parentSessionId: parent!.id, message, created: true };
    });
  }

  findRun(runId: string) {
    for (const ws of this.workspaces.values()) for (const session of ws.sessions) {
      const message = session.messages.find(msg => msg.run?.id === runId);
      if (message) return structuredClone({ workspaceId: ws.id, sessionId: session.id, message });
    }
    return undefined;
  }

  listSummaryForks() {
    return this.listWorkspaces().flatMap(workspace => workspace.sessions.flatMap(session => session.summaryForks || []));
  }

  beginSummaryFork(input: SummaryForkRecord) {
    const record = structuredClone(input);
    return this.commit(draft => {
      validateSummaryRecord(record);
      const source = draft.workspaces.get(record.workspaceId)?.sessions.find(session => session.id === record.sourceSessionId);
      if (!source) throw new SummaryForkError('来源会话不存在。', 404);
      if (draft.listSummaryForks().some(item => item.id === record.id)) throw new SummaryForkError('摘要操作已存在。', 409);
      if (sessionIsBusy(source)) throw new ActiveRunError();
      if ((source.summaryForks?.length || 0) >= 20) throw new SummaryForkError('此会话已达到20条摘要操作记录上限，请保留历史并使用完整 Fork。', 409);
      if (summarySourceHash(source.messages) !== record.preview.sourceHash || record.status !== 'running') throw new SummaryForkError('来源历史已变化，请重新预览。', 409);
      source.summaryForks = [...(source.summaryForks || []), record];
      source.updatedAt = new Date().toISOString();
      return record;
    });
  }

  recordSummaryResult(input: SummaryForkRecord) {
    const record = structuredClone(input);
    return this.commit(draft => {
      validateSummaryRecord(record);
      const source = draft.workspaces.get(record.workspaceId)?.sessions.find(session => session.id === record.sourceSessionId);
      const previous = source?.summaryForks?.find(item => item.id === record.id);
      if (!source || !previous) throw new SummaryForkError('摘要操作不存在。', 404);
      if (isDeepStrictEqual(previous, record)) return previous;
      if (!['running', 'ready'].includes(previous.status) || record.status === 'running' || record.status === 'completed'
        || previous.targetSessionId !== record.targetSessionId || !isDeepStrictEqual(previous.preview, record.preview)
        || (previous.status === 'ready' && record.status !== 'interrupted')) throw new SummaryForkError('摘要操作状态不允许覆盖。', 409);
      source.totalCost += record.usage.knownCost - previous.usage.knownCost;
      source.totalTokens.input += record.usage.input - previous.usage.input;
      source.totalTokens.output += record.usage.output - previous.usage.output;
      source.summaryForks![source.summaryForks!.indexOf(previous)] = record;
      source.updatedAt = new Date().toISOString();
      return record;
    });
  }

  completeSummaryFork(workspaceId: string, sourceSessionId: string, id: string) {
    return this.commit(draft => {
      const source = draft.workspaces.get(workspaceId)?.sessions.find(session => session.id === sourceSessionId);
      const record = source?.summaryForks?.find(item => item.id === id);
      if (!source || !record) throw new SummaryForkError('摘要操作不存在。', 404);
      if (record.status === 'completed') return record;
      if (record.status !== 'ready' || !record.output || summarySourceHash(source.messages) !== record.preview.sourceHash) throw new SummaryForkError('摘要尚未就绪或来源已变化，未创建分支。', 409);
      const checked = extractSummary(JSON.stringify({ excerpts: record.excerpts }), source.messages, record.preview.inputMessageIds);
      if (checked.output !== record.output || !isDeepStrictEqual(checked.excerpts, record.excerpts)
        || record.preview.preservedMessageIds.some(id => !source.messages.some(message => message.id === id))
        || draft.getSession(workspaceId, record.targetSessionId)) throw new SummaryForkError('摘要来源或目标记录不一致，未覆盖已有会话。', 409);
      const child = draft.createSessionDraft(workspaceId, `${source.title} (摘要分支)`, 'fork_summary', source.id)!;
      child.id = record.targetSessionId;
      child.messages = [{ id: `${record.id}-summary`, role: 'assistant', content: record.output, contextKind: 'fork_summary', timestamp: new Date().toISOString() },
        ...source.messages.filter(message => record.preview.preservedMessageIds.includes(message.id)).map(({ run: _run, ...message }) => structuredClone(message))];
      record.status = 'completed'; record.completedAt = Date.now();
      source.updatedAt = new Date().toISOString();
      return record;
    });
  }

  listRuns() {
    return this.listWorkspaces().flatMap(ws => ws.sessions.flatMap(session => session.messages
      .filter(message => message.run).map(message => ({ workspaceId: ws.id, sessionId: session.id, message }))));
  }

  finishRun(workspaceId: string, sessionId: string, runId: string, message: ChatMessage): Promise<void> {
    const saved = structuredClone(message);
    return this.commit(draft => {
      const ws = draft.workspaces.get(workspaceId);
      const session = ws?.sessions.find(item => item.id === sessionId);
      const previous = session?.messages.find(item => item.run?.id === runId);
      if (!ws || !session || !previous?.run) throw new Error('Run receipt not found');
      if (previous.run.status !== 'running') return;
      if (saved.role !== 'assistant' || saved.run?.id !== runId || saved.run.status === 'running'
        || saved.id !== previous.id) throw new Error('Invalid final run message');
      session.totalCost += (saved.cost || 0) - (previous.cost || 0);
      session.totalTokens.input += (saved.tokens?.input || 0) - (previous.tokens?.input || 0);
      session.totalTokens.output += (saved.tokens?.output || 0) - (previous.tokens?.output || 0);
      session.messages[session.messages.indexOf(previous)] = saved;
      session.updatedAt = ws.updatedAt = new Date().toISOString();
    });
  }

  // ── Workspace CRUD ──

  private createWorkspaceDraft(name: string, description: string = ''): Workspace {
    const ws: Workspace = {
      id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessions: [],
      residentAgents: ['research-agent', 'document-agent', 'data-agent', 'project-agent', 'communication-agent', 'presentation-agent'],
    };
    this.workspaces.set(ws.id, ws);
    return ws;
  }

  getWorkspace(id: string): Workspace | undefined {
    return structuredClone(this.workspaces.get(id));
  }

  listWorkspaces(): Workspace[] {
    return structuredClone(Array.from(this.workspaces.values())).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  private deleteWorkspaceDraft(id: string): boolean {
    if (this.workspaces.get(id)?.sessions.some(sessionIsBusy)) {
      throw new ActiveRunError();
    }
    return this.workspaces.delete(id);
  }

  // ── Session CRUD ──

  private createSessionDraft(
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
    return structuredClone(ws?.sessions.find(s => s.id === sessionId));
  }

  private forkSessionDraft(
    workspaceId: string,
    sourceSessionId: string,
    forkType: 'fork_full' | 'fork_summary',
    summaryText?: string,
  ): Session | null {
    const sourceSession = this.getSession(workspaceId, sourceSessionId);
    if (!sourceSession) return null;
    if (sessionIsBusy(sourceSession)) throw new ActiveRunError();

    const newSession = this.createSessionDraft(
      workspaceId,
      `${sourceSession.title} (Fork)`,
      forkType,
      sourceSessionId
    );

    if (!newSession) return null;

    if (forkType === 'fork_full') {
      // A branch inherits history, never ownership of another session's active run.
      newSession.messages = sourceSession.messages.map(({ run: _run, ...message }) => message);
    } else if (forkType === 'fork_summary' && summaryText) {
      newSession.messages = [
        {
          id: `msg-${Date.now()}-sys`,
          role: 'assistant',
          content: `**[来自父分支的上下文摘要]**\n\n${summaryText}`,
          contextKind: 'fork_summary',
          timestamp: new Date().toISOString(),
        }
      ];
    }

    return newSession;
  }

  listSessions(workspaceId: string): Session[] {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return [];
    return structuredClone(ws.sessions).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  private deleteSessionDraft(workspaceId: string, sessionId: string): boolean {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    const idx = ws.sessions.findIndex(s => s.id === sessionId);
    if (idx === -1) return false;
    if (sessionIsBusy(ws.sessions[idx])) throw new ActiveRunError();
    ws.sessions.splice(idx, 1);
    ws.updatedAt = new Date().toISOString();
    return true;
  }

  private addMessageDraft(workspaceId: string, sessionId: string, msg: ChatMessage): void {
    const ws = this.workspaces.get(workspaceId);
    const session = ws?.sessions.find(s => s.id === sessionId);
    if (!session || !ws) throw new Error('Session not found');
    ws.updatedAt = new Date().toISOString();
    session.messages.push(msg);
    session.updatedAt = new Date().toISOString();
    if (msg.cost) session.totalCost += msg.cost;
    if (msg.tokens) {
      session.totalTokens.input += msg.tokens.input;
      session.totalTokens.output += msg.tokens.output;
    }
    // Auto-title from first user message
    if (session.messages.length === 1 && msg.role === 'user') {
      const titleChars = Array.from(msg.content);
      session.title = titleChars.slice(0, 30).join('') + (titleChars.length > 30 ? '...' : '');
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
      if (msg.role !== 'assistant' || msg.run?.status === 'running') continue;
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
        .find(m => m.role === 'assistant' && m.run?.status !== 'running');
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

function validateWorkspaces(value: unknown): asserts value is Workspace[] {
  if (!Array.isArray(value)) throw new Error('Invalid workspace storage');
  const ids = new Set<string>();
  const runIds = new Set<string>();
  const summaryIds = new Set<string>();
  for (const ws of value) {
    if (!ws || typeof ws.id !== 'string' || ids.has(ws.id) || typeof ws.name !== 'string'
      || typeof ws.description !== 'string' || typeof ws.createdAt !== 'string' || typeof ws.updatedAt !== 'string'
      || !Array.isArray(ws.residentAgents) || !Array.isArray(ws.sessions)) throw new Error('Invalid workspace storage');
    ids.add(ws.id);
    const sessionIds = new Set<string>();
    for (const session of ws.sessions) {
      if (!session || typeof session.id !== 'string' || sessionIds.has(session.id) || session.workspaceId !== ws.id
        || typeof session.title !== 'string' || !Array.isArray(session.messages)
        || !Number.isFinite(session.totalCost) || !Number.isFinite(session.totalTokens?.input)
        || !Number.isFinite(session.totalTokens?.output)) throw new Error('Invalid session storage');
      sessionIds.add(session.id);
      if (session.snapshotOrigin && (typeof session.snapshotOrigin.id !== 'string' || typeof session.snapshotOrigin.runId !== 'string'
        || typeof session.snapshotOrigin.agentId !== 'string' || !Number.isInteger(session.snapshotOrigin.iteration)
        || session.snapshotOrigin.iteration < 1 || !Number.isFinite(Date.parse(session.snapshotOrigin.timestamp))))
        throw new Error('Invalid snapshot branch origin');
      if (session.scheduleOrigin && (typeof session.scheduleOrigin.occurrenceId !== 'string' || typeof session.scheduleOrigin.jobId !== 'string'
        || typeof session.scheduleOrigin.taskMessage !== 'string' || !Number.isFinite(session.scheduleOrigin.dueAt)))
        throw new Error('Invalid scheduled session origin');
      if (session.summaryForks !== undefined) {
        if (!Array.isArray(session.summaryForks) || session.summaryForks.length > 20) throw new Error('Invalid summary fork storage');
        for (const record of session.summaryForks) {
          validateSummaryRecord(record);
          if (record.workspaceId !== ws.id || record.sourceSessionId !== session.id || summaryIds.has(record.id)) throw new Error('Invalid summary fork scope');
          summaryIds.add(record.id);
        }
      }
      for (const msg of session.messages) {
        if (!msg || typeof msg.id !== 'string' || typeof msg.content !== 'string'
          || !['user', 'assistant'].includes(msg.role) || typeof msg.timestamp !== 'string') throw new Error('Invalid message storage');
        if (msg.run !== undefined) {
          if (!msg.run || msg.role !== 'assistant' || typeof msg.run.id !== 'string'
            || !/^run-[a-zA-Z0-9-]+$/.test(msg.run.id) || runIds.has(msg.run.id)
            || !['running', 'finished', 'interrupted'].includes(msg.run.status)
            || typeof msg.run.startedAt !== 'string') throw new Error('Invalid run storage');
          runIds.add(msg.run.id);
        }
      }
    }
  }
}
