import { createStore } from 'zustand/vanilla';
import { API_BASE, apiFetch } from './api-client';
import { consumeRunStream } from './run-stream';
import { combineTaskDraft } from './task-brief';
import type { TraceEvent } from '../app/WorkflowDrawer.logic';
import type { ResearchRecord } from '../components/ResearchReview.logic';
import type { OfficeDeliveryReview, ConversationContextReceipt, SessionQuote, SummaryForkRecord } from '@tagent/core';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  traces: TraceEvent[];
  cost?: number;
  tokens?: { input: number; output: number };
  iterations?: number;
  research?: ResearchRecord;
  deliveryReview?: OfficeDeliveryReview;
  isStreaming?: boolean;
  persisted?: boolean;
  run?: { id: string; status: 'running' | 'finished' | 'interrupted'; context?: ConversationContextReceipt };
  quote?: SessionQuote;
  contextKind?: 'fork_summary';
}
export interface Session {
  scheduleOrigin?: { occurrenceId: string; jobId: string; dueAt: number; taskMessage: string };
  id: string; title: string; creationType: string; parentSessionId: string | null;
  messages: ChatMessage[]; totalCost: number; updatedAt: string;
  summaryForks?: Array<Pick<SummaryForkRecord, 'status'>>;
}
export interface Workspace {
  id: string; name: string; description: string; sessions: Session[]; residentAgents: string[];
}
export interface ConversationRun {
  clientId: string; runId?: string; phase: 'starting' | 'running' | 'stopping' | 'finished';
  stopError?: string; persisted?: boolean;
}
export interface ConversationEntry {
  messages: ChatMessage[]; draft: string; revision: number;
  loading: boolean; error: string; run?: ConversationRun;
  historyBefore?: number | null; loadingOlder?: boolean;
}
interface ConversationState {
  workspaces: Workspace[]; activeWsId: string; activeSessId: string;
  entries: Record<string, ConversationEntry>; workspaceError: string;
}
export const emptyConversation: ConversationEntry = { messages: [], draft: '', revision: 0, loading: false, error: '' };
export const conversationKey = (workspaceId: string, sessionId: string) => JSON.stringify([workspaceId, sessionId]);
export const runIsActive = (run?: ConversationRun) => !!run && run.phase !== 'finished';

const readable = (text: string, fallback: string) => text && !text.includes('\uFFFD') ? text : fallback;
const titleFrom = (text: string) => Array.from(text).slice(0, 30).join('') + (Array.from(text).length > 30 ? '...' : '');
export function normalizeSession(session: Session): Session {
  return { ...session, title: readable(session.title, titleFrom(session.messages?.find(message => message.role === 'user'
    && !message.content.includes('\uFFFD'))?.content || '历史对话')),
    messages: (session.messages || []).map(message => ({ ...message, traces: message.traces || [],
      content: readable(message.content, message.role === 'user' ? '历史用户消息编码异常，原文不可恢复。' : '历史回复编码异常，原文不可恢复。') })) };
}

