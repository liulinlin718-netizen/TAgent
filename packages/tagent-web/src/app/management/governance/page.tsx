'use client';

/**
 * 治理仪表盘 — Phase 4 (plan §3.10 + §4.5)
 *
 * 成本趋势折线图 + 拦截事件统计 + 治理事件时间线
 */

import { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell } from 'recharts';
import { Shield, AlertTriangle, CheckCircle, Clock, TrendingUp } from 'lucide-react';
import styles from './governance.module.css';

interface GovernanceEvent {
  id: string;
  timestamp: number;
  agentId: string;
  policyType: string;
  ruleName: string;
  severity: string;
  result: string;
  message: string;
  suggestion?: string;
}

interface GovernanceStats {
  totalChecks: number;
  totalBlocked: number;
  totalWarnings: number;
  byPolicyType: Record<string, { checks: number; blocked: number }>;
  costTimeline: { timestamp: number; cost: number }[];
}

const API = 'http://localhost:3001';

const SEVERITY_COLORS: Record<string, string> = {
  hard: '#ef4444',
  soft: '#f59e0b',
  info: '#6366f1',
};

const RESULT_ICONS: Record<string, string> = {
  passed: '✅',
  blocked: '🔴',
  warning: '⚠️',
};

export default function GovernancePage() {
  const [events, setEvents] = useState<GovernanceEvent[]>([]);
  const [stats, setStats] = useState<GovernanceStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [evRes, stRes] = await Promise.all([
        fetch(`${API}/api/governance/events?limit=50`),
        fetch(`${API}/api/governance/stats`),
      ]);
      const evData = await evRes.json();
      const stData = await stRes.json();
      setEvents(evData.events || []);
      setStats(stData);
      setLoading(false);
    }
    load();
    // 每 10 秒自动刷新
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  const policyBarData = stats ? Object.entries(stats.byPolicyType).map(([type, data]) => ({
    name: type === 'resource' ? '资源' : type === 'security' ? '安全' : type === 'quality' ? '质量' : type === 'alignment' ? '方向' : type,
    checks: data.checks,
    blocked: data.blocked,
  })) : [];

  if (loading) {
    return <div className={styles.container}><div className={styles.loading}>加载治理数据...</div></div>;
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>🛡️ 治理仪表盘</h1>
          <p className={styles.subtitle}>实时监控 Agent 治理事件、成本趋势和安全拦截</p>
        </div>
      </header>

      {/* 统计卡片 */}
      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <div className={styles.statIcon}><Shield size={20} /></div>
          <div className={styles.statBody}>
            <span className={styles.statValue}>{stats?.totalChecks || 0}</span>
            <span className={styles.statLabel}>总检查次数</span>
          </div>
        </div>
        <div className={`${styles.statCard} ${styles.statDanger}`}>
          <div className={styles.statIcon}><AlertTriangle size={20} /></div>
          <div className={styles.statBody}>
            <span className={styles.statValue}>{stats?.totalBlocked || 0}</span>
            <span className={styles.statLabel}>硬约束拦截</span>
          </div>
        </div>
        <div className={`${styles.statCard} ${styles.statWarning}`}>
          <div className={styles.statIcon}><TrendingUp size={20} /></div>
          <div className={styles.statBody}>
            <span className={styles.statValue}>{stats?.totalWarnings || 0}</span>
            <span className={styles.statLabel}>软约束预警</span>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statIcon}><CheckCircle size={20} /></div>
          <div className={styles.statBody}>
            <span className={styles.statValue}>{stats ? stats.totalChecks - stats.totalBlocked - stats.totalWarnings : 0}</span>
            <span className={styles.statLabel}>安全通过</span>
          </div>
        </div>
      </div>

      {/* 图表区域 */}
      <div className={styles.chartsGrid}>
        {/* 成本趋势折线图 */}
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>📈 成本趋势</h3>
          <div className={styles.chartBody}>
            {stats?.costTimeline && stats.costTimeline.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={stats.costTimeline}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                  <XAxis dataKey="timestamp" tickFormatter={(t) => new Date(t).toLocaleTimeString()} tick={{ fill: '#888', fontSize: 11 }} />
                  <YAxis tick={{ fill: '#888', fontSize: 11 }} tickFormatter={(v) => `$${v.toFixed(3)}`} />
                  <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' }} labelFormatter={(t) => new Date(t as number).toLocaleString()} formatter={(v: any) => [`$${Number(v).toFixed(4)}`, '成本']} />
                  <Line type="monotone" dataKey="cost" stroke="#6366f1" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className={styles.emptyChart}>暂无成本数据 — 运行 Agent 任务后将自动记录</div>
            )}
          </div>
        </div>

        {/* 协议类型分布柱状图 */}
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>📊 协议触发分布</h3>
          <div className={styles.chartBody}>
            {policyBarData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={policyBarData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                  <XAxis dataKey="name" tick={{ fill: '#888', fontSize: 12 }} />
                  <YAxis tick={{ fill: '#888', fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' }} />
                  <Bar dataKey="checks" name="总检查" fill="#6366f1" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="blocked" name="拦截" fill="#ef4444" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className={styles.emptyChart}>暂无协议触发数据</div>
            )}
          </div>
        </div>
      </div>

      {/* 事件时间线 */}
      <div className={styles.timelineSection}>
        <h3 className={styles.chartTitle}>🕐 治理事件时间线 — 决策链回溯</h3>
        <div className={styles.timeline}>
          {events.length > 0 ? events.map(event => (
            <div key={event.id} className={`${styles.timelineItem} ${styles[`severity_${event.severity}`]}`}>
              <div className={styles.timelineIcon}>
                {RESULT_ICONS[event.result] || '•'}
              </div>
              <div className={styles.timelineBody}>
                <div className={styles.timelineHeader}>
                  <span className={styles.timelineAgent}>🤖 {event.agentId}</span>
                  <span className={styles.timelineTime}><Clock size={12} /> {new Date(event.timestamp).toLocaleTimeString()}</span>
                </div>
                <p className={styles.timelineMessage}>{event.message}</p>
                <div className={styles.timelineMeta}>
                  <span className={styles.policyBadge} style={{ borderColor: SEVERITY_COLORS[event.severity] || '#888' }}>
                    {event.policyType} · {event.ruleName}
                  </span>
                  <span className={styles.severityBadge} style={{ background: SEVERITY_COLORS[event.severity] || '#888' }}>
                    {event.severity}
                  </span>
                </div>
                {event.suggestion && (
                  <p className={styles.suggestion}>💡 建议: {event.suggestion}</p>
                )}
              </div>
            </div>
          )) : (
            <div className={styles.emptyTimeline}>
              <Shield size={32} />
              <p>尚无治理事件 — 运行 Agent 任务后，所有治理检查将在此记录</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
