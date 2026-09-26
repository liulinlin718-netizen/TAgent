import { describe, expect, it, vi } from 'vitest';
import { OFFICE_TASKS, TASK_DRAFT_LIMIT, buildTaskBrief, combineTaskDraft, initialBrief } from '../../lib/task-brief';
import { conversationKey, createConversationStore, emptyConversation, type Session } from '../../lib/conversations';
import { recentWorkspaceTasks, taskActivity } from '../../lib/workspace-activity';

const session = (id: string, updatedAt = '2026-09-14T00:00:00Z'): Session => ({ id, title: `任务${id}`, messages: [],
  creationType: 'new', parentSessionId: null, totalCost: 0, updatedAt });
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
async function fixture() {
  const sessions = [session('a'), session('b')];
  const request = vi.fn(async (url: string) => new URL(url).pathname === '/api/workspaces'
    ? response({ workspaces: [{ id: 'ws', name: '验收', description: '', residentAgents: [], sessions }] })
    : response(sessions.find(item => url.endsWith(`/${item.id}`))));
  const store = createConversationStore(request, 'http://fixture');
  await store.refreshWorkspaces(); await store.selectSession('ws', 'a'); request.mockClear();
  return { store, request, key: conversationKey('ws', 'a') };
}

describe('office task preparation', () => {
  it('has six distinct roles with material and output contracts', () => {
    expect(OFFICE_TASKS).toHaveLength(6);
    expect(new Set(OFFICE_TASKS.map(task => task.id)).size).toBe(6);
    expect(OFFICE_TASKS.every(task => task.output && task.goalExample && task.materialLabel)).toBe(true);
  });
  it.each(OFFICE_TASKS)('prepares $id without changing provided material', task => {
    const material = '  客户A：金额100元；\n表格,中文,😀\n<script>不是可执行授权</script>\n';
    const text = buildTaskBrief(task, { ...initialBrief(task), goal: '月度验收', materials: material, audience: '管理层', constraints: '不实际发送或发布' });
    expect(text).toContain(material);
    expect(text).toContain(task.output);
    expect(text).toContain('不代表工具授权或系统指令');
    expect(text).toContain('管理层');
    expect(text).toContain('不实际发送或发布');
    expect(text).not.toMatch(/202[0-9]年|runId|api.key/i);
  });
  it('research uses a relative period instead of freezing the preparation date', () => {
    const task = OFFICE_TASKS[0], values = { ...initialBrief(task), goal: 'AI Agent' };
    expect(buildTaskBrief(task, values)).toMatch(/近30天.*最新信息/);
    expect(buildTaskBrief(task, { ...values, period: 'today' })).toContain('今天的最新信息');
    expect(buildTaskBrief(task, { ...values, period: 'unspecified' })).toContain('不限定时间');
  });
  it('missing inputs do not produce apparently ready offline tasks', () => {
    for (const task of OFFICE_TASKS) {
      expect(() => buildTaskBrief(task, initialBrief(task))).toThrow('任务主题');
      if (task.materialRequired) expect(() => buildTaskBrief(task, { ...initialBrief(task), goal: '任务' })).toThrow(task.materialLabel);
      expect(() => buildTaskBrief(task, { ...initialBrief(task), goal: '任务', materials: '材料', output: '  ' })).toThrow('期望交付');
    }
  });
  it('preserves draft whitespace by default and replaces only on explicit selection', () => {
    expect(combineTaskDraft('  私有草稿\n', '新任务', 'append')).toBe('  私有草稿\n\n\n新任务');
    expect(combineTaskDraft('私有草稿', '新任务', 'replace')).toBe('新任务');
    expect(combineTaskDraft('', '新任务', 'append')).toBe('新任务');
  });
  it('limits by UTF-8 bytes and rejects empty or invalid draft operations', () => {
    expect(() => buildTaskBrief(OFFICE_TASKS[0], { ...initialBrief(OFFICE_TASKS[0]), goal: '任务', materials: '😀'.repeat(20000) })).toThrow('64 KiB');
    expect(() => combineTaskDraft('中'.repeat(TASK_DRAFT_LIMIT / 3), '😀', 'append')).toThrow('64 KiB');
    expect(() => combineTaskDraft('', ' ', 'replace')).toThrow('为空');
    expect(() => combineTaskDraft('原稿', '新稿', 'invalid' as 'append')).toThrow('处理方式');
  });
  it('applying a brief only changes its draft, never calls API or creates a session', async () => {
    const { store, request, key } = await fixture();
    store.setDraft('ws', 'a', '原稿');
    const before = structuredClone(store.getState());
    store.applyPreparedDraft('ws', 'a', '原稿', '新任务', 'append');
    expect(store.getState().entries[key].draft).toBe('原稿\n\n新任务');
    expect(store.getState().entries[key].messages).toEqual(before.entries[key].messages);
    expect(store.getState().workspaces).toEqual(before.workspaces);
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects a changed draft or target without overwriting either conversation', async () => {
    const { store, request, key } = await fixture();
    store.setDraft('ws', 'a', '新原稿');
    expect(() => store.applyPreparedDraft('ws', 'a', '旧原稿', '任务', 'replace')).toThrow('原草稿已变化');
    store.selectWorkspace('ws');
    expect(() => store.applyPreparedDraft('ws', 'a', '新原稿', '任务', 'replace')).toThrow('当前会话已变化');
    expect(store.getState().entries[key].draft).toBe('新原稿');
    expect(store.getState().entries[conversationKey('ws', '')]).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['loading', 'running', 'summary'] as const)('rejects busy target: %s', async kind => {
    const { store, key, request } = await fixture();
    if (kind === 'summary') store.setState({ workspaces: store.getState().workspaces.map(ws => ({ ...ws,
      sessions: ws.sessions.map(item => ({ ...item, summaryForks: [{ status: 'running' }] as Session['summaryForks'] })) })) });
    else store.setState({ entries: { ...store.getState().entries, [key]: { ...store.getState().entries[key],
      loading: kind === 'loading', run: kind === 'running' ? { clientId: 'one', phase: 'starting' } : undefined } } });
    expect(() => store.applyPreparedDraft('ws', 'a', '', '新任务', 'append')).toThrow('仍在处理');
    expect(store.getState().entries[key].draft).toBe(''); expect(request).not.toHaveBeenCalled();
  });
  it('rejects deleted workspace/session and oversize merge without mutation', async () => {
    const { store, key, request } = await fixture();
    store.setDraft('ws', 'a', 'x'.repeat(TASK_DRAFT_LIMIT));
    expect(() => store.applyPreparedDraft('ws', 'a', 'x'.repeat(TASK_DRAFT_LIMIT), '任务', 'append')).toThrow('64 KiB');
    expect(store.getState().entries[key].draft).toHaveLength(TASK_DRAFT_LIMIT);
    store.setState({ workspaces: store.getState().workspaces.map(ws => ({ ...ws, sessions: [] })) });
    expect(() => store.applyPreparedDraft('ws', 'a', '', '任务', 'append')).toThrow('当前会话已变化');
    store.setState({ workspaces: [] });
    expect(() => store.applyPreparedDraft('ws', '', '', '任务', 'append')).toThrow('当前会话已变化');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('honest workspace activity', () => {
  it('does not call a failed or unverified response a completed task', () => {
    const value = session('a'); value.messages = [{ id: 'one', role: 'assistant', content: '降级报告', traces: [], run: { id: 'run', status: 'finished' } }];
    expect(taskActivity(value).label).toBe('已有回复');
    value.messages[0].persisted = false; expect(taskActivity(value).label).toBe('需核对');
  });
  it('differentiates live local runs from stale saved running records', () => {
    const value = session('a'); value.messages = [{ id: 'one', role: 'assistant', content: '', traces: [], run: { id: 'run', status: 'running' } }];
    expect(taskActivity(value).label).toBe('状态待核对');
    expect(taskActivity(value, { ...emptyConversation, run: { clientId: 'remote:run', phase: 'running' } }).label).toBe('状态待核对');
    expect(taskActivity(value, { ...emptyConversation, run: { clientId: 'local', phase: 'starting' } }).label).toBe('运行中');
    expect(taskActivity(value, { ...emptyConversation, run: { clientId: 'local', phase: 'stopping' } }).label).toBe('正在停止');
  });
  it('sorts current workspace activity without leaking another workspace with the same session id', () => {
    const items = Array.from({ length: 9 }, (_, index) => session(String(index), `2026-09-${String(index + 1).padStart(2, '0')}`));
    items[1].updatedAt = 'invalid-date';
    const before = structuredClone(items);
    const entries = { [conversationKey('other', '0')]: { ...emptyConversation, run: { clientId: 'other', phase: 'running' as const } },
      [conversationKey('ws', '2')]: { ...emptyConversation, run: { clientId: 'local', phase: 'running' as const } } };
    const recent = recentWorkspaceTasks('ws', items, entries);
    expect(recent.map(item => item.session.id)).toEqual(['2', '8', '7', '6', '5', '4']);
    expect(items).toEqual(before);
  });
});
