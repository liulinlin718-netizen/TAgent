'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { LazyMotion, domAnimation, m, AnimatePresence } from 'framer-motion';
import dynamic from 'next/dynamic';
import styles from './page.module.css';

const WorkflowPanel = dynamic(() => import('./WorkflowPanel'), { ssr: false });

// ─── Types ───────────────────────────────────────────

interface TraceEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  traces: TraceEvent[];
  cost?: number;
  tokens?: { input: number; output: number };
  iterations?: number;
  isStreaming?: boolean;
}

interface Session {
  id: string;
  title: string;
  creationType: string;
  messages: ChatMessage[];
  totalCost: number;
  updatedAt: string;
}

interface Workspace {
  id: string;
  name: string;
  description: string;
  sessions: Session[];
  residentAgents: string[];
}

// ─── API ─────────────────────────────────────────────

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

async function fetchJSON<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...opts?.headers } });
  return res.json() as Promise<T>;
}

// ─── Page ────────────────────────────────────────────

export default function AppPage() {
  // ── State ──
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWsId, setActiveWsId] = useState<string>('');
  const [activeSessId, setActiveSessId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ── Load Workspaces ──
  const loadWorkspaces = useCallback(async () => {
    try {
      const data = await fetchJSON<{ workspaces: Workspace[] }>('/api/workspaces');
      setWorkspaces(data.workspaces);
      if (!activeWsId && data.workspaces.length > 0) {
        setActiveWsId(data.workspaces[0].id);
      }
    } catch { /* server not ready */ }
  }, [activeWsId]);

  useEffect(() => { loadWorkspaces(); }, [loadWorkspaces]);

  // ── Derived State ──
  const activeWs = workspaces.find(w => w.id === activeWsId);
  const sessions = activeWs?.sessions || [];
  const activeSession = sessions.find(s => s.id === activeSessId);

  // ── Session Switch ──
  const switchSession = useCallback(async (sessId: string) => {
    setActiveSessId(sessId);
    if (!activeWsId) return;
    try {
      const data = await fetchJSON<Session>(`/api/workspaces/${activeWsId}/sessions/${sessId}`);
      setMessages(data.messages.map(m => ({ ...m, traces: m.traces || [] })));
    } catch {
      setMessages([]);
    }
  }, [activeWsId]);

  // ── Create Session (plan §3.9: ① 新建) ──
  const createSession = useCallback(async () => {
    if (!activeWsId) return;
    const data = await fetchJSON<Session>(`/api/workspaces/${activeWsId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: '新对话', creationType: 'new' }),
    });
    await loadWorkspaces();
    setActiveSessId(data.id);
    setMessages([]);
  }, [activeWsId, loadWorkspaces]);

  // ── Create Workspace ──
  const createWorkspace = useCallback(async () => {
    const name = prompt('工作空间名称:');
    if (!name) return;
    const ws = await fetchJSON<Workspace>('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    await loadWorkspaces();
    setActiveWsId(ws.id);
    setActiveSessId('');
    setMessages([]);
  }, [loadWorkspaces]);

  // ── Scroll ──
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Send Message ──
  const sendMessage = async () => {
    const text = input.trim();
    if (!text || isRunning) return;
    setInput('');
    setIsRunning(true);

    const userMsg: ChatMessage = { id: `msg-${Date.now()}-u`, role: 'user', content: text, traces: [] };
    const asstId = `msg-${Date.now()}-a`;
    const asstMsg: ChatMessage = { id: asstId, role: 'assistant', content: '', traces: [], isStreaming: true };
    setMessages(prev => [...prev, userMsg, asstMsg]);

    try {
      const response = await fetch(`${API}/api/agent/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, workspaceId: activeWsId, sessionId: activeSessId || undefined }),
      });

      if (!response.ok || !response.body) throw new Error(`Server error: ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            try {
              const data = JSON.parse(line.slice(5).trim());

              // 捕获 session 信息
              if (currentEvent === 'session') {
                if (data.sessionId) setActiveSessId(data.sessionId);
                continue;
              }

              handleSSEEvent(asstId, currentEvent, data);
            } catch { /* skip */ }
          }
        }
      }

      // 刷新 workspace 数据
      await loadWorkspaces();
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      setMessages(prev => prev.map(m =>
        m.id === asstId ? { ...m, content: `❌ 错误: ${errMsg}\n\n请确保后端已启动`, isStreaming: false } : m
      ));
    } finally {
      setIsRunning(false);
    }
  };

  const handleSSEEvent = (msgId: string, eventType: string, data: Record<string, unknown>) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId) return m;
      const traces = [...m.traces];

      switch (eventType) {
        case 'iteration':
          traces.push({ type: 'iteration', data, timestamp: Date.now() });
          return { ...m, traces };
        case 'tool_call':
          traces.push({ type: 'tool_call', data, timestamp: Date.now() });
          return { ...m, traces };
        case 'tool_result':
          traces.push({ type: 'tool_result', data, timestamp: Date.now() });
          return { ...m, traces };
        case 'governance':
          traces.push({ type: 'governance', data, timestamp: Date.now() });
          return { ...m, traces };
        // Phase 2: Multi-Agent events
        case 'task_decomposition':
          traces.push({ type: 'task_decomposition', data, timestamp: Date.now() });
          return { ...m, traces };
        case 'agent_spawn':
          traces.push({ type: 'agent_spawn', data, timestamp: Date.now() });
          return { ...m, traces };
        case 'agent_progress':
          traces.push({ type: 'agent_progress', data, timestamp: Date.now() });
          return { ...m, traces };
        case 'agent_tool_call':
          traces.push({ type: 'agent_tool_call', data, timestamp: Date.now() });
          return { ...m, traces };
        case 'agent_tool_result':
          traces.push({ type: 'agent_tool_result', data, timestamp: Date.now() });
          return { ...m, traces };
        case 'agent_complete':
          traces.push({ type: 'agent_complete', data, timestamp: Date.now() });
          return { ...m, traces };
        case 'agent_failed':
          traces.push({ type: 'agent_failed', data, timestamp: Date.now() });
          return { ...m, traces };
        case 'synthesis_start':
          traces.push({ type: 'synthesis_start', data: {}, timestamp: Date.now() });
          return { ...m, traces };
        case 'text_delta':
          return { ...m, content: m.content + (data.text as string) };
        case 'complete':
          return {
            ...m,
            content: data.output as string,
            cost: data.totalCost as number,
            tokens: data.totalTokens as { input: number; output: number },
            iterations: data.iterations as number,
            isStreaming: false,
          };
        default:
          return m;
      }
    }));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  // ─── Render ─────────────────────────────────────────

  return (
    <LazyMotion features={domAnimation}>
    <div className={styles.app}>
      {/* ── Sidebar (plan §4.2) ── */}
      <aside className={`${styles.sidebar} ${sidebarOpen ? '' : styles.sidebarCollapsed}`}>
        {/* Logo */}
        <div className={styles.sidebarHeader}>
          <div className={styles.logo}>
            <span className={styles.logoIcon}>⚡</span>
            <span className={styles.logoText}>TAgent</span>
          </div>
          <button className={styles.iconBtn} onClick={() => setSidebarOpen(!sidebarOpen)} title="收起侧栏">
            {sidebarOpen ? '◀' : '▶'}
          </button>
        </div>

        {sidebarOpen && (
          <>
            {/* 常驻 Agent (plan §3.2: 常驻态) */}
            <div className={styles.sidebarSection}>
              <div className={styles.sectionTitle}>📋 常驻 Agent</div>
              <div className={styles.agentList}>
                {[
                  { icon: '🔍', name: '研究助手' },
                  { icon: '📄', name: '文档助手' },
                  { icon: '📊', name: '数据分析' },
                ].map(a => (
                  <div key={a.name} className={styles.agentItem}>
                    <span className={styles.agentDot} />
                    <span>{a.icon} {a.name}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 工作空间 */}
            <div className={styles.sidebarSection}>
              <div className={styles.sectionHeader}>
                <span className={styles.sectionTitle}>📁 工作空间</span>
                <button className={styles.addBtn} onClick={createWorkspace} title="新建工作空间">+</button>
              </div>
              {workspaces.map(ws => (
                <button
                  key={ws.id}
                  className={`${styles.wsItem} ${ws.id === activeWsId ? styles.wsItemActive : ''}`}
                  onClick={() => { setActiveWsId(ws.id); setActiveSessId(''); setMessages([]); }}
                >
                  {ws.name}
                </button>
              ))}
            </div>

            {/* Session 列表 (plan §3.9: 树形历史) */}
            {activeWs && (
              <div className={styles.sidebarSection}>
                <div className={styles.sectionHeader}>
                  <span className={styles.sectionTitle}>💬 对话</span>
                  <button className={styles.addBtn} onClick={createSession} title="新建对话 (①)">+</button>
                </div>
                {sessions.map(sess => (
                  <button
                    key={sess.id}
                    className={`${styles.sessItem} ${sess.id === activeSessId ? styles.sessItemActive : ''}`}
                    onClick={() => switchSession(sess.id)}
                  >
                    <span className={styles.sessTitle}>{sess.title}</span>
                    {sess.totalCost > 0 && (
                      <span className={styles.sessCost}>${sess.totalCost.toFixed(4)}</span>
                    )}
                  </button>
                ))}
                {sessions.length === 0 && (
                  <div className={styles.emptyHint}>点击 + 创建新对话</div>
                )}
              </div>
            )}

            {/* 快捷操作 */}
            <div className={styles.sidebarFooter}>
              <div className={styles.badge}>Phase 2</div>
            </div>
          </>
        )}
      </aside>

      {/* ── Main Content ── */}
      <main className={styles.main}>
        {/* Header */}
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.wsName}>{activeWs?.name || 'TAgent'}</span>
            {activeSession && <span className={styles.sessName}>/ {activeSession.title}</span>}
          </div>
          <div className={styles.headerRight}>
            <div className={styles.statusDot} />
            <span className={styles.statusText}>Orchestrator</span>
          </div>
        </header>

        {/* Messages */}
        <div className={styles.messages}>
          {messages.length === 0 && (
            <div className={styles.welcome}>
              <m.div className={styles.welcomeIcon}
                initial={{ scale: 0 }} animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 200 }}
              >⚡</m.div>
              <h1 className={styles.welcomeTitle}>TAgent</h1>
              <p className={styles.welcomeSubtitle}>AI 办公协作助手 — 让 Agent 为你工作</p>
              <div className={styles.suggestions}>
                {['帮我做一份支付Agent竞品分析报告', '搜索最新的 AI Agent 框架', '了解 MCP 协议的发展'].map(s => (
                  <button key={s} className={styles.suggestion}
                    onClick={() => { setInput(s); inputRef.current?.focus(); }}
                  >{s}</button>
                ))}
              </div>
            </div>
          )}

          {/* React Flow 工作流看板 (plan §4.3) */}
          {messages.length > 0 && (() => {
            const lastAssistant = messages.filter(m => m.role === 'assistant').slice(-1)[0];
            if (!lastAssistant) return null;
            const hasOrchestration = lastAssistant.traces.some(t =>
              t.type === 'task_decomposition' || t.type === 'agent_spawn'
            );
            if (!hasOrchestration) return null;
            return <WorkflowPanel traces={lastAssistant.traces} isRunning={isRunning} />;
          })()}

          <AnimatePresence>
            {messages.map(msg => (
              <m.div key={msg.id}
                className={`${styles.message} ${styles[msg.role]}`}
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
              >
                <div className={styles.messageAvatar}>
                  {msg.role === 'user' ? '👤' : '⚡'}
                </div>
                <div className={styles.messageBody}>
                  {msg.traces.length > 0 && (
                    <div className={styles.traceTimeline}>
                      {msg.traces.map((t, i) => <TraceItem key={i} trace={t} />)}
                    </div>
                  )}
                  <div className={styles.messageContent}>
                    {msg.content || (msg.isStreaming && '思考中...')}
                    {msg.isStreaming && <span className={styles.cursor}>▊</span>}
                  </div>
                  {msg.cost !== undefined && (
                    <div className={styles.stats}>
                      <span>🔄 {msg.iterations} 迭代</span>
                      <span>🪙 {msg.tokens?.input}+{msg.tokens?.output} tokens</span>
                      <span>💰 ${msg.cost.toFixed(4)}</span>
                    </div>
                  )}
                </div>
              </m.div>
            ))}
          </AnimatePresence>
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <footer className={styles.inputArea}>
          <div className={styles.inputWrapper}>
            <textarea ref={inputRef} className={styles.input}
              placeholder="输入任务，按 Enter 发送..."
              value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown} rows={1} disabled={isRunning}
            />
            <button className={styles.sendButton}
              onClick={sendMessage} disabled={isRunning || !input.trim()}
            >
              {isRunning ? <span className={styles.spinner}>◌</span> : '→'}
            </button>
          </div>
        </footer>
      </main>
    </div>
    </LazyMotion>
  );
}

// ─── Trace Item ──────────────────────────────────────

function TraceItem({ trace }: { trace: TraceEvent }) {
  const map: Record<string, { icon: string; label: string }> = {
    iteration: { icon: '📍', label: `迭代 #${trace.data.iteration}` },
    tool_call: { icon: '🔧', label: `调用 ${trace.data.tool}` },
    tool_result: { icon: '✅', label: `${trace.data.tool} 返回 ${trace.data.resultLength} 字符` },
    governance: { icon: '🛡️', label: `治理: ${trace.data.message}` },
    // Phase 2: Multi-Agent events
    task_decomposition: { icon: '🧩', label: `任务分解为 ${(trace.data.tasks as unknown[])?.length || '?'} 个子任务` },
    agent_spawn: { icon: '🚀', label: `${trace.data.icon || '⚡'} ${trace.data.agentName}: ${(trace.data.objective as string)?.slice(0, 40)}...` },
    agent_progress: { icon: '⏳', label: `${trace.data.agentId} 迭代 #${trace.data.iteration}` },
    agent_tool_call: { icon: '🔧', label: `${trace.data.agentId} → ${trace.data.tool}` },
    agent_tool_result: { icon: '✅', label: `${trace.data.agentId}: ${trace.data.tool} 返回 ${trace.data.resultLength} 字符` },
    agent_complete: { icon: '✨', label: `${trace.data.agentId} 完成 ($${(trace.data.cost as number)?.toFixed(4) || '?'})` },
    agent_failed: { icon: '❌', label: `${trace.data.agentId} 失败` },
    synthesis_start: { icon: '📝', label: '正在综合各 Agent 报告...' },
  };
  const { icon, label } = map[trace.type] || { icon: '•', label: trace.type };

  return (
    <m.div className={styles.traceItem}
      initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
    >
      <span className={styles.traceIcon}>{icon}</span>
      <span className={styles.traceLabel}>{label}</span>
    </m.div>
  );
}