type RunEvent = { type: string; data: Record<string, unknown> };
function assertRunEvent(type: string, data: Record<string, unknown>, runId?: string, sessionId?: string) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('任务事件格式无效');
  if ((data.runId && data.runId !== runId) || (data.sessionId && data.sessionId !== sessionId)) {
    throw new Error('收到不属于当前任务的事件，已停止接收');
  }
  const field = type === 'text_delta' ? 'text' : type === 'complete' ? 'output' : undefined;
  if (field && data[field] !== undefined && typeof data[field] !== 'string') throw new Error('任务回复的文字格式无效');
}
export function applyRunEvents(message: ChatMessage, events: RunEvent[], runId?: string, sessionId?: string): ChatMessage {
  let next = message, traces: TraceEvent[] | undefined, seen: Set<unknown> | undefined;
  for (const { type, data } of events) {
    assertRunEvent(type, data, runId, sessionId);
    if (type === 'workflow_event') {
      seen ??= new Set(message.traces.map(trace => trace.eventId).filter(Boolean));
      if (data.eventId && seen.has(data.eventId)) continue;
      if (data.eventId) seen.add(data.eventId);
      traces ??= [...message.traces];
      traces.push(data as unknown as TraceEvent);
    } else if (type === 'text_delta') next = { ...next, content: next.content + String(data.text || '') };
    else if (type === 'complete') next = { ...next, content: String(data.output || '')
      + (data.persisted === false ? '\n\n> **保存失败**：请保留当前内容，不要刷新页面。' : ''),
      cost: data.totalCost as number, tokens: data.totalTokens as ChatMessage['tokens'], iterations: data.iterations as number,
      research: data.research as ResearchRecord | undefined, deliveryReview: data.deliveryReview as OfficeDeliveryReview | undefined,
      isStreaming: false, persisted: data.persisted !== false,
      run: runId ? { id: runId, status: 'finished' } : undefined };
    // Legacy callbacks must not duplicate the canonical WorkflowEvent stream.
  }
  return traces ? { ...next, traces } : next;
}
export function applyRunEvent(message: ChatMessage, type: string, data: Record<string, unknown>, runId?: string, sessionId?: string): ChatMessage {
  return applyRunEvents(message, [{ type, data }], runId, sessionId);
}

export function reconcileMessages(saved: ChatMessage[], local: ChatMessage[]): ChatMessage[] {
  const pending = new Map(local.filter(message => message.persisted === false).map(message => [message.id, message]));
  const merged = saved.map(message => pending.has(message.id) && message.run?.status === 'running'
    ? pending.get(message.id)! : message);
  for (let index = 0; index < local.length; index++) {
    const message = local[index]!;
    if (message.persisted !== false || merged.some(item => item.id === message.id)) continue;
    const before = local.slice(0, index).reverse().find(item => merged.some(candidate => candidate.id === item.id));
    const after = local.slice(index + 1).find(item => merged.some(candidate => candidate.id === item.id));
    const position = before ? merged.findIndex(item => item.id === before.id) + 1
      : after ? merged.findIndex(item => item.id === after.id) : merged.length;
    merged.splice(position, 0, message);
  }
  return merged;
}

