'use client';

/**
 * WorkflowPanel — 实时工作流看板 (plan §4.3)
 *
 * 使用 React Flow (@xyflow/react) 可视化多 Agent 协作流程。
 * 4 种自定义节点：Orchestrator / Agent / Governance / Synthesis
 */

import { useMemo, useState, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  type Node,
  type Edge,
  type NodeTypes,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// ─── Types ───────────────────────────────────────────

interface TraceEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

interface WorkflowPanelProps {
  traces: TraceEvent[];
  isRunning: boolean;
}

// ─── Custom Nodes ────────────────────────────────────

function OrchestratorNode({ data }: { data: { label: string; status: string } }) {
  return (
    <div style={{
      padding: '12px 20px', borderRadius: '12px',
      background: 'linear-gradient(135deg, #7c3aed, #6366f1)',
      border: '2px solid rgba(139, 92, 246, 0.6)',
      color: '#fff', fontWeight: 600, fontSize: '13px', textAlign: 'center', minWidth: '140px',
      boxShadow: data.status === 'active' ? '0 0 20px rgba(124, 58, 237, 0.5)' : '0 4px 12px rgba(0,0,0,0.3)',
      animation: data.status === 'active' ? 'pulse 2s ease-in-out infinite' : 'none',
    }}>
      ⚡ {data.label}
      {data.status === 'active' && <div style={{ fontSize: '10px', opacity: 0.8, marginTop: '4px' }}>编排中...</div>}
    </div>
  );
}

/** D8: AgentNode — 消费 4 维状态 (business/runtime/humanInteraction/orchestration) */
function AgentNode({ data }: { data: {
  label: string; icon: string; status: string; iterations?: number; cost?: number;
  // D8: 4 维状态字段
  businessState?: string;    // idle | busy | done
  runtimeState?: string;     // ok | error | paused
  humanState?: string;       // none | waiting_human | human_override
  orchestrationState?: string; // standalone | fissioned | orchestrating
} }) {
  const statusColors: Record<string, string> = { idle: '#4b5563', running: '#059669', complete: '#2563eb', failed: '#dc2626' };
  let borderColor = statusColors[data.status] || '#4b5563';

  // D8: runtime:error → 红色边框
  if (data.runtimeState === 'error') borderColor = '#ef4444';
  // D8: humanInteraction:waiting_human → 黄色
  if (data.humanState === 'waiting_human') borderColor = '#eab308';

  const isPulsing = data.status === 'running' || data.businessState === 'busy';
  const isWaitingHuman = data.humanState === 'waiting_human';
  const isFissioned = data.orchestrationState === 'fissioned';

  return (
    <div style={{
      padding: '10px 16px', borderRadius: '10px',
      background: 'rgba(30, 41, 59, 0.95)', border: `2px solid ${borderColor}`,
      color: '#e2e8f0', fontSize: '12px', minWidth: '120px',
      boxShadow: isPulsing ? `0 0 16px ${borderColor}50` : '0 4px 8px rgba(0,0,0,0.2)',
      animation: isPulsing ? 'pulse 2s ease-in-out infinite' : isWaitingHuman ? 'humanFlash 1s ease-in-out infinite' : 'none',
    }}>
      <div style={{ fontWeight: 600, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
        {data.icon} {data.label}
        {isWaitingHuman && <span title="等待用户确认" style={{ fontSize: '14px' }}>👤</span>}
        {isFissioned && <span title="已裂变子 Agent" style={{ fontSize: '10px', color: '#a78bfa' }}>⑂</span>}
      </div>
      {data.status === 'running' && <div style={{ fontSize: '10px', color: '#10b981' }}>⏳ 迭代 #{data.iterations || 0}</div>}
      {data.status === 'complete' && data.cost !== undefined && <div style={{ fontSize: '10px', color: '#60a5fa' }}>✅ ${data.cost.toFixed(4)}</div>}
      {data.status === 'failed' && <div style={{ fontSize: '10px', color: '#f87171' }}>❌ 失败</div>}
      {data.runtimeState === 'error' && <div style={{ fontSize: '10px', color: '#ef4444' }}>⚠️ 运行时错误</div>}
    </div>
  );
}

function SynthesisNode({ data }: { data: { label: string; status: string } }) {
  return (
    <div style={{
      padding: '12px 20px', borderRadius: '12px',
      background: 'linear-gradient(135deg, #0d9488, #0891b2)',
      border: '2px solid rgba(20, 184, 166, 0.6)',
      color: '#fff', fontWeight: 600, fontSize: '13px', textAlign: 'center', minWidth: '140px',
      boxShadow: data.status === 'active' ? '0 0 20px rgba(20, 184, 166, 0.5)' : '0 4px 12px rgba(0,0,0,0.3)',
    }}>
      📝 {data.label}
    </div>
  );
}

/** 治理节点 (plan §3.10 §5) — 红色=拦截 / 绿色=通过 / 黄色=豁免 */
function GovernanceNode({ data }: { data: { label: string; result: string; message: string } }) {
  const colors: Record<string, { bg: string; border: string; icon: string }> = {
    blocked: { bg: 'rgba(220, 38, 38, 0.15)', border: '#dc2626', icon: '🛑' },
    warning: { bg: 'rgba(245, 158, 11, 0.15)', border: '#f59e0b', icon: '⚠️' },
    passed:  { bg: 'rgba(34, 197, 94, 0.15)', border: '#22c55e', icon: '✅' },
  };
  const c = colors[data.result] || colors.passed;

  return (
    <div style={{
      padding: '8px 14px', borderRadius: '8px',
      background: c.bg, border: `2px solid ${c.border}`,
      color: '#e2e8f0', fontSize: '11px', minWidth: '100px', maxWidth: '180px',
      boxShadow: data.result === 'blocked' ? '0 0 12px rgba(220, 38, 38, 0.4)' : '0 2px 6px rgba(0,0,0,0.2)',
    }}>
      <div style={{ fontWeight: 600, marginBottom: '2px' }}>{c.icon} {data.label}</div>
      <div style={{ fontSize: '10px', opacity: 0.8, lineHeight: 1.3 }}>{data.message.slice(0, 60)}</div>
    </div>
  );
}

// ─── Node Types ──────────────────────────────────────

const nodeTypes: NodeTypes = {
  orchestrator: OrchestratorNode,
  agent: AgentNode,
  synthesis: SynthesisNode,
  governance: GovernanceNode,
};

// ─── Build Graph from Traces ─────────────────────────

function buildGraph(traces: TraceEvent[], isRunning: boolean): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const agentMap = new Map<string, { name: string; icon: string; status: string; iterations: number; cost: number }>();
  const govEvents: { agentId: string; result: string; message: string; type: string }[] = [];
  let hasDecomposition = false;
  let hasSynthesis = false;

  for (const t of traces) {
    switch (t.type) {
      case 'task_decomposition': hasDecomposition = true; break;
      case 'agent_spawn':
        agentMap.set(t.data.agentId as string, {
          name: (t.data.agentName as string) || (t.data.agentId as string),
          icon: (t.data.icon as string) || '⚡',
          status: 'running', iterations: 0, cost: 0,
        });
        break;
      case 'agent_progress': {
        const a = agentMap.get(t.data.agentId as string);
        if (a) a.iterations = t.data.iteration as number;
        break;
      }
      case 'agent_complete': {
        const a = agentMap.get(t.data.agentId as string);
        if (a) { a.status = 'complete'; a.cost = t.data.cost as number; }
        break;
      }
      case 'agent_failed': {
        const a = agentMap.get(t.data.agentId as string);
        if (a) a.status = 'failed';
        break;
      }
      case 'governance': {
        const result = (t.data.result as string) || ((t.data.type as string)?.includes('blocked') ? 'blocked' : 'warning');
        govEvents.push({
          agentId: (t.data.agentId as string) || 'orchestrator',
          result,
          message: (t.data.message as string) || '',
          type: (t.data.type as string) || 'governance',
        });
        break;
      }
      case 'synthesis_start': hasSynthesis = true; break;
    }
  }

  if (!hasDecomposition && agentMap.size === 0) return { nodes: [], edges: [] };

  // Orchestrator
  nodes.push({
    id: 'orchestrator', type: 'orchestrator',
    position: { x: 250, y: 20 },
    data: { label: 'Orchestrator', status: isRunning ? 'active' : 'idle' },
    sourcePosition: Position.Bottom, targetPosition: Position.Top,
  });

  // Agent nodes
  const agents = Array.from(agentMap.entries());
  const spacing = 200;
  const startX = 250 - ((agents.length - 1) * spacing) / 2;

  agents.forEach(([id, agent], i) => {
    nodes.push({
      id, type: 'agent',
      position: { x: startX + i * spacing, y: 130 },
      data: { label: agent.name, icon: agent.icon, status: agent.status, iterations: agent.iterations, cost: agent.cost },
      sourcePosition: Position.Bottom, targetPosition: Position.Top,
    });
    edges.push({
      id: `e-orch-${id}`, source: 'orchestrator', target: id,
      animated: agent.status === 'running',
      style: { stroke: agent.status === 'running' ? '#8b5cf6' : agent.status === 'complete' ? '#2563eb' : '#4b5563', strokeWidth: 2 },
    });
  });

  // Synthesis
  const synthY = govEvents.length > 0 ? 310 : 250;
  if (hasSynthesis || (!isRunning && agents.some(([, a]) => a.status === 'complete'))) {
    nodes.push({
      id: 'synthesis', type: 'synthesis',
      position: { x: 250, y: synthY },
      data: { label: '综合报告', status: hasSynthesis ? 'active' : 'idle' },
      sourcePosition: Position.Bottom, targetPosition: Position.Top,
    });
    agents.forEach(([id, agent]) => {
      if (agent.status === 'complete') {
        edges.push({
          id: `e-${id}-synth`, source: id, target: 'synthesis',
          animated: hasSynthesis && isRunning,
          style: { stroke: '#14b8a6', strokeWidth: 2 },
        });
      }
    });
  }

  // Governance nodes (plan §3.10: 盾牌节点)
  govEvents.forEach((gov, i) => {
    const govId = `gov-${i}`;
    const agentIdx = agents.findIndex(([id]) => id === gov.agentId);
    const govX = agentIdx >= 0 ? startX + agentIdx * spacing + 130 : 400;
    const govY = 190;
    const label = gov.result === 'blocked' ? '治理拦截' : gov.result === 'warning' ? '治理警告' : '治理通过';

    nodes.push({
      id: govId, type: 'governance',
      position: { x: govX, y: govY },
      data: { label, result: gov.result, message: gov.message },
      sourcePosition: Position.Bottom, targetPosition: Position.Top,
    });

    if (agentIdx >= 0) {
      edges.push({
        id: `e-${agents[agentIdx][0]}-${govId}`,
        source: agents[agentIdx][0], target: govId,
        style: { stroke: gov.result === 'blocked' ? '#dc2626' : '#f59e0b', strokeWidth: 1.5, strokeDasharray: '4 2' },
      });
    }
  });

  return { nodes, edges };
}

// ─── Static Team View ────────────────────────────────

function StaticTeamView() {
  const [agents, setAgents] = useState<any[]>([]);

  useEffect(() => {
    fetch('http://localhost:3001/api/agents')
      .then(r => r.json())
      .then(d => setAgents(d.agents || []));
  }, []);

  return (
    <div style={{ padding: '16px', overflowY: 'auto', height: '100%', color: '#e2e8f0', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
      {agents.map(a => (
        <div key={a.id} style={{
          background: 'rgba(30, 41, 59, 0.95)', border: '1px solid #475569', borderRadius: '12px',
          padding: '16px', width: '220px', display: 'flex', flexDirection: 'column', gap: '8px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '32px', height: '32px', background: 'rgba(124, 58, 237, 0.2)', color: '#a78bfa', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '8px' }}>
              {a.icon || '🤖'}
            </div>
            <div style={{ fontWeight: 600, fontSize: '14px' }}>{a.name}</div>
          </div>
          <div style={{ fontSize: '11px', color: '#94a3b8' }}>
            <strong>Skills:</strong> {a.capabilities.skills?.length ? a.capabilities.skills.join(', ') : '无'}
          </div>
          <div style={{ fontSize: '11px', color: '#94a3b8' }}>
            <strong>Tools:</strong> {a.capabilities.allowedTools?.join(', ')}
          </div>
          <div style={{ fontSize: '11px', color: '#94a3b8' }}>
            <strong>MCP:</strong> {a.capabilities.mcpServers?.length ? a.capabilities.mcpServers.join(', ') : '无'}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Component ───────────────────────────────────────

export default function WorkflowPanel({ traces, isRunning }: WorkflowPanelProps) {
  const [viewMode, setViewMode] = useState<'realtime' | 'static'>('realtime');
  const { nodes, edges } = useMemo(() => buildGraph(traces, isRunning), [traces, isRunning]);

  if (nodes.length === 0 && viewMode === 'realtime') return null;

  return (
    <div style={{
      height: '320px', borderRadius: '12px',
      background: 'rgba(15, 23, 42, 0.8)',
      border: '1px solid rgba(100, 116, 139, 0.3)',
      overflow: 'hidden', marginBottom: '16px',
      display: 'flex', flexDirection: 'column' as const,
      flexShrink: 0,
    }}>
      <div style={{
        padding: '8px 14px', fontSize: '12px', fontWeight: 600, color: '#94a3b8',
        borderBottom: '1px solid rgba(100, 116, 139, 0.2)',
        display: 'flex', alignItems: 'center', gap: '16px',
        flexShrink: 0, justifyContent: 'space-between'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span>🔄</span> 工作流看板
          {isRunning && <span style={{ color: '#8b5cf6' }}>● 执行中</span>}
        </div>
        
        <div style={{ display: 'flex', gap: '4px', background: 'rgba(15, 23, 42, 0.5)', padding: '2px', borderRadius: '6px', border: '1px solid rgba(100,116,139,0.2)' }}>
          <button 
            onClick={() => setViewMode('realtime')}
            style={{ 
              background: viewMode === 'realtime' ? 'rgba(51, 65, 85, 1)' : 'transparent', 
              color: viewMode === 'realtime' ? '#fff' : '#94a3b8',
              border: 'none', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', transition: 'all 0.2s'
            }}>实时视图</button>
          <button 
            onClick={() => setViewMode('static')}
            style={{ 
              background: viewMode === 'static' ? 'rgba(51, 65, 85, 1)' : 'transparent', 
              color: viewMode === 'static' ? '#fff' : '#94a3b8',
              border: 'none', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', transition: 'all 0.2s'
            }}>静态架构</button>
        </div>
      </div>
      
      {viewMode === 'static' ? (
        <div style={{ flex: 1, width: '100%', overflow: 'hidden' }}>
          <StaticTeamView />
        </div>
      ) : (
        <div style={{ position: 'relative' as const, flex: 1, width: '100%' }}>
          <div style={{ position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 }}>
            <ReactFlow
              nodes={nodes} edges={edges} nodeTypes={nodeTypes}
              fitView proOptions={{ hideAttribution: true }}
              nodesDraggable={false} nodesConnectable={false}
              zoomOnScroll={false} panOnScroll={false} panOnDrag={false}
              style={{ width: '100%', height: '100%', background: 'transparent' }}
            >
              <Background color="rgba(100, 116, 139, 0.1)" gap={20} />
            </ReactFlow>
          </div>
        </div>
      )}
    </div>
  );
}
