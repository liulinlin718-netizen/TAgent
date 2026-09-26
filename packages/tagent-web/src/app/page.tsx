'use client';
import ToolApprovalPanel from '../components/ToolApprovalPanel';

import { useState, useRef, useEffect, useCallback } from 'react';
import { LazyMotion, domAnimation, m, AnimatePresence } from 'framer-motion';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ArrowRight, Cable, FileText, GitCompareArrows, GitFork, History, CalendarClock, LoaderCircle, Menu, PanelLeftClose, PanelLeftOpen, Quote, RefreshCw, Search, Square, Trash2, X } from 'lucide-react';
import { useStore } from 'zustand';
import { useConversations } from '../components/ConversationProvider';
import { conversationKey, emptyConversation, runIsActive, type ChatMessage } from '../lib/conversations';
import MessageActivity from '../components/MessageActivity';
import * as Dialog from '@radix-ui/react-dialog';
import { useCompactLayout } from '../lib/use-compact-layout';
import TaskWorkbench, { TASK_ICONS } from './TaskWorkbench';
import { OFFICE_TASKS, type OfficeTask } from '../lib/task-brief';
import Markdown from '../components/Markdown';
import ReportExport from '../components/ReportExport';
import ResearchReview from '../components/ResearchReview';
import DeliveryReview from '../components/DeliveryReview';
import TableCalculations from '../components/TableCalculations';
import styles from './page.module.css';

const WorkflowDrawer = dynamic(() => import('./WorkflowDrawer'), { ssr: false });
const SessionDiffView = dynamic(() => import('./SessionDiffView'), { ssr: false });
const SummaryForkDialog = dynamic(() => import('./SummaryForkDialog'), { ssr: false });
const TaskBriefDialog = dynamic(() => import('./TaskBriefDialog'), { ssr: false });
const ExecutionSnapshots = dynamic(() => import('./ExecutionSnapshots'), { ssr: false });

import { AccessControl } from '../components/AccessGate';
const SMOKE_MODE_ENABLED = process.env.NEXT_PUBLIC_TAGENT_SMOKE_MODE === 'true';

// ─── Page ────────────────────────────────────────────

