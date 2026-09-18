import type { WorkflowTracePage, WorkflowTraceScope } from '@tagent/core';
import { API_BASE, apiFetch } from './api-client';

export async function readWorkflowPage(scope: WorkflowTraceScope, filter: { agentId?: string; type?: string; cursor?: string }, signal: AbortSignal,
  request = apiFetch, base = API_BASE): Promise<WorkflowTracePage> {
  const params = new URLSearchParams({ limit: '40' });
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
  const response = await request(`${base}/api/workspaces/${encodeURIComponent(scope.workspaceId)}/sessions/${encodeURIComponent(scope.sessionId)}/traces/${encodeURIComponent(scope.runId)}?${params}`, { signal });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : '执行记录读取失败，请重试。');
  if (!result || result.workspaceId !== scope.workspaceId || result.sessionId !== scope.sessionId || result.runId !== scope.runId
    || !Array.isArray(result.events) || result.events.length > 100 || !Array.isArray(result.agents) || !Array.isArray(result.types)
    || result.agents.some((agent: unknown) => typeof agent !== 'string') || result.types.some((type: unknown) => typeof type !== 'string')
    || !Number.isSafeInteger(result.total) || result.total < 0 || !Number.isSafeInteger(result.available) || result.available < result.total
    || !(result.nextCursor === null || typeof result.nextCursor === 'string')
    || result.events.some((event: { runId?: unknown; sessionId?: unknown; eventId?: unknown; summary?: unknown }) => !event || event.runId !== scope.runId || event.sessionId !== scope.sessionId || typeof event.eventId !== 'string' || typeof event.summary !== 'string')) {
    throw new Error('执行记录与当前任务不一致，请刷新后重试。');
  }
  return result as WorkflowTracePage;
}
