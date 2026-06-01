'use client';

/**
 * WorkflowPanel — 实时工作流看板 (plan §4.3)
 *
 * 使用 React Flow (@xyflow/react) 可视化多 Agent 协作流程。
 * 4 种自定义节点：Orchestrator / Agent / Governance / Synthesis
 */

import { useMemo } from 'react';
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

function AgentNode({ data }: { data: { label: string; icon: string; status: string; iterations?: number; cost?: number } }) {
  const colors: Record<string, string> = { idle: '#4b5563', running: '#059669', complete: '#2563eb', failed: '#dc2626' };
  const bc = colors[data.status] || '#4b5563';

  return (
    <div style={{
      padding: '10px 16px', borderRadius: '10px',
      background: 'rgba(30, 41, 59, 0.95)', border: `2px solid ${bc}`,
      color: '#e2e8f0', fontSize: '12px', minWidth: '120px',
      boxShadow: data.status === 'running' ? `0 0 16px ${bc}50` : '0 4px 8px rgba(0,0,0,0.2)',
    }}>
      <div style={{ fontWeight: 600, marginBottom: '4px' }}>{data.icon} {data.label}</div>
      {data.status === 'running' && <div style={{ fontSize: '10px', color: '#10b981' }}>⏳ 迭代 #{data.iterations || 0}</div>}
      {data.status === 'complete' && data.cost !== undefined && <div style={{ fontSize: '10px', color: '#60a5fa' }}>✅ ${data.cost.toFixed(4)}</div>}
      {data.status === 'failed' && <div style={{ fontSize: '10px', color: '#f87171' }}>❌ 失败</div>}
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

// ─── Node Types ──────────────────────────────────────

const nodeTypes: NodeTypes = {
  orchestrator: OrchestratorNode,
  agent: AgentNode,
  synthesis: SynthesisNode,
};

// ─── Build Graph from Traces ─────────────────────────

function buildGraph(traces: TraceEvent[], isRunning: boolean): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const agentMap = new Map<string, { name: string; icon: string; status: string; iterations: number; cost: number }>();
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
  if (hasSynthesis || (!isRunning && agents.some(([, a]) => a.status === 'complete'))) {
    nodes.push({
      id: 'synthesis', type: 'synthesis',
      position: { x: 250, y: 250 },
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

  return { nodes, edges };
}

// ─── Component ───────────────────────────────────────

export default function WorkflowPanel({ traces, isRunning }: WorkflowPanelProps) {
  const { nodes, edges } = useMemo(() => buildGraph(traces, isRunning), [traces, isRunning]);

  if (nodes.length === 0) return null;

  return (
    <div style={{
      height: '320px', borderRadius: '12px',
      background: 'rgba(15, 23, 42, 0.8)',
      border: '1px solid rgba(100, 116, 139, 0.3)',
      overflow: 'hidden', marginBottom: '16px',
    }}>
      <div style={{
        padding: '8px 14px', fontSize: '12px', fontWeight: 600, color: '#94a3b8',
        borderBottom: '1px solid rgba(100, 116, 139, 0.2)',
        display: 'flex', alignItems: 'center', gap: '6px',
      }}>
        <span>🔄</span> 工作流看板
        {isRunning && <span style={{ color: '#8b5cf6' }}>● 执行中</span>}
      </div>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        fitView proOptions={{ hideAttribution: true }}
        nodesDraggable={false} nodesConnectable={false}
        zoomOnScroll={false} panOnScroll={false} panOnDrag={false}
        style={{ background: 'transparent' }}
      >
        <Background color="rgba(100, 116, 139, 0.1)" gap={20} />
      </ReactFlow>
    </div>
  );
}
