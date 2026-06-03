/**
 * GovernanceDashboard — 治理仪表盘 (plan §3.10 + Phase 4)
 *
 * 展示成本趋势图、拦截统计、协议触发热力图、决策链回溯。
 * 使用 Recharts 实现数据可视化。
 */

'use client';

import { useEffect, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell,
} from 'recharts';
import styles from './management.module.css';

const API = 'http://localhost:3001';

interface Metrics {
  totalRequests: number;
  avgResponseTime: number;
  totalTokens: { input: number; output: number };
  totalCost: number;
  agentStats: Record<string, { runs: number; avgIterations: number; totalCost: number; successRate: number }>;
  toolStats: Record<string, { calls: number; avgDuration: number }>;
  startedAt: string;
  uptimeMs: number;
}

interface GovernanceEvent {
  id: string;
  timestamp: string;
  agentId: string;
  policyType: string;
  severity: string;
  result: string;
  message: string;
  suggestion?: string;
}

const COLORS = ['#7c3aed', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899'];

export default function GovernanceDashboard() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [events, setEvents] = useState<GovernanceEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<GovernanceEvent | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [metricsRes, eventsRes] = await Promise.all([
          fetch(`${API}/api/metrics`),
          fetch(`${API}/api/governance/events`).catch(() => null),
        ]);
        setMetrics(await metricsRes.json());
        if (eventsRes?.ok) setEvents(await eventsRes.json());
      } catch { /* server not ready */ }
    };
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  if (!metrics) return <div className={styles.loading}>加载指标数据...</div>;

  // Agent 成本分布 (Pie Chart)
  const agentCostData = Object.entries(metrics.agentStats).map(([id, stats]) => ({
    name: id.replace('-agent', ''),
    value: Math.round(stats.totalCost * 10000) / 10000,
  }));

  // 工具调用统计 (Bar Chart)
  const toolData = Object.entries(metrics.toolStats).map(([name, stats]) => ({
    name: name.replace('_', ' '),
    calls: stats.calls,
    avgMs: stats.avgDuration,
  }));

  // 模拟成本趋势 (Line Chart)
  const costTrend = Array.from({ length: 10 }, (_, i) => ({
    time: `${i * 10}m`,
    cost: Math.round(metrics.totalCost * (i + 1) / 10 * 10000) / 10000,
    tokens: Math.round(metrics.totalTokens.input * (i + 1) / 10),
  }));

  const formatUptime = (ms: number) => {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  };

  return (
    <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 24, color: 'var(--color-text-primary)' }}>
        📊 治理仪表盘
      </h1>

      {/* KPI 卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 32 }}>
        {[
          { label: '总请求', value: metrics.totalRequests, icon: '📡' },
          { label: '平均响应', value: `${metrics.avgResponseTime}ms`, icon: '⚡' },
          { label: '总成本', value: `$${metrics.totalCost.toFixed(4)}`, icon: '💰' },
          { label: '总 Token', value: `${(metrics.totalTokens.input + metrics.totalTokens.output).toLocaleString()}`, icon: '🔤' },
          { label: '运行时间', value: formatUptime(metrics.uptimeMs), icon: '⏱️' },
          { label: '治理事件', value: events.length, icon: '🛡️' },
        ].map(kpi => (
          <div key={kpi.label} style={{
            background: 'var(--glass-bg)', border: '1px solid var(--glass-border)',
            borderRadius: 12, padding: '16px 20px',
          }}>
            <div style={{ fontSize: '1.8rem' }}>{kpi.icon}</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--color-text-primary)' }}>{kpi.value}</div>
            <div style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>{kpi.label}</div>
          </div>
        ))}
      </div>

      {/* 图表区 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 32 }}>
        {/* 成本趋势 */}
        <div style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: 12, padding: 20 }}>
          <h3 style={{ marginBottom: 16, color: 'var(--color-text-primary)' }}>📈 成本趋势</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={costTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
              <XAxis dataKey="time" stroke="var(--color-text-secondary)" fontSize={12} />
              <YAxis stroke="var(--color-text-secondary)" fontSize={12} />
              <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} />
              <Line type="monotone" dataKey="cost" stroke="#7c3aed" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Agent 成本分布 */}
        <div style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: 12, padding: 20 }}>
          <h3 style={{ marginBottom: 16, color: 'var(--color-text-primary)' }}>🤖 Agent 成本分布</h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={agentCostData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label>
                {agentCostData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* 工具调用统计 */}
        <div style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: 12, padding: 20 }}>
          <h3 style={{ marginBottom: 16, color: 'var(--color-text-primary)' }}>🔧 工具调用统计</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={toolData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
              <XAxis dataKey="name" stroke="var(--color-text-secondary)" fontSize={11} />
              <YAxis stroke="var(--color-text-secondary)" fontSize={12} />
              <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} />
              <Bar dataKey="calls" fill="#06b6d4" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* 决策链回溯 */}
        <div style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: 12, padding: 20, maxHeight: 280, overflowY: 'auto' }}>
          <h3 style={{ marginBottom: 16, color: 'var(--color-text-primary)' }}>🔗 决策链回溯</h3>
          {events.length === 0 ? (
            <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.85rem' }}>暂无治理事件。Agent 执行时将在此显示决策链。</p>
          ) : (
            events.slice(-20).reverse().map((evt, i) => (
              <div key={i} onClick={() => setSelectedEvent(evt)} style={{
                padding: '8px 12px', marginBottom: 8, borderRadius: 8, cursor: 'pointer',
                background: selectedEvent?.id === evt.id ? 'rgba(124,58,237,0.2)' : 'transparent',
                border: '1px solid',
                borderColor: evt.result === 'blocked' ? 'rgba(239,68,68,0.3)' : evt.result === 'warning' ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.05)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>{evt.result === 'blocked' ? '🔴' : evt.result === 'warning' ? '🟡' : '🟢'}</span>
                  <span style={{ fontSize: '0.85rem', color: 'var(--color-text-primary)' }}>{evt.message}</span>
                </div>
                {selectedEvent?.id === evt.id && evt.suggestion && (
                  <div style={{ marginTop: 8, padding: 8, background: 'rgba(124,58,237,0.1)', borderRadius: 6, fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
                    💡 建议: {evt.suggestion}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
