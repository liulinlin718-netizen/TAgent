import { describe, expect, it } from 'vitest';
import { buildFreshnessQuery, shouldForceWebResearch } from '../orchestrator.js';

describe('orchestrator freshness routing', () => {
  it('forces web research for latest, trend, and recent-30-day tasks', () => {
    expect(shouldForceWebResearch('近 30 天 AI Agent 最新进展')).toBe(true);
    expect(shouldForceWebResearch('调研 AI 办公协作趋势')).toBe(true);
    expect(shouldForceWebResearch('整理一封项目周报邮件')).toBe(false);
  });

  it('builds a freshness query with current year and month', () => {
    const query = buildFreshnessQuery('2026 年 AI Agent 新闻', new Date('2026-06-18T02:00:00.000Z'));

    expect(query).toContain('2026');
    expect(query).toContain('6月');
    expect(query).toContain('新闻');
  });
  it('preserves original freshness intent when the planner shortens the query', () => {
    const now = new Date('2026-06-09T02:00:00Z');
    expect(buildFreshnessQuery('支付 Agent 产品技术', now, '调研支付 agent 的现状')).toContain('2026年 6月');
    expect(buildFreshnessQuery('AI Agent', now, '近 30 天 AI Agent 最新进展')).toContain('2026年 6月');
    expect(buildFreshnessQuery('AI Agent 概念', now, '解释 AI Agent 概念')).not.toContain('2026年');
  });
  it('retains the exact Shanghai day even when the planner drops today from the query', () => {
    const now = new Date('2026-09-14T16:30:00Z');
    expect(buildFreshnessQuery('AI Agent', now, '给我调研AI资讯，今天的')).toContain('2026-09-15');
    expect(buildFreshnessQuery('AI Agent', now, '今天帮我调研近30天AI进展')).not.toContain('2026-09-15');
  });
});
