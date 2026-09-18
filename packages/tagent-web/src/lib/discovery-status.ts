import type { DiscoveryProviderStatus } from '@tagent/core';

const timeLabel = (value?: number) => value !== undefined && Number.isFinite(value) && Math.abs(value) <= 8640000000000000
  ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

export function providerStateLabel(provider: DiscoveryProviderStatus): string {
  if (provider.state === 'failed') {
    const retry = timeLabel(provider.retryAt);
    return provider.errorCode === 'rate_limit' ? `已限流${retry ? `，${retry} 后重试` : ''}` : '搜索失败';
  }
  if (provider.state === 'disabled') {
    if (provider.id === 'url') return '未输入来源';
    return provider.lastError?.startsWith('已识别直接来源') ? '未查询' : '未启用';
  }
  if (provider.state !== 'ok') return '尚未查询';
  if (provider.id === 'local') return '已查本地';
  if (provider.id === 'curated') return '参考来源';
  if (provider.id === 'url') return '待预览';
  if (provider.cache === 'memory') return '缓存结果';
  if (provider.cache === 'revalidated') return '缓存已重新验证';
  return '搜索成功';
}

export function providerStatusDetail(provider: DiscoveryProviderStatus): string {
  const checked = timeLabel(provider.lastCheckedAt);
  return [provider.lastError, checked ? `最近查询：${checked}` : '',
    provider.state === 'ok' ? '候选仍须预览，搜索成功不代表已验证可以导入或运行。' : provider.note,
  ].filter(Boolean).join('\n');
}
