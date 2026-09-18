import { describe, expect, it, vi } from 'vitest';
import { readWorkflowPage } from '../workflow-history';

const scope = { workspaceId: 'ws-中文', sessionId: 'session / 1', runId: 'run-one' };
const page = { ...scope, total: 1, available: 1, nextCursor: null, persisted: true, rebuilt: false, agents: ['research-agent'], types: ['agent_tool_result'],
  events: [{ eventId: 'e-1', sessionId: scope.sessionId, runId: scope.runId, type: 'agent_tool_result', summary: '中文结果 🚀' }] };
describe('workflow history client contract', () => {
  it('encodes scope and filter values without creating anything', async () => {
    const request = vi.fn(async () => Response.json(page)), signal = new AbortController().signal;
    expect(await readWorkflowPage(scope, { agentId: 'research / agent', cursor: '+/=' }, signal, request, 'http://fixture')).toEqual(page);
    const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(encodeURIComponent(scope.sessionId)); expect(url).toContain(encodeURIComponent(scope.workspaceId));
    const query = new URL(url).searchParams; expect(query.get('agentId')).toBe('research / agent'); expect(query.get('cursor')).toBe('+/=');
    expect(options.signal).toBe(signal); expect(options.method).toBeUndefined(); expect(options.body).toBeUndefined();
  });
  it.each([{ ...page, runId: 'other' }, { ...page, events: [{ ...page.events[0], sessionId: 'other' }] },
    { ...page, nextCursor: {} }, { ...page, events: null }, { ...page, total: -1 }])('rejects invalid or foreign pages', async invalid => {
    await expect(readWorkflowPage(scope, {}, new AbortController().signal, async () => Response.json(invalid))).rejects.toThrow('不一致');
  });
  it('retains a readable recovery reason on index failure', async () => {
    await expect(readWorkflowPage(scope, {}, new AbortController().signal, async () => Response.json({ error: '索引已更新，请刷新记录。' }, { status: 409 }))).rejects.toThrow('索引已更新');
  });
});
