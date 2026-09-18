'use client';

import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { useCompactLayout } from '../lib/use-compact-layout';
import { WorkflowEventList, type WorkflowScrollPositions } from './WorkflowEventList';
import { WorkflowEdgeMotion } from './WorkflowEdgeMotion';
import { clipOrthogonalMotion, workflowGutter } from './workflow-edge-motion';
import {
  Background,
  getSmoothStepPath,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  useViewport,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronRight,
  FileText,
  Focus,
  GitBranch,
  Layers3,
  ListTree,
  Maximize,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  Sparkles,
  Search,
  TerminalSquare,
  XCircle,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import styles from './WorkflowDrawer.module.css';
import {
  agentsForCurrentTask,
  activeWorkflowGroups,
  agentRunStatus,
  indexAgentEvents,
  groupFlowEvents,
  groupToolEvents,
  isToolCall,
  kindForEvent,
  parentForAgent,
  readableAgent,
  runPresentation,
  taskDependencyEdges,
  toWorkflowEvent,
  truncate,
  type AgentCard,
  type TraceEvent,
  type WorkflowEvent,
  type WorkflowGroup,
  type WorkflowStatus,
} from './WorkflowDrawer.logic';

type DrawerTab = 'realtime' | 'architecture' | 'log';

interface WorkflowDrawerProps {
  triggerContainer: HTMLElement | null;
  traces: TraceEvent[];
  isRunning: boolean;
  sessionTitle?: string;
}

const MIN_WIDTH = 340;
const MAX_WIDTH = 680;
const GRAPH_AGENT_X = 24;
const GRAPH_TOOL_X = 350;
const GRAPH_ORCHESTRATOR_X = GRAPH_AGENT_X;
const GRAPH_START_Y = 180;
const GRAPH_MIN_AGENT_BLOCK = 356;
const GRAPH_TOOL_ROW_GAP = 116;
const MIN_GRAPH_ZOOM = 0.001;
const WorkflowEdgeLayerContext = createContext<SVGGElement | null>(null);
const workflowEdgeTypes = {
  workflowRelation: WorkflowRelationEdge,
};

const tabs: Array<{ id: DrawerTab; label: string; icon: typeof Activity }> = [
  { id: 'realtime', label: '实时流转', icon: Activity },
  { id: 'architecture', label: '静态架构', icon: GitBranch },
  { id: 'log', label: '事件日志', icon: ListTree },
];

export default function WorkflowDrawer({ traces, isRunning, sessionTitle, triggerContainer }: WorkflowDrawerProps) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(430);
  const [availableWidth, setAvailableWidth] = useState(MAX_WIDTH);
  const [activeTab, setActiveTab] = useState<DrawerTab>('realtime');
  const [manualClosedRunId, setManualClosedRunId] = useState<string | null>(null);
  const compact = useCompactLayout();
  const [savedViewports, setSavedViewports] = useState<ReadonlyMap<string, Viewport>>(() => new Map());
  const saveViewport = useCallback((id: string, viewport: Viewport) => setSavedViewports(previous => {
    const saved = previous.get(id);
    return saved?.x === viewport.x && saved.y === viewport.y && saved.zoom === viewport.zoom
      ? previous : new Map(previous).set(id, viewport);
  }), []);
  const [previousAutoOpen, setPreviousAutoOpen] = useState<string | null>(null);
  const resizeCleanup = useRef<() => void>(() => {});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const visibleWidth = Math.min(width, availableWidth);

  useEffect(() => () => resizeCleanup.current(), [compact, open]);

  useEffect(() => {
    if (compact) return;
    const shell = shellRef.current;
    const main = shell?.parentElement?.querySelector(':scope > main');
    if (!shell || !main) return;
    const update = () => setAvailableWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH,
      main.getBoundingClientRect().width + shell.getBoundingClientRect().width - 360)));
    const observer = new ResizeObserver(update);
    observer.observe(main);
    update();
    return () => observer.disconnect();
  }, [compact]);

  const events = useMemo(() => traces.map(toWorkflowEvent), [traces]);
  const meaningfulEvents = useMemo(() => events.filter(event => event.type !== 'iteration'), [events]);
  const runId = events[0]?.runId || events[0]?.sessionId || sessionTitle || 'current';
  const scrollState = useMemo(() => ({ runId, offsets: new Map() as WorkflowScrollPositions }), [runId]);
  const scrollOffsets = scrollState.offsets;
  const activeEvent = meaningfulEvents[meaningfulEvents.length - 1] || events[events.length - 1];
  const hasWorkflow = events.length > 0;
  const approvalStates = new Map<string, string>();
  for (const event of events) {
    const approval = event.data.approval as { requestId?: string; status?: string } | undefined;
    if (approval?.requestId && approval.status) approvalStates.set(approval.requestId, approval.status);
  }
  const hasPendingApproval = isRunning && [...approvalStates.values()].includes('pending');

  const autoOpen = !compact && isRunning && hasWorkflow && manualClosedRunId !== runId ? runId : null;
  if (autoOpen !== previousAutoOpen) {
    setPreviousAutoOpen(autoOpen);
    if (autoOpen) {
      setOpen(true);
      setActiveTab('realtime');
    }
  }

  const closeDrawer = () => {
    if (isRunning) setManualClosedRunId(runId);
    setOpen(false);
    if (!compact) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const startResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = visibleWidth;
    resizeCleanup.current();
    const previousCursor = document.body.style.cursor;
    const previousSelection = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.max(MIN_WIDTH, Math.min(availableWidth, startWidth - (moveEvent.clientX - startX)));
      setWidth(nextWidth);
    };
    const onUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelection;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    resizeCleanup.current = onUp;
  };

  const trigger = (
      <button
        ref={triggerRef}
        className={`${styles.railButton} ${open ? styles.railButtonHidden : ''}`}
        onClick={() => {
          setManualClosedRunId(null);
          setOpen(true);
        }}
        aria-label="展开工作流看板"
        title="展开工作流看板"
        tabIndex={open ? -1 : 0}
        aria-hidden={open}
      >
        <PanelRightOpen size={18} />
        {hasWorkflow && <b>{meaningfulEvents.length || events.length}</b>}
      </button>
  );
  const content = (
        <div className={styles.drawer}>
          <header className={styles.header}>
            <div>
              <div className={styles.eyebrow}>
                <Sparkles size={14} />
                Workflow Trace
              </div>
              {compact && <Dialog.Title className={styles.accessibleTitle}>工作流看板</Dialog.Title>}
              <h2>{sessionTitle || '当前任务'}</h2>
            </div>
            <button className={styles.iconButton} onClick={closeDrawer} aria-label="收起工作流看板" title="收起工作流看板">
              <PanelRightClose size={18} />
            </button>
          </header>

          {hasPendingApproval && <button className={styles.approvalShortcut} onClick={closeDrawer}>
            <ShieldCheck size={17} />返回工具确认
          </button>}

          <div className={styles.tabs} role="tablist">
            {tabs.map(tab => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  className={`${styles.tab} ${activeTab === tab.id ? styles.tabActive : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                >
                  <Icon size={15} />
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className={`${styles.content} ${activeTab !== 'realtime' ? styles.architectureContent : ''}`}>
            {activeTab === 'realtime' && (
              <RealtimeView
                events={events}
                meaningfulEvents={meaningfulEvents}
                activeEvent={activeEvent}
                isRunning={isRunning}
                offsets={scrollOffsets}
              />
            )}
            {open && activeTab === 'architecture' && <ArchitectureView events={events} isRunning={isRunning} savedViewports={savedViewports} saveViewport={saveViewport} />}
            {activeTab === 'log' && <EventLog key={runId} events={meaningfulEvents.length ? meaningfulEvents : events} offsets={scrollOffsets} />}
          </div>
        </div>
  );

  if (compact) return (
    <Dialog.Root open={open} onOpenChange={nextOpen => nextOpen ? setOpen(true) : closeDrawer()}>
      {triggerContainer && createPortal(<Dialog.Trigger asChild>{trigger}</Dialog.Trigger>, triggerContainer)}
      <Dialog.Portal>
        <Dialog.Overlay className={styles.backdrop} />
        <Dialog.Content asChild aria-describedby={undefined} onCloseAutoFocus={event => {
          event.preventDefault();
          window.requestAnimationFrame(() => triggerRef.current?.focus());
        }}>
          <aside className={styles.mobileShell} aria-label="工作流看板" data-run-id={runId}>
            {content}
          </aside>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );

  return (
    <>
      {triggerContainer && createPortal(trigger, triggerContainer)}
      <aside ref={shellRef} className={`${styles.shell} ${open ? styles.shellOpen : styles.shellClosed}`}
        style={{ width: open ? visibleWidth : 0 }} aria-label="工作流看板" data-run-id={runId}
        aria-hidden={!open} inert={!open}>
        {open && <div className={styles.resizeHandle} onMouseDown={startResize}
          role="separator" aria-label="调整工作流宽度" aria-orientation="vertical"
          tabIndex={0} aria-valuemin={MIN_WIDTH} aria-valuemax={availableWidth} aria-valuenow={visibleWidth}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            setWidth(event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? availableWidth
              : Math.max(MIN_WIDTH, Math.min(availableWidth, visibleWidth + (event.key === 'ArrowLeft' ? 20 : -20))));
          }} />}
        {open && content}
      </aside>
    </>
  );
}

const RealtimeView = memo(function RealtimeView({
  events,
  meaningfulEvents,
  activeEvent,
  isRunning,
  offsets,
}: {
  events: WorkflowEvent[];
  meaningfulEvents: WorkflowEvent[];
  activeEvent?: WorkflowEvent;
  isRunning: boolean;
  offsets: WorkflowScrollPositions;
}) {
  if (!events.length) {
    return (
      <div className={styles.emptyState}>
        <Activity size={22} />
        <p>发送多 Agent 任务后，这里会显示从上到下的实时流转。</p>
      </div>
    );
  }

  const flowEvents = meaningfulEvents.length ? meaningfulEvents : events;
  const groups = groupFlowEvents(flowEvents);
  const presentation = runPresentation(events, isRunning);
  const activeGroups = activeWorkflowGroups(events, isRunning);
  const sequence = new Map(events.map((event, index) => [event.eventId, index]));

  return (
    <div className={styles.realtimeStack}>
      <section className={styles.runSummary}>
        <div className={`${styles.liveDot} ${presentation.active ? styles.liveDotActive : ''}`} />
        <div>
          <span>{presentation.label}</span>
          <strong>{activeEvent?.summary || '等待下一步事件'}</strong>
        </div>
      </section>

      <div className={styles.groupedFlow}>
        {groups.map((group, index) => (
          <FlowGroupBlock
            key={group.id}
            group={group}
            groupIndex={index}
            isLast={index === groups.length - 1}
            active={activeGroups.has(group.kind)}
            sequence={sequence}
            offsets={offsets}
          />
        ))}
      </div>
    </div>
  );
});

function FlowGroupBlock({
  group,
  groupIndex,
  isLast,
  active,
  sequence,
  offsets,
}: {
  group: WorkflowGroup;
  groupIndex: number;
  isLast: boolean;
  active: boolean;
  sequence: Map<string, number>;
  offsets: WorkflowScrollPositions;
}) {
  return (
    <section className={`${styles.flowGroup} ${styles[`flow_${group.kind}`] || ''}`}>
      <header className={styles.flowGroupHeader}>
        <div className={`${styles.groupIcon} ${active ? styles.groupIconActive : ''}`}>
          <EventIcon event={group.events[0]} size={16} />
        </div>
        <div>
          <span>事件分类 {String(groupIndex + 1).padStart(2, '0')}</span>
          <h3>{group.label}</h3>
        </div>
        <b>{group.events.length}</b>
      </header>

      <WorkflowEventList events={group.events} className={styles.flowGroupBody} label={`${group.label}事件`}
        offsets={offsets} listId={group.id}
        renderEvent={event => <FlowCard event={event} index={sequence.get(event.eventId) || 0} />} />

      {!isLast && <div className={styles.groupConnector} aria-hidden />}
    </section>
  );
}

function FlowCard({ event, index }: { event: WorkflowEvent; index: number }) {
  const kind = kindForEvent(event.type);

  return (
    <article data-task-id={event.taskId} data-agent-id={event.agentId} className={`${styles.flowCard} ${styles[`flow_${kind}`] || ''}`}>
      <div className={styles.flowCardTop}>
        <span className={styles.stepBadge}>{String(index + 1).padStart(2, '0')}</span>
        <span className={`${styles.flowDotMini} ${styles[`status_${event.status}`] || ''}`}>
          <EventIcon event={event} size={13} />
        </span>
        <span className={styles.kindLabel}>{labelForType(event.type)}</span>
        <time>{formatTime(event.timestamp)}</time>
      </div>
      <h3>{event.summary}</h3>
      <div className={styles.flowMeta}>
        {event.agentId && <span>{readableAgent(event.agentId)}</span>}
        {event.taskId && <span>子任务 {event.taskId}</span>}
        {event.toolName && <span>{event.toolName}</span>}
        {event.resultLength !== undefined && <span>{event.resultLength} 字符</span>}
        {event.cost !== undefined && <span>${event.cost.toFixed(4)}</span>}
      </div>
    </article>
  );
}

const ArchitectureView = memo(function ArchitectureView({ events, isRunning, savedViewports, saveViewport }: {
  events: WorkflowEvent[];
  isRunning: boolean;
  savedViewports: ReadonlyMap<string, Viewport>;
  saveViewport: (runId: string, viewport: Viewport) => void;
}) {
  const [edgeLayer, setEdgeLayer] = useState<SVGGElement | null>(null);
  const currentAgents = useMemo(() => agentsForCurrentTask([], events), [events]);
  const graph = useMemo(() => buildArchitectureGraph(currentAgents, events, isRunning), [currentAgents, events, isRunning]);
  const runKey = events[0]?.runId || events[0]?.eventId || 'empty';

  if (!events.length) {
    return (
      <div className={styles.emptyState}>
        <GitBranch size={22} />
        <p>当前任务尚未架构 Agent。</p>
      </div>
    );
  }

  return (
    <ReactFlowProvider key={runKey}>
    <div className={styles.architectureView}>
      <header className={styles.architectureSummary}>
        <div>
          <h3>{new Set(currentAgents.map(agent => agent.agentId || agent.id)).size} 个 Agent · {currentAgents.length} 个执行实例</h3>
        </div>
        <b>{events.filter(isToolCall).length} 次工具调用</b>
      </header>

      <ArchitectureControls nodes={graph.nodes} />

      <div className={styles.flowCanvas}>
        <WorkflowEdgeLayerContext.Provider value={edgeLayer}>
        <ReactFlow
          key={runKey}
          nodes={graph.nodes}
          edges={graph.edges}
          edgeTypes={workflowEdgeTypes}
          defaultViewport={savedViewports.get(runKey) || { x: 20, y: 24, zoom: 1 }}
          onMoveEnd={(_event, viewport) => saveViewport(runKey, viewport)}
          minZoom={MIN_GRAPH_ZOOM}
          maxZoom={1.4}
          panOnScroll
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          onlyRenderVisibleElements={false}
          defaultEdgeOptions={{
            animated: false,
            markerEnd: { type: MarkerType.ArrowClosed, markerUnits: 'userSpaceOnUse' },
            style: { strokeWidth: 2.4 },
          }}
        >
          <Background gap={18} size={1} />
          <WorkflowEdgeLayer onReady={setEdgeLayer} />
          <WorkflowEdgeMotion layer={edgeLayer} />
          <MiniMap pannable zoomable className={styles.miniMap} style={{ width: 110, height: 72 }} />
        </ReactFlow>
        </WorkflowEdgeLayerContext.Provider>
      </div>
    </div>
    </ReactFlowProvider>
  );
});

function WorkflowEdgeLayer({ onReady }: { onReady: (element: SVGGElement | null) => void }) {
  const { x, y, zoom } = useViewport();
  return <svg className={styles.sharedEdgeLayer} aria-hidden="true">
    <g ref={onReady} transform={`translate(${x} ${y}) scale(${zoom})`} />
  </svg>;
}

function ArchitectureControls({ nodes }: { nodes: Node[] }) {
  const { fitView, zoomIn, zoomOut, zoomTo } = useReactFlow();
  const { zoom } = useViewport();
  const initialized = useNodesInitialized({ includeHiddenNodes: true });
  return (
    <div className={styles.graphToolbar}>
      <select aria-label="定位架构节点" disabled={!initialized} value="" onChange={event => {
        if (event.target.value) void fitView({ nodes: [{ id: event.target.value }], padding: 0.08, minZoom: 1, maxZoom: 1 });
      }}>
        <option value="" disabled>定位节点</option>
        {nodes.map(node => <option key={node.id} value={node.id}>{String(node.data.navigationLabel)}</option>)}
      </select>
      <button disabled={!initialized} className={styles.iconButton} onClick={() => void zoomOut()} aria-label="缩小架构" title="缩小架构"><ZoomOut size={16} /></button>
      <output aria-label="架构缩放比例">{zoom < 0.01 ? (zoom * 100).toFixed(1) : Math.round(zoom * 100)}%</output>
      <button disabled={!initialized} className={styles.iconButton} onClick={() => void zoomIn()} aria-label="放大架构" title="放大架构"><ZoomIn size={16} /></button>
      <button disabled={!initialized} className={styles.iconButton} onClick={() => void zoomTo(1)} aria-label="恢复原始比例" title="恢复原始比例"><Focus size={16} /></button>
      <button disabled={!initialized} className={styles.iconButton} onClick={() => void fitView({ padding: 0.1, minZoom: MIN_GRAPH_ZOOM, maxZoom: 1 })} aria-label="查看架构全景" title="查看架构全景"><Maximize size={16} /></button>
    </div>
  );
}

function buildArchitectureGraph(agents: AgentCard[], events: WorkflowEvent[], isRunning: boolean): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const governanceEvents = events.filter(event => event.type === 'governance');
  const hasSynthesis = events.some(event => event.type === 'synthesis_start' || event.type === 'complete');
  const agentPositions = new Map<string, { x: number; y: number }>();
  const eventIndex = indexAgentEvents(agents, events);
  const toolGroups = groupToolEvents(agents, events, eventIndex.resolveOwner);
  const toolsByAgent = new Map<string, typeof toolGroups>();
  for (const group of toolGroups) {
    if (!group.agentId) continue;
    const groups = toolsByAgent.get(group.agentId) || [];
    groups.push(group);
    toolsByAgent.set(group.agentId, groups);
  }
  const parents = new Map(agents.map(agent => [agent.id, parentForAgent(agent, agents, eventIndex.byAgent.get(agent.id) || [])]));
  const running = runPresentation(events, isRunning).active;

  nodes.push({
    id: 'orchestrator',
    type: 'default',
    position: { x: GRAPH_ORCHESTRATOR_X, y: 0 },
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    data: {
      navigationLabel: 'Orchestrator',
      label: (
        <GraphNodeCard
          icon={<Sparkles size={18} />}
          title="Orchestrator"
          subtitle="任务拆解 / 调度 / 治理 / 综合"
          accent="orchestrator"
          metrics={[`${agents.length} 个执行实例`, runPresentation(events, isRunning).label]}
        />
      ),
    },
  });

  let nextAgentY = GRAPH_START_Y;
  agents.forEach(agent => {
    const agentTools = toolsByAgent.get(agent.id) || [];
    const blockHeight = Math.max(GRAPH_MIN_AGENT_BLOCK, agentTools.length * GRAPH_TOOL_ROW_GAP + 24);
    const x = GRAPH_AGENT_X;
    const y = nextAgentY;
    nextAgentY += blockHeight;
    agentPositions.set(agent.id, { x, y });

    const agentEvents = eventIndex.byAgent.get(agent.id) || [];
    const objective = String(agentEvents.find(event => event.data.objective)?.data.objective || agent.description);
    const latest = agentEvents[agentEvents.length - 1];

    nodes.push({
      id: agentNodeId(agent.id),
      type: 'default',
      position: { x, y },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        navigationLabel: `${agent.name}${agent.taskId ? ` · ${agent.taskId}` : ''}`,
        label: (
          <AgentGraphCard
            agent={agent}
            objective={objective}
            status={agentRunStatus(agentEvents, running)}
            cost={agentEvents.some(event => event.type === 'agent_complete' && event.cost !== undefined)
              ? agentEvents.filter(event => event.type === 'agent_complete').reduce((sum, event) => sum + (event.cost || 0), 0) : undefined}
            usedTools={[...new Set(agentTools.map(group => group.toolName))]}
            input={agentEvents.find(event => event.type === 'agent_spawn')?.summary}
            output={String(agentEvents.findLast(event => event.type === 'agent_complete')?.data.outputSummary || agentEvents.findLast(event => event.type === 'agent_complete')?.summary || latest?.summary || '')}
          />
        ),
      },
    });

    const parentId = parents.get(agent.id);
    if (parentId) edges.push({ ...createWorkflowEdge(`parent:${agent.id}`, agentNodeId(parentId), agentNodeId(agent.id)),
      data: { relation: parentId === 'orchestrator' ? 'dispatch' : 'parent' } });
  });

  for (const relation of taskDependencyEdges(agents, events, eventIndex.resolveOwner)) {
    if (parents.get(relation.target) === relation.source) continue;
    edges.push({
      ...createWorkflowEdge(`depends:${JSON.stringify(relation)}`, agentNodeId(relation.source), agentNodeId(relation.target)),
      data: { relation: 'dependency' },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#13846b', width: 18, height: 18, markerUnits: 'userSpaceOnUse' },
    });
  }

  for (const agent of agents) {
    const agentPosition = agentPositions.get(agent.id);
    const groups = toolsByAgent.get(agent.id) || [];
    if (!agentPosition) continue;

    groups.forEach((group, index) => {
      const nodeId = `tool:${group.id}`;
      nodes.push({
        id: nodeId,
        position: { x: GRAPH_TOOL_X, y: agentPosition.y + index * GRAPH_TOOL_ROW_GAP },
        targetPosition: Position.Left,
        sourcePosition: Position.Right,
        data: {
          navigationLabel: `${group.toolName} · ${agent.name}${agent.taskId ? ` · ${agent.taskId}` : ''}`,
          label: (
            <GraphNodeCard
              icon={<TerminalSquare size={16} />}
              title={group.toolName}
              subtitle="工具 / MCP"
              accent="tool"
              metrics={[`${group.calls} 次调用`, `${group.resultLength} 字符返回`]}
            />
          ),
        },
      });
      edges.push(createWorkflowEdge(`use:${group.id}`, agentNodeId(agent.id), nodeId));
    });
  }

  const otherTools = toolGroups.filter(group => !group.agentId || group.agentId === 'orchestrator');
  otherTools.forEach((group, index) => {
    const nodeId = `tool:${group.id}`;
    nodes.push({
      id: nodeId,
      position: { x: GRAPH_TOOL_X, y: nextAgentY + index * GRAPH_TOOL_ROW_GAP },
      targetPosition: Position.Left,
      data: { navigationLabel: group.toolName, label: <GraphNodeCard icon={<TerminalSquare size={16} />} title={group.toolName}
        subtitle={group.agentId ? '主 Agent 工具' : group.events[0].agentId ? '未记录子任务归属' : '未记录调用方'} accent="tool"
        metrics={[`${group.calls} 次调用`, `${group.resultLength} 字符返回`]} /> },
    });
    if (group.agentId) edges.push(createWorkflowEdge(`use:${group.id}`, 'orchestrator', nodeId));
  });

  const supportY = nextAgentY + otherTools.length * GRAPH_TOOL_ROW_GAP + 20;

  if (governanceEvents.length) {
    nodes.push({
      id: 'governance',
      position: { x: GRAPH_AGENT_X, y: supportY },
      targetPosition: Position.Left,
      sourcePosition: Position.Right,
      data: {
        navigationLabel: '治理检查',
        label: (
          <GraphNodeCard
            icon={<ShieldCheck size={16} />}
            title="Governance"
            subtitle="成本 / 安全 / 质量检查"
            accent="governance"
            metrics={[`${governanceEvents.length} checks`, `${governanceEvents.filter(event => event.status === 'warning').length} warnings`]}
          />
        ),
      },
    });
    const checkedAgents = new Set(governanceEvents.map(eventIndex.resolveOwner).filter(Boolean));
    for (const agentId of checkedAgents) {
      edges.push(createWorkflowEdge(`check:${agentId}`, agentNodeId(agentId!), 'governance'));
    }
  }

  if (hasSynthesis) {
    nodes.push({
      id: 'synthesis',
      position: { x: GRAPH_TOOL_X, y: supportY + (governanceEvents.length ? 0 : 20) },
      targetPosition: Position.Left,
      data: {
        navigationLabel: '综合输出',
        label: (
          <GraphNodeCard
            icon={<FileText size={16} />}
            title="综合输出"
            subtitle="汇总子 Agent 结论"
            accent="synthesis"
            metrics={[runPresentation(events, isRunning).label]}
          />
        ),
      },
    });
    edges.push(createWorkflowEdge('summary:orchestrator', 'orchestrator', 'synthesis'));
    for (const agent of agents) {
      if (eventIndex.byAgent.get(agent.id)?.some(event => event.type === 'agent_complete')) {
        edges.push(createWorkflowEdge(`summary:${agent.id}`, agentNodeId(agent.id), 'synthesis'));
      }
    }
  }

  // These read-only cards have fixed CSS dimensions; publish them to the controlled graph
  // so viewport tools do not wait for an unhandled dimensions-change event.
  return { nodes: nodes.map(node => ({ ...node, width: 250, height: node.id.startsWith('agent:') ? 332 : 104 })), edges };
}

function createWorkflowEdge(id: string, source: string, target: string): Edge {
  return {
    id,
    source,
    target,
    type: 'workflowRelation',
    animated: false,
    selectable: false,
    markerEnd: { type: MarkerType.ArrowClosed, color: '#5b55ff', width: 18, height: 18, markerUnits: 'userSpaceOnUse' },
    style: { stroke: '#5b55ff', strokeWidth: 2.6 },
  };
}

function WorkflowRelationEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps) {
  const edgeLayer = useContext(WorkflowEdgeLayerContext);
  const { x, y, zoom } = useViewport();
  const width = useStore(state => state.width);
  const height = useStore(state => state.height);
  const view = { left: -x / zoom - 24, top: -y / zoom - 24, right: (width - x) / zoom + 24, bottom: (height - y) / zoom + 24 };
  const gutter = workflowGutter(source, target, { x: sourceX, y: sourceY }, { x: targetX, y: targetY },
    { agentX: GRAPH_AGENT_X, toolX: GRAPH_TOOL_X, agentStride: GRAPH_MIN_AGENT_BLOCK });
  const defaultPath = gutter ? '' : getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 22,
  })[0];
  const edgePath = gutter ? gutter.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ') : defaultPath;
  const motionPath = gutter ? clipOrthogonalMotion(gutter, view)
    : Math.max(sourceY, targetY) + 32 < view.top || Math.min(sourceY, targetY) - 32 > view.bottom
      || Math.max(sourceX, targetX) + 32 < view.left || Math.min(sourceX, targetX) - 32 > view.right ? '' : defaultPath;
  const targetVisible = targetX >= view.left && targetX <= view.right && targetY >= view.top && targetY <= view.bottom;
  const last = gutter?.at(-2);
  const inkScale = Math.min(1, Math.sqrt(zoom));

  // React Flow still owns every relation and endpoint; paint them in one SVG, not hundreds.
  return edgeLayer ? createPortal(
    <g className={`${styles.workflowRelationEdge} ${data?.relation === 'dependency' ? styles.dependencyRelation : ''}`}>
      <title>{data?.relation === 'dependency' ? '任务依赖' : data?.relation === 'parent' ? '父子分工' : '工作流关系'}</title>
      <path className={styles.workflowRelationHalo} d={motionPath} style={{ strokeWidth: 11 * inkScale }} />
      <path id={id} className={styles.workflowRelationPath} data-full-path={edgePath} d={motionPath}
        style={{ strokeWidth: 2.8 * inkScale }} markerEnd={gutter ? undefined : markerEnd} />
      {last && targetVisible && <path className={styles.workflowRelationArrow} d={`M ${last.x} ${last.y} L ${targetX} ${targetY}`} markerEnd={markerEnd} />}
    </g>, edgeLayer, id
  ) : null;
}

function agentNodeId(id: string) {
  return id === 'orchestrator' ? id : `agent:${id}`;
}

function GraphNodeCard({
  icon,
  title,
  subtitle,
  accent,
  metrics,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  accent: string;
  metrics: string[];
}) {
  return (
    <div className={`${styles.graphNode} ${styles[`graphNode_${accent}`] || ''}`}>
      <div className={styles.graphNodeHeader}>
        <span>{icon}</span>
        <div>
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </div>
      </div>
      <div className={styles.graphNodeMetrics}>
        {metrics.map(metric => <b key={metric}>{metric}</b>)}
      </div>
    </div>
  );
}

function AgentGraphCard({
  agent,
  objective,
  status,
  input,
  output,
  cost,
  usedTools,
}: {
  agent: AgentCard;
  objective: string;
  status: WorkflowStatus;
  input?: string;
  output?: string;
  cost?: number;
  usedTools: string[];
}) {
  const skills = agent.capabilities?.skills || [];
  const mcp = agent.capabilities?.mcpServers || [];
  const checks = agent.card?.qualityChecks || [];

  return (
    <div data-agent-id={agent.agentId || agent.id} data-task-id={agent.taskId} className={`nowheel nopan nodrag ${styles.graphAgentCard} ${styles[`status_${status}`] || ''}`}>
      <div className={styles.graphAgentHeader}>
        <span className={styles.agentIcon}>{agent.icon || '◆'}</span>
        <div>
          <strong>{agent.name}</strong>
          {agent.taskId && <small>子任务 {agent.taskId}</small>}
          <small>{statusLabel(status)} · {cost === undefined ? '费用未记录' : `已记录费用 $${cost.toFixed(4)}`}</small>
        </div>
      </div>
      <p>{truncate(objective, 86)}</p>
      <dl className={styles.graphAgentFacts}>
        <div><dt>输入</dt><dd>{truncate(input || '任务目标', 42)}</dd></div>
        <div><dt>输出</dt><dd>{truncate(output || '等待结果', 42)}</dd></div>
      </dl>
      <div className={styles.chips}>
        {usedTools.map(tool => <span key={tool}>{tool}</span>)}
      </div>
      {agent.configurationRecorded ? <details className={styles.configReference}>
        <summary>启动时能力记录</summary>
        <p>角色：{agent.role || '未记录'}<br />Skills 绑定：{skills.join('、') || '无'}<br />MCP 绑定：{mcp.join('、') || '无'}<br />允许工具：{agent.constraints?.allowedTools?.join('、') || '无'}<br />预算：${agent.constraints?.maxCostPerTask?.toFixed(2) ?? '未记录'}<br />质量规则：{checks.join('；') || '无'}</p>
      </details> : <p className={styles.configReference}>历史记录未保存能力配置</p>}
    </div>
  );
}

const EventLog = memo(function EventLog({ events, offsets }: { events: WorkflowEvent[]; offsets: WorkflowScrollPositions }) {
  const [query, setQuery] = useState('');
  const searchScroll = useMemo(() => ({ query, offsets: new Map() as WorkflowScrollPositions }), [query]);
  const matching = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term ? events.filter(event => [event.summary, event.agentId, event.taskId, event.toolName, event.type,
      labelForType(event.type)].some(value => value?.toLocaleLowerCase().includes(term))) : events;
  }, [events, query]);
  if (!events.length) {
    return (
      <div className={styles.emptyState}>
        <FileText size={22} />
        <p>事件日志会在任务开始后自动写入。</p>
      </div>
    );
  }

  return (
    <div className={styles.logView}>
      <label className={styles.logSearch}><Search size={16} aria-hidden />
        <input type="search" aria-label="搜索当前任务事件" placeholder="搜索事件、Agent、工具" value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      <output className={styles.logCount} aria-label="匹配事件数">{matching.length} / {events.length} 条事件</output>
      {matching.length ? <WorkflowEventList key={query} events={matching} className={styles.logList} label="任务事件日志"
        offsets={query ? searchScroll.offsets : offsets} listId="log" renderEvent={event => <EventRow event={event} />} />
        : <p className={styles.emptyState}>没有匹配的事件</p>}
    </div>
  );
});

function EventRow({ event }: { event: WorkflowEvent }) {
  return (
    <div data-task-id={event.taskId} data-agent-id={event.agentId} className={styles.eventRow}>
      <div className={`${styles.eventIcon} ${styles[`status_${event.status}`] || ''}`}>
        <EventIcon event={event} size={15} />
      </div>
      <div className={styles.eventBody}>
        <div className={styles.eventMeta}>
          <span>{labelForType(event.type)}</span>
          <time>{formatTime(event.timestamp)}</time>
        </div>
        <p>{event.summary}</p>
        {(event.taskId || event.toolName || event.resultLength || event.cost) && (
          <div className={styles.eventDetails}>
            {event.taskId && <span>子任务 {event.taskId}</span>}
            {event.toolName && <span>{event.toolName}</span>}
            {event.resultLength !== undefined && <span>{event.resultLength} 字符</span>}
            {event.cost !== undefined && <span>${event.cost.toFixed(4)}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function EventIcon({ event, size }: { event: WorkflowEvent; size: number }) {
  if (event.status === 'failed' || event.status === 'blocked') return <XCircle size={size} />;
  if (event.type === 'task_decomposition') return <Layers3 size={size} />;
  if (event.type.includes('tool')) return <TerminalSquare size={size} />;
  if (event.type === 'governance') return <ShieldCheck size={size} />;
  if (event.type.includes('complete')) return <CheckCircle2 size={size} />;
  if (event.type.includes('failed') || event.type === 'error') return <XCircle size={size} />;
  if (event.type === 'synthesis_start') return <FileText size={size} />;
  if (event.type.includes('agent')) return <Bot size={size} />;
  return <ChevronRight size={size} />;
}

function labelForType(type: string) {
  const labels: Record<string, string> = {
    task_decomposition: '任务拆解',
    agent_spawn: 'Agent 启动',
    agent_progress: 'Agent 推理',
    agent_stage: '执行阶段',
    agent_tool_call: '工具调用',
    agent_tool_result: '工具结果',
    tool_call: '工具调用',
    tool_result: '工具结果',
    governance: '治理检查',
    agent_complete: 'Agent 完成',
    agent_failed: 'Agent 失败',
    synthesis_start: '综合整理',
    complete: '运行结束',
    error: '错误',
  };

  return labels[type] || type;
}

function statusLabel(status: WorkflowStatus) {
  return ({ pending: '未记录完成', running: '执行中', complete: '已完成', passed: '检查通过', failed: '未完成', blocked: '已拦截', warning: '需核对' })[status];
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp));
}
