import { describe, expect, it } from 'vitest';
import {
  buildFreshResearchQuery,
  describeSourceVerifiability,
  getResearchDateContext,
  inferSourceDateEvidence,
  isReadableMaterial,
  shouldPreferFreshResearch,
} from '../tools/web-research.js';

describe('web research freshness policy', () => {
  it.each([
    `You don't have permission to access "https://example.com/ai-agent-report" on this server.\nReference #18.\n${'Denied '.repeat(60)}`,
    `Access Denied\n${'AI Agent requests are restricted. '.repeat(30)}`,
    `请稍候…\n需要验证浏览器连接安全。${'正在检查'.repeat(60)}`,
  ])('does not count a long access refusal or localized verification page as readable evidence', text => {
    expect(isReadableMaterial({ text })).toBe(false);
  });
  it('retains legitimate articles about permission errors and browser verification', () => {
    const text = 'AI Agent browser research: understanding permission errors\n'
      + 'This report analyzes the message "Access Denied" and explains browser verification challenges. '.repeat(8);
    expect(isReadableMaterial({ text })).toBe(true);
  });
  it('detects latest and recent office research intents', () => {
    expect(shouldPreferFreshResearch('近 30 天 AI Agent 最新进展')).toBe(true);
    expect(shouldPreferFreshResearch('AI 行业趋势和现状')).toBe(true);
    expect(shouldPreferFreshResearch('last 30 days MCP news')).toBe(true);
    expect(shouldPreferFreshResearch('解释一下 Agent Card 的概念')).toBe(false);
  });

  it('adds current year and month to fresh research queries', () => {
    const query = buildFreshResearchQuery('近 30 天 AI Agent 最新进展', {
      year: 2026,
      month: 6,
    });

    expect(query).toContain('2026年');
    expect(query).toContain('6月');
    expect(query).toContain('近 30 天 AI Agent 最新进展');
  });

  it('uses Asia/Shanghai calendar date for research metadata', () => {
    const context = getResearchDateContext(new Date('2026-06-08T16:30:00.000Z'));

    expect(context).toEqual({
      isoDate: '2026-06-09',
      year: 2026,
      month: 6,
      day: 9,
    });
  });

  it('retains URL hints but does not promote search snippet dates to publication proof', () => {
    expect(inferSourceDateEvidence({
      title: 'Report',
      url: 'https://example.com/news/2026/06/18/agent-report',
      snippet: '',
      text: '',
    })).toMatchObject({ label: '2026-06-18', confidence: 'day' });

    expect(inferSourceDateEvidence({
      title: 'AI Agent 报告',
      url: 'https://example.com/report',
      snippet: '发布时间：2026年6月',
      text: '正文',
    })).toMatchObject({ confidence: 'none' });

    expect(inferSourceDateEvidence({
      title: 'No date',
      url: 'https://example.com/report',
      snippet: '',
      text: '正文没有日期',
    })).toMatchObject({ label: '未发现明确日期', confidence: 'none' });
  });

  it('does not infer publisher authority or publication from readable dated text', () => {
    expect(describeSourceVerifiability({
      title: 'Fresh report',
      url: 'https://example.com/2026-06-18/report',
      text: '2026-06-18 '.repeat(20),
      method: 'fetch',
    })).toContain('发布日期未核实');

    expect(describeSourceVerifiability({
      title: 'Blocked',
      url: 'https://example.com/report',
      text: '',
      method: 'fetch',
      error: 'HTTP 403',
    })).toContain('低');
  });
});