export default function AppPage() {
  // ── State ──
  const conversations = useConversations();
  const { workspaces, activeWsId, activeSessId, entries, workspaceError } = useStore(conversations);
  const currentKey = conversationKey(activeWsId, activeSessId);
  const current = entries[currentKey] || emptyConversation;
  const messages = current.messages;
  const input = current.draft;
  const setInput = (value: string) => conversations.setDraft(activeWsId, activeSessId, value);
  const isRunning = runIsActive(current.run);
  const activeRunId = current.run?.runId || '';
  const isStopping = current.run?.phase === 'stopping';
  const stopError = current.run?.stopError || '';
  const viewError = current.error || workspaceError;
  const loadWorkspaces = conversations.refreshWorkspaces;
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [taskMode, setTaskMode] = useState<'normal' | 'explore'>('normal');
  const [snapshotsView, setSnapshotsView] = useState<{ workspaceId: string; sessionId: string } | null>(null);
  const [workflowTriggerContainer, setWorkflowTriggerContainer] = useState<HTMLDivElement | null>(null);
  const compact = useCompactLayout();
  const navContext = `${currentKey}:${compact}`;
  const [mobileNav, setMobileNav] = useState({ context: navContext, open: false });
  if (mobileNav.context !== navContext) setMobileNav({ context: navContext, open: false });
  const mobileNavOpen = mobileNav.context === navContext && mobileNav.open;
  const setMobileNavOpen = useCallback((open: boolean) => setMobileNav({ context: navContext, open }), [navContext]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [diffView, setDiffView] = useState<{ parentId: string; branchId: string; wsId: string; triggerId: string } | null>(null);
  const [summaryView, setSummaryView] = useState<{ sessionId: string; wsId: string } | null>(null);
  const [brief, setBrief] = useState<{ task: OfficeTask; workspaceId: string; sessionId: string; expectedDraft: string; target: string; trigger: HTMLElement } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const scrollSession = useRef(currentKey);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const briefApplied = useRef(false);

  useEffect(() => {
    const area = inputRef.current;
    if (!area) return;
    const resize = () => {
      area.style.height = '0px';
      area.style.height = `${Math.min(area.scrollHeight, 150)}px`;
    };
    resize();
    let width = area.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width === area.clientWidth) return;
      width = area.clientWidth;
      resize();
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, [input, currentKey]);

  // ── Sync Theme ──
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // ── Load Workspaces ──
  useEffect(() => {
    void conversations.refreshWorkspaces();
    const state = conversations.getState();
    if (state.activeSessId) void conversations.refreshSession(state.activeWsId, state.activeSessId);
  }, [conversations]);

  useEffect(() => {
    if (!activeSessId || !runIsActive(current.run) || current.loading || current.error
      || (current.run && conversations.hasLocalRun(current.run.clientId))) return;
    const timer = setTimeout(() => void conversations.refreshSession(activeWsId, activeSessId), 1500);
    return () => clearTimeout(timer);
  }, [conversations, current, activeWsId, activeSessId]);

  // ── Derived State ──
  const activeWs = workspaces.find(w => w.id === activeWsId);
  const sessions = activeWs?.sessions || [];
  const activeSession = sessions.find(s => s.id === activeSessId);
  const summaryRunning = !!activeSession?.summaryForks?.some(record => ['running', 'ready'].includes(record.status));
  const prepareTask = (task: OfficeTask, trigger: HTMLElement) => {
    if (!activeWs || isRunning || current.loading || summaryRunning) return;
    briefApplied.current = false;
    setMobileNavOpen(false);
    setBrief({ task, workspaceId: activeWsId, sessionId: activeSessId, expectedDraft: input,
      target: `${activeWs.name} / ${activeSession?.title || '新对话'}`, trigger });
  };
  useEffect(() => {
    if (!summaryRunning || summaryView) return;
    const timer = setTimeout(() => void conversations.refreshWorkspaces(), 1500);
    return () => clearTimeout(timer);
  }, [summaryRunning, summaryView, conversations, workspaces]);

  const restoreSessionAction = (triggerId: string) => requestAnimationFrame(() => {
    const target = document.getElementById(triggerId);
    target?.closest('[data-session-row]')?.querySelector('button')?.focus();
    target?.focus();
    if (!target || document.activeElement !== target) {
      const nav = document.querySelector<HTMLButtonElement>('[aria-label="打开导航"]');
      if (nav?.getBoundingClientRect().width) nav.focus(); else inputRef.current?.focus();
    }
  });

  // ── Session Switch ──
  const switchSession = useCallback((sessionId: string) => {
    setMobileNavOpen(false);
    void conversations.selectSession(activeWsId, sessionId);
  }, [conversations, activeWsId, setMobileNavOpen]);

  const createSession = useCallback(async () => {
    if (!activeWsId) return;
    try { await conversations.createSession(activeWsId); }
    catch (error) { alert('创建失败: ' + (error instanceof Error ? error.message : String(error))); }
  }, [conversations, activeWsId]);

  const forkSession = useCallback(async (sourceId: string, forkType: 'fork_full' | 'fork_summary') => {
    if (!activeWsId) return;
    if (forkType === 'fork_summary') { setSummaryView({ sessionId: sourceId, wsId: activeWsId }); return; }
    try { await conversations.createSession(activeWsId, { id: sourceId, type: forkType }); }
    catch (error) { alert('Fork 失败: ' + (error instanceof Error ? error.message : String(error))); }
  }, [conversations, activeWsId]);

  // ── Merge to Parent ──
  const mergeToParent = useCallback(async (sessId: string) => {
    if (!activeWsId) return;
    const source = workspaces.find(workspace => workspace.id === activeWsId)?.sessions.find(session => session.id === sessId);
    if (source?.parentSessionId) setDiffView({ parentId: source.parentSessionId, branchId: sessId, wsId: activeWsId, triggerId: `quote-${sessId}` });
  }, [activeWsId, workspaces]);

  // ── Delete Session ──
  const deleteSession = useCallback(async (sessionId: string) => {
    if (!activeWsId || !confirm('确定删除此对话？')) return;
    try { await conversations.deleteSession(activeWsId, sessionId); }
    catch (error) { alert('删除失败: ' + (error instanceof Error ? error.message : String(error))); }
  }, [conversations, activeWsId]);

  // ── Show Diff ──
  const showDiff = useCallback((parentId: string, branchId: string) => {
    if (!activeWsId) return;
    setDiffView({ parentId, branchId, wsId: activeWsId, triggerId: `compare-${branchId}` });
  }, [activeWsId]);

  // ── Create Workspace ──
  const createWorkspace = useCallback(async () => {
    const name = prompt('工作空间名称:');
    if (!name) return;
    try { await conversations.createWorkspace(name); }
    catch (error) { alert('创建失败: ' + (error instanceof Error ? error.message : String(error))); }
  }, [conversations]);

  // ── Scroll ──
  useEffect(() => {
    if (scrollSession.current !== currentKey) { scrollSession.current = currentKey; followOutput.current = true; }
    if (messages.length === 0) {
      messagesViewportRef.current?.scrollTo({ top: 0, behavior: 'instant' });
      return;
    }
    if (followOutput.current) messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages, currentKey]);

  // ── Send Message ──
  const stopTask = () => conversations.stop(activeWsId, activeSessId);
  const sendMessage = () => { if (summaryRunning) return; followOutput.current = true; return conversations.send(activeWsId, activeSessId, SMOKE_MODE_ENABLED, taskMode); };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const getStreamingLabel = (msg: ChatMessage) => {
    const latest = msg.traces[msg.traces.length - 1];
    if (!latest) return '思考中···';

    const approvals = new Map<string, string>();
    for (const trace of msg.traces) {
      const approval = trace.data.approval as { requestId?: string; status?: string } | undefined;
      if (approval?.requestId && approval.status) approvals.set(approval.requestId, approval.status);
    }
    if ([...approvals.values()].includes('pending')) return '等待确认···';

    if (latest.type === 'task_decomposition') return '拆解中···';
    if (latest.type === 'synthesis_start') return '整理中···';
    if (latest.type === 'agent_spawn' || latest.type === 'agent_progress' || latest.type === 'iteration') {
      return '思考中···';
    }

    if (latest.type === 'tool_call' || latest.type === 'agent_tool_call') {
      const tool = String(latest.data.tool || '');
      if (tool.includes('web') || tool.includes('browser') || tool.includes('search')) return '调研中···';
      if (tool.includes('read')) return '阅读中···';
      return '执行中···';
    }

    if (latest.type === 'tool_result' || latest.type === 'agent_tool_result') return '分析中···';
    if (latest.type === 'governance') return '检查中···';
    if (latest.type === 'agent_complete') return '汇总中···';

    return msg.content ? '生成中···' : '思考中···';
  };

  const lastAssistantMessage = messages.filter(m => m.role === 'assistant').slice(-1)[0];
  const workflowTraces = lastAssistantMessage?.traces || [];

  // ─── Render ─────────────────────────────────────────

  const navigation = (
    <>
        {/* Logo */}
        <div className={styles.sidebarHeader}>
          <div className={styles.logo}>
            <div className={styles.logoDotGrid}>
              <div className={styles.logoDot} />
              <div className={styles.logoDot} />
              <div className={styles.logoDot} />
              <div className={styles.logoDot} />
            </div>
            <span className={styles.logoText}>TAgent</span>
          </div>
          <button className={styles.iconBtn}
            onClick={() => compact ? setMobileNavOpen(false) : setSidebarOpen(!sidebarOpen)}
            aria-label={compact ? '关闭导航' : sidebarOpen ? '收起导航' : '展开导航'}
            title={compact ? '关闭导航' : sidebarOpen ? '收起导航' : '展开导航'}>
            {compact ? <X size={20} /> : sidebarOpen ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}
          </button>
        </div>

        <div className={styles.sidebarContent} inert={!compact && !sidebarOpen}>
          {/* 常驻 Agent */}
          <div className={styles.sidebarSection}>
            <div className={styles.sectionTitle}>📋 常驻 Agent</div>
            <div>
              {OFFICE_TASKS.map(task => {
                const Icon = TASK_ICONS[task.id];
                return <button type="button" key={task.id} className={`${styles.listItem} ${styles.agentTaskButton}`}
                  disabled={!activeWsId || isRunning || current.loading || summaryRunning}
                  aria-label={`${task.agent}：准备${task.title}`} title={`准备${task.title}`}
                  onClick={event => prepareTask(task, event.currentTarget)}><Icon size={17} aria-hidden="true" /><span>{task.agent}</span></button>;
              })}
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
                className={`${styles.listItem} ${ws.id === activeWsId ? styles.listItemActive : ''}`}
                onClick={() => { setMobileNavOpen(false); conversations.selectWorkspace(ws.id); }}
              >
                {ws.name}
              </button>
            ))}
          </div>

          {/* Session 列表 (plan §3.9: 树形历史 + Fork 分支) */}
          {activeWs && (() => {
            // 构建树形结构: root sessions (无 parent) + 子 sessions
            const rootSessions = sessions.filter(s => !s.parentSessionId);
            const childSessions = (parentId: string) => sessions.filter(s => s.parentSessionId === parentId);

            return (
            <div className={styles.sidebarSection}>
              <div className={styles.sectionHeader}>
                <span className={styles.sectionTitle}>💬 对话</span>
                <button className={styles.addBtn} onClick={createSession} title="新建对话 (①)">+</button>
              </div>
              {sessions.length === 0 && (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', textAlign: 'center', padding: 'var(--space-2)' }}>
                  点击 + 创建新对话
                </div>
              )}
              {rootSessions.map(sess => (
                <div key={sess.id}>
                  {/* 父 Session */}
                  <div
                    className={styles.sessRow} data-session-row
                  >
                    <button
                      className={`${styles.listItem} ${sess.id === activeSessId ? styles.listItemActive : ''}`}
                      onClick={() => switchSession(sess.id)}
                      style={{ flex: 1 }}
                    >
                      <span className={styles.sessTitle}>{sess.title}</span>
                      {runIsActive(entries[conversationKey(activeWsId, sess.id)]?.run) && <span className={styles.sessionRunning} role="status" aria-label="任务运行中"><LoaderCircle size={14} aria-hidden="true" /></span>}
                      {sess.creationType !== 'new' && (
                        <span className={`${styles.sessForkBadge} ${sess.creationType === 'fork_full' ? styles.forkFull : styles.forkSummary}`}>
                          {sess.creationType === 'fork_full' ? '🔀' : '📝'}
                        </span>
                      )}
                      {sess.totalCost > 0 && (
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--color-text-muted)' }}>
                          ${sess.totalCost.toFixed(4)}
                        </span>
                      )}
                    </button>
                    {/* hover 操作菜单 */}
                      <div className={styles.sessActions}>
                        <button className={styles.sessActionBtn} title="完整 Fork" aria-label="完整 Fork"
                          onClick={(e) => { e.stopPropagation(); forkSession(sess.id, 'fork_full'); }}>
                          <GitFork size={15} />
                        </button>
                        <button id={`summary-${sess.id}`} className={styles.sessActionBtn} title="摘要 Fork" aria-label="摘要 Fork"
                          onClick={(e) => { e.stopPropagation(); forkSession(sess.id, 'fork_summary'); }}>
                          <FileText size={15} />
                        </button>
                        {sess.parentSessionId && (
                          <>
                            <button id={`compare-${sess.id}`} className={styles.sessActionBtn} title="对比分支" aria-label="对比分支"
                              onClick={(e) => { e.stopPropagation(); showDiff(sess.parentSessionId!, sess.id); }}>
                              <GitCompareArrows size={15} />
                            </button>
                            <button id={`quote-${sess.id}`} className={styles.sessActionBtn} title="引用到主线" aria-label="引用到主线"
                              onClick={(e) => { e.stopPropagation(); mergeToParent(sess.id); }}>
                              <Quote size={15} />
                            </button>
                          </>
                        )}
                        <button className={`${styles.sessActionBtn} ${styles.danger}`} title="删除" aria-label="删除会话"
                          onClick={(e) => { e.stopPropagation(); deleteSession(sess.id); }}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                  </div>
                  {/* 子分支 (缩进) */}
                  {childSessions(sess.id).map(child => (
                    <div key={child.id} className={styles.sessTreeChild}>
                      <div
                        className={styles.sessRow} data-session-row
                      >
                        <button
                          className={`${styles.listItem} ${child.id === activeSessId ? styles.listItemActive : ''}`}
                          onClick={() => switchSession(child.id)}
                          style={{ flex: 1 }}
                        >
                          <span className={styles.sessTitle}>{child.title}</span>
                          {runIsActive(entries[conversationKey(activeWsId, child.id)]?.run) && <span className={styles.sessionRunning} role="status" aria-label="任务运行中"><LoaderCircle size={14} aria-hidden="true" /></span>}
                          <span className={`${styles.sessForkBadge} ${child.creationType === 'fork_full' ? styles.forkFull : styles.forkSummary}`}>
                            {child.creationType === 'fork_full' ? '🔀' : '📝'}
                          </span>
                          {child.totalCost > 0 && (
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--color-text-muted)' }}>
                              ${child.totalCost.toFixed(4)}
                            </span>
                          )}
                        </button>
                          <div className={styles.sessActions}>
                            <button id={`compare-${child.id}`} className={styles.sessActionBtn} title="对比父分支" aria-label="对比父分支"
                              onClick={(e) => { e.stopPropagation(); showDiff(sess.id, child.id); }}>
                              <GitCompareArrows size={15} />
                            </button>
                            <button id={`quote-${child.id}`} className={styles.sessActionBtn} title="引用到主线" aria-label="引用到主线"
                              onClick={(e) => { e.stopPropagation(); mergeToParent(child.id); }}>
                              <Quote size={15} />
                            </button>
                            <button className={`${styles.sessActionBtn} ${styles.danger}`} title="删除" aria-label="删除会话"
                              onClick={(e) => { e.stopPropagation(); deleteSession(child.id); }}>
                              <Trash2 size={15} />
                            </button>
                          </div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            );
          })()}

          {/* 快捷管理入口 */}
          <div className={styles.sidebarSection}>
            <div className={styles.sectionTitle}>⚙️ 管理中心</div>
            <Link href="/management/skills" className={styles.listItem}>
              <span>📦 Skills 技能库</span>
            </Link>
            <Link href="/management/agents" className={styles.listItem}>
              <span>🤖 Agent 大厅</span>
            </Link>
            <Link href="/management/mcp" className={styles.listItem}>
              <span>🔌 MCP 工具</span>
            </Link>
            <Link href="/management/search" className={styles.listItem}>
              <Search size={18} aria-hidden="true" />
              <span>调研搜索</span>
            </Link>
            <Link href="/management/governance" className={styles.listItem}>
              <span>🛡️ 治理仪表盘</span>
            </Link>
            <Link href="/management/runtime" className={styles.listItem}><CalendarClock size={18} /><span>运行与周期任务</span></Link>
          </div>

          {/* Theme Toggle & Footer */}
          <div className={styles.sidebarFooter}>
              <button
                className={styles.themeToggle}
                onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
              >
                {theme === 'light' ? '🌙 暗色模式' : '☀️ 亮色模式'}
              </button>
            </div>
        </div>
    </>
  );

  return (
    <LazyMotion features={domAnimation}>
    <Dialog.Root open={compact && mobileNavOpen} onOpenChange={setMobileNavOpen}>
    <div className={styles.app}>
      {compact ? (
        <Dialog.Portal>
          <Dialog.Overlay className={styles.navigationBackdrop} />
          <Dialog.Content className={styles.mobileNavigation} aria-describedby={undefined}>
            <Dialog.Title className={styles.visuallyHidden}>工作区导航</Dialog.Title>
            {navigation}
          </Dialog.Content>
        </Dialog.Portal>
      ) : (
        <aside aria-label="工作区导航" className={`${styles.sidebar} ${sidebarOpen ? '' : styles.sidebarCollapsed}`}>
          {navigation}
        </aside>
      )}

      {/* ── Main Content ── */}
      <main className={styles.main}>
        {/* Header */}
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            {compact && <Dialog.Trigger asChild>
              <button className={styles.iconBtn} aria-label="打开导航" title="打开导航"><Menu size={20} /></button>
            </Dialog.Trigger>}
            <span className={styles.wsName}>{activeWs?.name || 'TAgent'}</span>
            {activeSession && <span className={styles.sessName}>/ {activeSession.title}</span>}
          </div>
          <div className={styles.headerRight}>
            <AccessControl />
            {activeSessId && <button id="execution-snapshots-trigger" className={styles.iconBtn} title="执行快照" aria-label="执行快照"
              onClick={() => setSnapshotsView({ workspaceId: activeWsId, sessionId: activeSessId })}><History size={18} /></button>}
            <Link href="/management/model" className={styles.modelConnectionLink} aria-label="模型连接" title="查看模型配置与连接测试">
              <Cable size={18} aria-hidden="true" /><span className={styles.statusText}>模型连接</span>
            </Link>
            <div ref={setWorkflowTriggerContainer} className={styles.workflowTriggerSlot} />
          </div>
        </header>

        {/* Messages */}
        <div ref={messagesViewportRef} className={styles.messages} onScroll={event => {
          const list = event.currentTarget;
          followOutput.current = list.scrollHeight - list.clientHeight - list.scrollTop < 100;
        }}>
          {current.loading && messages.length === 0 && <p className={styles.runNotice} role="status">正在读取对话...</p>}
          {typeof current.historyBefore === 'number' && <button type="button" className={styles.loadHistory}
            disabled={current.loadingOlder} onClick={async () => {
              const viewport = messagesViewportRef.current;
              const height = viewport?.scrollHeight || 0, top = viewport?.scrollTop || 0;
              followOutput.current = false;
              await conversations.loadOlder(activeWsId, activeSessId);
              requestAnimationFrame(() => {
                if (viewport) viewport.scrollTop = top + viewport.scrollHeight - height;
              });
            }}>{current.loadingOlder ? '正在读取...' : '查看更早消息'}</button>}
          {messages.length === 0 && !current.loading && !viewError && (
            <TaskWorkbench workspace={activeWs} entries={entries} disabled={!activeWsId || isRunning || summaryRunning}
              onPrepare={prepareTask} onSelect={switchSession} />
          )}

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
                  {msg.traces.length > 0 && <MessageActivity message={msg} workspaceId={activeWsId} sessionId={activeSessId} />}
                  {msg.role === 'assistant' && <ToolApprovalPanel traces={msg.traces} runId={msg.run?.id || msg.traces[0]?.runId || (msg.isStreaming ? activeRunId : undefined)} sessionId={activeSessId} active={!!msg.isStreaming && isRunning && !isStopping} />}
                  <div className={`${styles.messageContent} ${msg.role === 'assistant' ? styles.assistantMd : ''}`}>
                    {msg.role === 'assistant' ? (
                      msg.content ? (
                        <>
                          {msg.quote && <div className={styles.quoteOrigin}>
                            <span>分支原文引用，未经独立核验</span>
                            <button disabled={!activeWs?.sessions.some(session => session.id === msg.quote!.sourceSessionId)}
                              onClick={() => void conversations.selectSession(activeWsId, msg.quote!.sourceSessionId)}>
                              来源：{msg.quote.sourceTitle}
                            </button>
                          </div>}
                          {msg.run?.context && (msg.run.context.omittedMessages > 0 || msg.run.context.items.some(item => item.truncated)) &&
                            <p className={styles.contextNotice}>本次参考 {msg.run.context.items.length} 条历史消息；{msg.run.context.omittedMessages} 条未纳入，{msg.run.context.items.filter(item => item.truncated).length} 条仅纳入节选。</p>}
                          <Markdown content={msg.content} />
                          {msg.isStreaming && <span className={styles.streamingStatus}>{getStreamingLabel(msg)}</span>}
                        </>
                      ) : (
                        msg.isStreaming && <span className={styles.streamingStatus}>{getStreamingLabel(msg)}</span>
                      )
                    ) : (
                      msg.content
                    )}
                  </div>
                  {msg.role === 'assistant' && !msg.isStreaming && msg.research && <ResearchReview research={msg.research} />}
                  {msg.role === 'assistant' && <TableCalculations message={msg} messages={messages} />}
                  {msg.role === 'assistant' && !msg.isStreaming && msg.deliveryReview && <DeliveryReview review={msg.deliveryReview} />}
                  {msg.role === 'assistant' && <ReportExport key={`${activeSessId}:${msg.id}`} message={msg} />}
                  {msg.cost !== undefined && (
                    <div className={styles.stats}>
                      {msg.iterations !== undefined && <span>子任务 {msg.iterations}</span>}
                      {msg.tokens && <span>输入 {msg.tokens.input} · 输出 {msg.tokens.output} tokens</span>}
                      <span>已记录费用 ${msg.cost.toFixed(4)}</span>
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
          <div className={styles.taskModes} role="group" aria-label="任务模式">
            <button type="button" aria-pressed={taskMode === 'normal'} disabled={isRunning} onClick={() => setTaskMode('normal')}>办公协作</button>
            <button type="button" aria-pressed={taskMode === 'explore'} disabled={isRunning} onClick={() => setTaskMode('explore')}>只读探索</button>
            {taskMode === 'explore' && <span>公开网页检索；初步摘要，模型与搜索可能计费</span>}
          </div>
          {activeSession?.scheduleOrigin && !messages.length && !input && <div className={styles.runNotice}>
            <button onClick={() => setInput(activeSession.scheduleOrigin!.taskMessage)}>填入待办任务</button>
          </div>}
          {summaryRunning && <div className={styles.runNotice} role="status">此会话正在生成或保存摘要分支。
            <button className={styles.iconBtn} title="查看摘要操作" aria-label="查看摘要操作" onClick={() => setSummaryView({ sessionId: activeSessId, wsId: activeWsId })}><FileText size={16} /></button>
          </div>}
          {viewError && <div className={styles.readError} role="alert">
            <span>{viewError}</span>
            <button className={styles.iconBtn} aria-label="重试读取" title="重试读取"
              onClick={() => activeSessId ? conversations.refreshSession(activeWsId, activeSessId) : loadWorkspaces()}><RefreshCw size={16} /></button>
          </div>}
          {(isStopping || stopError) && <div className={styles.runNotice} role={stopError ? 'alert' : 'status'}>
            {stopError || '正在停止并保留已有结果...'}
          </div>}
          <div className={styles.inputWrapper}>
            <textarea ref={inputRef} className={styles.input}
              placeholder="输入任务，按 Enter 发送..."
              value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown} rows={1} disabled={isRunning || current.loading || !activeWsId}
            />
            <button className={styles.sendButton}
              onClick={isRunning ? stopTask : sendMessage}
              disabled={isRunning ? !activeRunId || isStopping : summaryRunning || !input.trim() || current.loading || !activeWsId}
              aria-label={isRunning ? (isStopping ? '正在停止任务' : '停止任务') : '发送任务'}
              title={isRunning ? (isStopping ? '正在停止任务' : '停止任务') : '发送任务'}
            >
              {isRunning ? <Square size={18} fill="currentColor" /> : <ArrowRight size={20} />}
            </button>
          </div>
        </footer>
      </main>

      <WorkflowDrawer
        triggerContainer={workflowTriggerContainer}
        traces={workflowTraces}
        isRunning={isRunning}
        sessionTitle={activeSession?.title || activeWs?.name || '当前任务'}
      />
    </div>

    {/* Session Diff 弹窗 (plan §3.9) */}
    {snapshotsView && <ExecutionSnapshots key={`${snapshotsView.workspaceId}:${snapshotsView.sessionId}`} {...snapshotsView} onClose={() => setSnapshotsView(null)} />}
    {diffView && (
      <SessionDiffView
        key={`${diffView.wsId}:${diffView.parentId}:${diffView.branchId}`}
        parentSessionId={diffView.parentId}
        branchSessionId={diffView.branchId}
        workspaceId={diffView.wsId}
        restoreFocus={() => restoreSessionAction(diffView.triggerId)}
        onClose={() => setDiffView(null)}
      />
    )}
    {summaryView && <SummaryForkDialog key={`${summaryView.wsId}:${summaryView.sessionId}`} workspaceId={summaryView.wsId}
      sessionId={summaryView.sessionId} onClose={() => setSummaryView(null)} restoreFocus={() => restoreSessionAction(`summary-${summaryView.sessionId}`)} />}
    {brief && <TaskBriefDialog task={brief.task} target={brief.target} existingDraft={brief.expectedDraft}
      onClose={() => setBrief(null)} restoreFocus={() => requestAnimationFrame(() => {
        if (briefApplied.current) inputRef.current?.focus();
        else if (brief.trigger.isConnected && brief.trigger.getBoundingClientRect().width) brief.trigger.focus();
        else inputRef.current?.focus();
      })} onApply={(prepared, mode) => {
        conversations.applyPreparedDraft(brief.workspaceId, brief.sessionId, brief.expectedDraft, prepared, mode);
        briefApplied.current = true; setBrief(null);
      }} />}
    </Dialog.Root>
    </LazyMotion>
  );
}