export function createConversationStore(request = apiFetch, base = API_BASE) {
  const initial = (): ConversationState => ({ workspaces: [], activeWsId: '', activeSessId: '', entries: {}, workspaceError: '' });
  const store = createStore<ConversationState>(() => initial());
  const controllers = new Map<string, AbortController>();
  const reads = new Map<string, number>();
  let epoch = 0, navigation = 0, workspaceRead = 0;
  const entry = (key: string) => store.getState().entries[key] || emptyConversation;
  const update = (key: string, change: (previous: ConversationEntry) => ConversationEntry) => {
    store.setState(state => {
      const previous = entry(key), next = change(previous);
      return next === previous ? state : { entries: { ...state.entries, [key]: next } };
    });
  };
  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const timeout = AbortSignal.timeout(path.endsWith('/fork') ? 90_000 : 30_000);
    const response = await request(base + path, { ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...init?.headers } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data as T;
  }
  function latestSession(workspaceId: string, session: Session): Session {
    const cached = store.getState().workspaces.find(ws => ws.id === workspaceId)?.sessions.find(item => item.id === session.id);
    return cached && Date.parse(cached.updatedAt) >= Date.parse(session.updatedAt) ? cached : session;
  }
  function upsert(workspaceId: string, session: Session) {
    session = latestSession(workspaceId, session);
    workspaceRead++;
    store.setState(state => ({ workspaces: state.workspaces.map(ws => ws.id !== workspaceId ? ws : {
      ...ws, sessions: [...ws.sessions.filter(item => item.id !== session.id), session],
    }) }));
  }
  async function refreshWorkspaces() {
    const generation = epoch, read = ++workspaceRead;
    try {
      const data = await json<{ workspaces: Workspace[] }>('/api/workspaces?view=navigation');
      if (generation !== epoch || read !== workspaceRead) return;
      const workspaces = data.workspaces.map(ws => ({ ...ws, name: readable(ws.name, '工作空间'),
        sessions: (ws.sessions || []).map(session => latestSession(ws.id, normalizeSession(session))) }));
      store.setState(state => ({ workspaces, workspaceError: '', activeWsId: state.activeWsId || workspaces[0]?.id || '' }));
    } catch (error) {
      if (generation === epoch && read === workspaceRead) store.setState({ workspaceError: String(error instanceof Error ? error.message : error) });
    }
  }
  async function refreshSession(workspaceId: string, sessionId: string) {
    if (!workspaceId || !sessionId) return;
    const key = conversationKey(workspaceId, sessionId), generation = epoch;
    const read = (reads.get(key) || 0) + 1, revision = entry(key).revision;
    reads.set(key, read);
    update(key, previous => ({ ...previous, loading: true, error: '' }));
    try {
      const path = `/api/workspaces/${workspaceId}/sessions/${sessionId}?view=recent&limit=40`;
      const readPage = async () => {
        const data = await json<{ session: Session; nextBefore: number | null } | Session>(path);
        return 'session' in data ? { session: normalizeSession(data.session), nextBefore: data.nextBefore }
          : { session: normalizeSession(data), nextBefore: null };
      };
      let { session, nextBefore } = await readPage();
      if (generation !== epoch || reads.get(key) !== read) return;
      const cached = store.getState().workspaces.find(ws => ws.id === workspaceId)?.sessions.find(item => item.id === sessionId);
      if (cached && Date.parse(cached.updatedAt) > Date.parse(session.updatedAt)) {
        if (cached.messages.length) { session = cached; nextBefore = null; }
        else ({ session, nextBefore } = await readPage());
      }
      if (generation !== epoch || reads.get(key) !== read) return;
      const pending = session.messages.findLast(message => message.run?.status === 'running');
      let saveFailed = false;
      if (pending && !(entry(key).run && controllers.has(entry(key).run!.clientId))) {
        const status = await json<{ status: string; persisted?: boolean }>(`/api/runs/${pending.run!.id}`);
        saveFailed = status.status === 'finished' && status.persisted === false;
        if (status.status === 'finished' && !saveFailed) ({ session, nextBefore } = await readPage());
      }
      if (generation !== epoch || reads.get(key) !== read) return;
      upsert(workspaceId, session);
      update(key, previous => {
        if (previous.revision !== revision || (previous.run && controllers.has(previous.run.clientId))) {
          return { ...previous, loading: false, error: '' };
        }
        const pending = session.messages.findLast(message => message.run?.status === 'running');
        const localRun = previous.run?.runId ? session.messages.find(message => message.run?.id === previous.run?.runId) : undefined;
        const overlap = previous.messages.findIndex(message => message.id === session.messages[0]?.id);
        const retained = overlap > 0 ? previous.messages.slice(0, overlap).filter(message => message.persisted !== false) : [];
        return { ...previous, loading: false,
          error: saveFailed ? '任务已结束，但结果保存失败。请保留原页面内容，检查存储后重试读取或重启恢复。' : '', revision: previous.revision + 1,
          messages: reconcileMessages([...retained, ...session.messages], previous.messages),
          historyBefore: retained.length ? previous.historyBefore : nextBefore,
          run: pending ? { clientId: `remote:${pending.run!.id}`, runId: pending.run!.id,
            phase: saveFailed ? 'finished' : 'running', ...(saveFailed ? { persisted: false } : {}) }
            : previous.run ? { ...previous.run, phase: 'finished',
              persisted: localRun && localRun.run?.status !== 'running' ? true : previous.run.persisted, stopError: '' } : undefined };
      });
    } catch (error) {
      if (generation === epoch && reads.get(key) === read) update(key, previous => ({ ...previous, loading: false,
        error: `会话读取失败：${error instanceof Error ? error.message : String(error)}` }));
    }
  }
  async function loadOlder(workspaceId: string, sessionId: string) {
    const key = conversationKey(workspaceId, sessionId), before = entry(key).historyBefore, generation = epoch;
    if (typeof before !== 'number' || entry(key).loadingOlder) return;
    const read = reads.get(key);
    update(key, previous => ({ ...previous, loadingOlder: true }));
    try {
      const page = await json<{ session: Session; nextBefore: number | null }>(
        `/api/workspaces/${workspaceId}/sessions/${sessionId}?view=recent&limit=40&before=${before}`);
      if (generation !== epoch || reads.get(key) !== read || entry(key).historyBefore !== before) return;
      const older = normalizeSession(page.session).messages;
      update(key, previous => {
        const seen = new Set(previous.messages.map(message => message.id));
        return { ...previous, loadingOlder: false, historyBefore: page.nextBefore,
          messages: [...older.filter(message => !seen.has(message.id)), ...previous.messages] };
      });
    } catch (error) {
      if (generation === epoch) update(key, previous => ({ ...previous, loadingOlder: false,
        error: `历史消息读取失败：${error instanceof Error ? error.message : String(error)}` }));
    }
  }
  function selectWorkspace(workspaceId: string) {
    navigation++;
    store.setState({ activeWsId: workspaceId, activeSessId: '' });
  }
  async function selectSession(workspaceId: string, sessionId: string) {
    navigation++;
    store.setState({ activeWsId: workspaceId, activeSessId: sessionId });
    await refreshSession(workspaceId, sessionId);
  }
  async function createSession(workspaceId: string, fork?: { id: string; type: 'fork_full' }) {
    const generation = epoch, view = navigation;
    const session = normalizeSession(await json<Session>(`/api/workspaces/${workspaceId}/sessions${fork ? `/${fork.id}/fork` : ''}`, {
      method: 'POST', body: JSON.stringify(fork ? { forkType: fork.type } : { title: '新对话', creationType: 'new' }),
    }));
    if (generation !== epoch) return;
    upsert(workspaceId, session);
    update(conversationKey(workspaceId, session.id), () => ({ ...emptyConversation, messages: session.messages }));
    if (view === navigation) { navigation++; store.setState({ activeWsId: workspaceId, activeSessId: session.id }); }
  }
  async function deleteSession(workspaceId: string, sessionId: string) {
    const generation = epoch;
    const result = await json<{ warnings?: string[] }>(`/api/workspaces/${workspaceId}/sessions/${sessionId}`, { method: 'DELETE' });
    if (generation !== epoch) return;
    workspaceRead++;
    store.setState(state => {
      const entries = { ...state.entries }; delete entries[conversationKey(workspaceId, sessionId)];
      return { entries, activeSessId: state.activeWsId === workspaceId && state.activeSessId === sessionId ? '' : state.activeSessId,
        workspaces: state.workspaces.map(ws => ws.id === workspaceId ? { ...ws, sessions: ws.sessions.filter(session => session.id !== sessionId) } : ws) };
    });
    navigation++;
    if (result.warnings?.length) throw new Error(result.warnings.join(' '));
  }
  async function createWorkspace(name: string) {
    const generation = epoch, view = navigation;
    const workspace = await json<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
    if (generation !== epoch) return;
    workspaceRead++;
    store.setState(state => ({ workspaces: [...state.workspaces, workspace],
      ...(view === navigation ? { activeWsId: workspace.id, activeSessId: '' } : {}) }));
    if (view === navigation) navigation++;
  }
  async function stop(workspaceId: string, sessionId: string) {
    const key = conversationKey(workspaceId, sessionId), run = entry(key).run, generation = epoch;
    if (!run?.runId || !runIsActive(run) || run.phase === 'stopping') return;
    update(key, previous => ({ ...previous, run: { ...run, phase: 'stopping', stopError: '' } }));
    try {
      await json(`/api/runs/${encodeURIComponent(run.runId)}/cancel`, { method: 'POST', signal: AbortSignal.timeout(10000) });
    } catch (error) {
      if (generation === epoch && entry(key).run?.clientId === run.clientId && runIsActive(entry(key).run)) {
        update(key, previous => ({ ...previous, run: { ...run, phase: 'running',
          stopError: `暂未确认后台已停止：${error instanceof Error ? error.message : String(error)}` } }));
      }
    }
  }
  async function send(workspaceId: string, sessionId: string, smokeEnabled = false, mode: 'normal' | 'explore' = 'normal') {
    let key = conversationKey(workspaceId, sessionId);
    const submittedDraft = entry(key).draft, previousRun = entry(key).run;
    const draft = submittedDraft.trim();
    if (!workspaceId || !draft || runIsActive(entry(key).run)) return;
    const shortcut = draft.toLowerCase().startsWith('/smoke ');
    const text = shortcut ? draft.slice(7).trim() : draft;
    if (!text) return;
    const generation = epoch, view = navigation, clientId = crypto.randomUUID();
    const controller = new AbortController();
    controllers.set(clientId, controller);
    let userId = `${clientId}-user`, assistantId = `${clientId}-assistant`;
    const owns = () => generation === epoch && entry(key).run?.clientId === clientId;
    let pendingEvents: RunEvent[] = [];
    const flushEvents = () => {
      const events = pendingEvents; pendingEvents = [];
      if (!events.length || !owns()) return;
      update(key, previous => {
        const current = previous.messages.find(message => message.id === assistantId);
        if (!current) return previous;
        const message = applyRunEvents(current, events, previous.run?.runId, sessionId);
        if (message === current) return previous;
        const complete = events.findLast(event => event.type === 'complete');
        return { ...previous, revision: previous.revision + 1,
          messages: previous.messages.map(item => item === current ? message : item),
          run: complete ? { ...previous.run!, phase: 'finished', persisted: complete.data.persisted !== false } : previous.run };
      });
    };
    update(key, previous => ({ ...previous, draft: '', error: '', revision: previous.revision + 1,
      run: { clientId, phase: 'starting' }, messages: [...previous.messages,
        { id: userId, role: 'user', content: text, traces: [], persisted: false },
        { id: assistantId, role: 'assistant', content: '', traces: [], isStreaming: true, persisted: false }] }));
    let taskSubmissionStarted = false;
    try {
      if (!sessionId) {
        const session = normalizeSession(await json<Session>(`/api/workspaces/${workspaceId}/sessions`, {
          method: 'POST', signal: controller.signal, body: JSON.stringify({ title: titleFrom(text) }),
        }));
        if (!owns()) return;
        const oldKey = key;
        sessionId = session.id;
        key = conversationKey(workspaceId, sessionId);
        store.setState(state => ({ entries: { ...state.entries, [key]: entry(oldKey), [oldKey]: { ...emptyConversation } },
          ...(view === navigation ? { activeWsId: workspaceId, activeSessId: sessionId } : {}) }));
        upsert(workspaceId, session);
      }
      taskSubmissionStarted = true;
      const response = await request(base + '/api/agent/orchestrate', {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ message: text, workspaceId, sessionId, ...(smokeEnabled || shortcut ? { mode: 'research_smoke' } : mode === 'explore' ? { mode } : {}) }),
      });
      if (!response.ok || !response.body) {
        const error = await response.json().catch(() => ({}));
        if (!response.ok && error?.accepted === false && [400, 404, 408, 409, 413, 429].includes(response.status)) {
          if (owns()) update(key, previous => ({ ...previous, revision: previous.revision + 1,
            draft: previous.draft || submittedDraft, run: previousRun,
            error: `本次未发送：${typeof error.error === 'string' ? error.error : '服务器未接受任务，请检查后再发送。'}`,
            messages: previous.messages.filter(message => message.id !== userId && message.id !== assistantId) }));
          return;
        }
        throw new Error(error?.error || `请求失败（${response.status}）`);
      }
      await consumeRunStream(response.body, (type, data) => {
        if (!owns()) return;
        if (type === 'session') {
          flushEvents();
          if (data.workspaceId !== workspaceId || data.sessionId !== sessionId || typeof data.runId !== 'string') {
            throw new Error('运行归属与发起会话不一致');
          }
          const nextUserId = `${data.runId}-user`, nextAssistantId = `${data.runId}-assistant`;
          update(key, previous => ({ ...previous, revision: previous.revision + 1,
            run: { clientId, runId: data.runId as string, phase: 'running' },
            messages: previous.messages.map(message => message.id === userId ? { ...message, id: nextUserId, persisted: true }
              : message.id === assistantId ? { ...message, id: nextAssistantId, run: { id: data.runId as string, status: 'running' } } : message) }));
          userId = nextUserId; assistantId = nextAssistantId;
          void refreshWorkspaces();
          return;
        }
        assertRunEvent(type, data, entry(key).run?.runId, sessionId);
        if (type === 'workflow_event' || type === 'text_delta' || type === 'complete') pendingEvents.push({ type, data });
      }, flushEvents);
    } catch (error) {
      flushEvents();
      controller.abort();
      if (!taskSubmissionStarted) {
        if (owns()) update(key, previous => ({ ...previous, revision: previous.revision + 1,
          draft: previous.draft || submittedDraft, run: previousRun,
          error: `本次任务未发送：${error instanceof Error ? error.message : '新对话未能准备完成。'}；请先刷新对话列表核对后再发送。`,
          messages: previous.messages.filter(message => message.id !== userId && message.id !== assistantId) }));
        return;
      }
      if (owns()) update(key, previous => ({ ...previous, revision: previous.revision + 1,
        run: { ...previous.run!, phase: 'finished' }, messages: previous.messages.map(message => message.id !== assistantId ? message : {
          ...message, isStreaming: false, persisted: false, content: `${message.content ? `${message.content}\n\n---\n\n` : ''}**未收到完整结果**\n\n${error instanceof Error ? error.message : String(error)}\n\n已有内容尚未完成验收，请重新进入会话核对后台保存的结果。`,
        }) }));
    } finally {
      controllers.delete(clientId);
      if (owns()) {
        await refreshWorkspaces();
        if (entry(key).run?.persisted === true) await refreshSession(workspaceId, sessionId);
      }
    }
  }
  return Object.assign(store, {
    refreshWorkspaces, refreshSession, loadOlder, selectWorkspace, selectSession, createWorkspace, createSession, deleteSession, send, stop, json,
    hasLocalRun: (clientId: string) => controllers.has(clientId),
    setDraft(workspaceId: string, sessionId: string, draft: string) {
      update(conversationKey(workspaceId, sessionId), previous => ({ ...previous, draft }));
    },
    applyPreparedDraft(workspaceId: string, sessionId: string, expectedDraft: string, prepared: string, mode: 'append' | 'replace') {
      const state = store.getState(), workspace = state.workspaces.find(item => item.id === workspaceId);
      if (!workspace || (sessionId && !workspace.sessions.some(item => item.id === sessionId))
        || state.activeWsId !== workspaceId || state.activeSessId !== sessionId) throw new Error('当前会话已变化，未写入草稿。请关闭后在目标会话重新准备任务。');
      const key = conversationKey(workspaceId, sessionId), current = entry(key);
      const session = workspace.sessions.find(item => item.id === sessionId);
      if (current.loading || runIsActive(current.run) || session?.summaryForks?.some(item => ['running', 'ready'].includes(item.status))) throw new Error('当前会话仍在处理任务，请完成后再填入。');
      if (current.draft !== expectedDraft) throw new Error('原草稿已变化，未覆盖任何内容。请关闭后重新准备任务。');
      const draft = combineTaskDraft(current.draft, prepared, mode);
      update(key, previous => ({ ...previous, draft }));
    },
    dispose() {
      epoch++; navigation++;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear(); reads.clear();
      store.setState(initial());
    },
  });
}
export type ConversationStore = ReturnType<typeof createConversationStore>;
