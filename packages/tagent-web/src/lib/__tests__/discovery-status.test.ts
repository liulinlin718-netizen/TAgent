import { describe, expect, it } from 'vitest';
import type { DiscoveryProviderStatus } from '@tagent/core';
import { providerStateLabel, providerStatusDetail } from '../discovery-status';

const github: DiscoveryProviderStatus = { id: 'github-repo', name: 'GitHub repositories', kind: 'github-repo',
  domains: ['skill', 'mcp'], state: 'ok', requiresNetwork: true, supportsImportPreview: true };

describe('discovery evidence labels', () => {
  it('distinguishes a search response from a cache hit and never claims importability', () => {
    expect(providerStateLabel(github)).toBe('搜索成功');
    expect(providerStateLabel({ ...github, cache: 'memory' })).toBe('缓存结果');
    expect(providerStateLabel({ ...github, cache: 'revalidated' })).toBe('缓存已重新验证');
    expect(providerStatusDetail(github)).toContain('不代表已验证可以导入或运行');
  });

  it('distinguishes offline sources and unchecked direct input from network results', () => {
    expect(providerStateLabel({ ...github, id: 'local' })).toBe('已查本地');
    expect(providerStateLabel({ ...github, id: 'curated' })).toBe('参考来源');
    expect(providerStateLabel({ ...github, id: 'url' })).toBe('待预览');
    expect(providerStateLabel({ ...github, id: 'url', state: 'disabled' })).toBe('未输入来源');
    expect(providerStateLabel({ ...github, state: 'disabled', lastError: '已识别直接来源，未发起关键词搜索' })).toBe('未查询');
  });

  it('keeps rate limits distinct from network errors with an explicit retry date', () => {
    const limited = { ...github, state: 'failed' as const, errorCode: 'rate_limit', retryAt: Date.UTC(2026, 8, 13, 8, 0), lastError: 'GitHub 已限流' };
    expect(providerStateLabel(limited)).toContain('已限流');
    expect(providerStateLabel(limited)).toContain('后重试');
    expect(providerStatusDetail(limited)).toContain('GitHub 已限流');
    expect(providerStateLabel({ ...github, state: 'failed', errorCode: 'network' })).toBe('搜索失败');
    expect(providerStateLabel({ ...limited, retryAt: Infinity })).not.toContain('Invalid');
  });
});
