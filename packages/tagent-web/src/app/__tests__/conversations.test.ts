import { describe, expect, it, vi } from 'vitest';
import { applyRunEvent, applyRunEvents, conversationKey, createConversationStore, reconcileMessages, type ChatMessage, type Session } from '../../lib/conversations';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const answer = (id: string, content = id): ChatMessage => ({ id, role: 'assistant', content, traces: [] });
const session = (id: string, messages: ChatMessage[] = []): Session => ({ id, title: id,
  creationType: 'new', parentSessionId: null, totalCost: 0, updatedAt: '2026-09-12', messages });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return { response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    emit(type: string, data: unknown) { controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)); },
    emitMany(events: { type: string; data: unknown }[]) {
      controller.enqueue(new TextEncoder().encode(events.map(({ type, data }) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join('')));
    },
    close() { controller.close(); } };
}
function fixture() {
  const channels: ReturnType<typeof stream>[] = [];
  const requests: { path: string; init?: RequestInit }[] = [];
  const sessions = new Map([['a', session('a', [answer('a-old')])], ['b', session('b', [answer('b-old')])]]);
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push({ path, init });
    if (path === '/api/workspaces') return json({ workspaces: [{ id: 'ws', name: '工作区', description: '',
      residentAgents: [], sessions: [...sessions.values()] }] });
    if (path === '/api/agent/orchestrate') { const channel = stream(); channels.push(channel); return channel.response; }
    if (path.endsWith('/cancel')) return json({ status: 'stopping' });
    if (path.endsWith('/sessions') && init?.method === 'POST') {
      const value = session('created'); sessions.set(value.id, value); return json(value);
    }
    const id = path.split('/').at(-1)!;
    return sessions.has(id) ? json(sessions.get(id)) : json({ error: 'Not found' }, 404);
  });
  const store = createConversationStore(request, 'http://fixture.test');
  const get = (id: string) => store.getState().entries[conversationKey('ws', id)]!;
  const ack = (channel: ReturnType<typeof stream>, id: string, runId = `run-${id}`) => channel.emit('session', {
    workspaceId: 'ws', sessionId: id, runId,
  });
  const done = (channel: ReturnType<typeof stream>, id: string, runId = `run-${id}`) => channel.emit('complete', {
    workspaceId: 'ws', sessionId: id, runId, output: `${id} 的最终结果`, totalCost: 0.01,
    totalTokens: { input: 10, output: 3 }, iterations: 1, persisted: false,
  });
  return { store, get, request, requests, channels, sessions, ack, done };
}

describe('session-owned conversations', () => {
  it('publishes bounded network batches without dropping events, order or the final report', async () => {
    const { store, get, channels, ack, done } = fixture();
    await store.selectSession('ws', 'a'); store.setDraft('ws', 'a', '长任务');
    const sending = store.send('ws', 'a'); await vi.waitFor(() => expect(channels).toHaveLength(1));
    ack(channels[0]!, 'a'); await vi.waitFor(() => expect(get('a').run?.runId).toBe('run-a'));
    const snapshots: ChatMessage[] = [];
    const unsubscribe = store.subscribe((state, previous) => {
      const key = conversationKey('ws', 'a');
      const message = state.entries[key]?.messages.at(-1), before = previous.entries[key]?.messages.at(-1);
      if (message && message !== before) snapshots.push(message);
    });
    const events = Array.from({ length: 2000 }, (_, index) => ({ type: 'workflow_event',
      data: { eventId: `event-${index}`, runId: 'run-a', sessionId: 'a', summary: `中文记录 ${index}` } }));
    channels[0]!.emitMany(events);
    await vi.waitFor(() => expect(get('a').messages.at(-1)?.traces).toHaveLength(2000));
    expect(snapshots).toHaveLength(16);
    expect(snapshots[0]!.traces).toHaveLength(128);
    expect(snapshots.at(-1)!.traces.map(event => event.eventId)).toEqual(events.map(event => event.data.eventId));
    channels[0]!.emitMany([{ type: 'agent_progress', data: {} }, { type: 'text_delta', data: { text: '待综合' } }, events[0]!]);
    await vi.waitFor(() => expect(get('a').messages.at(-1)?.content).toBe('待综合'));
    expect(get('a').messages.at(-1)?.traces).toHaveLength(2000);
    done(channels[0]!, 'a'); await sending;
    expect(get('a').messages.at(-1)?.content).toContain('a 的最终结果');
    expect(get('a').messages.at(-1)?.isStreaming).toBe(false);
    expect(snapshots[0]!.traces).toHaveLength(128);
    unsubscribe();
  });

  it('does not publish ignored compatibility events or duplicate canonical records', async () => {
    const { store, get, channels, ack, done } = fixture();
    await store.selectSession('ws', 'a'); store.setDraft('ws', 'a', '任务');
    const sending = store.send('ws', 'a'); await vi.waitFor(() => expect(channels).toHaveLength(1));
    ack(channels[0]!, 'a'); await vi.waitFor(() => expect(get('a').run?.runId).toBe('run-a'));
    const event = { type: 'workflow_event', data: { eventId: 'once', runId: 'run-a', sessionId: 'a' } };
    channels[0]!.emitMany([event]);
    await vi.waitFor(() => expect(get('a').messages.at(-1)?.traces).toHaveLength(1));
    const previous = get('a'), updates = vi.fn();
    const unsubscribe = store.subscribe(updates);
    channels[0]!.emitMany([{ type: 'agent_progress', data: { agentId: 'worker' } }, event]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(get('a')).toBe(previous); expect(updates).not.toHaveBeenCalled();
    unsubscribe(); done(channels[0]!, 'a'); await sending;
  });

  it('keeps valid buffered evidence when a later event belongs to another run', async () => {
    const { store, get, channels, ack } = fixture();
    await store.selectSession('ws', 'a'); store.setDraft('ws', 'a', '任务');
    const sending = store.send('ws', 'a'); await vi.waitFor(() => expect(channels).toHaveLength(1));
    ack(channels[0]!, 'a'); await vi.waitFor(() => expect(get('a').run?.runId).toBe('run-a'));
    channels[0]!.emitMany([{ type: 'text_delta', data: { text: '保留这段材料' } },
      { type: 'workflow_event', data: { eventId: 'valid', runId: 'run-a', sessionId: 'a' } },
      { type: 'workflow_event', data: { eventId: 'foreign', runId: 'run-b', sessionId: 'b' } }]);
    await sending;
    const result = get('a').messages.at(-1)!;
    expect(result.content).toContain('保留这段材料'); expect(result.content).toContain('不属于当前任务');
    expect(result.traces.map(event => event.eventId)).toEqual(['valid']);
    expect(get('a').run?.phase).toBe('finished');
  });

  it('flushes already received text if parsing fails later in the same network chunk', async () => {
    const { store, get, channels, ack } = fixture();
    await store.selectSession('ws', 'a'); store.setDraft('ws', 'a', '任务');
    const sending = store.send('ws', 'a'); await vi.waitFor(() => expect(channels).toHaveLength(1));
    ack(channels[0]!, 'a'); await vi.waitFor(() => expect(get('a').run?.runId).toBe('run-a'));
    channels[0]!.emitMany([{ type: 'text_delta', data: { text: '网络错误前的原文' } },
      { type: 'workflow_event', data: undefined }]);
    await sending;
    expect(get('a').messages.at(-1)?.content).toContain('网络错误前的原文');
    expect(get('a').messages.at(-1)?.content).toContain('未收到完整结果');
    expect(get('a').messages.at(-1)?.persisted).toBe(false);
  });

  it.each(['text_delta', 'complete'])('retains valid text before an invalid %s payload in the same batch', async type => {
    const { store, get, channels, ack } = fixture();
    await store.selectSession('ws', 'a'); store.setDraft('ws', 'a', '任务');
    const sending = store.send('ws', 'a'); await vi.waitFor(() => expect(channels).toHaveLength(1));
    ack(channels[0]!, 'a'); await vi.waitFor(() => expect(get('a').run?.runId).toBe('run-a'));
    channels[0]!.emitMany([{ type: 'text_delta', data: { text: '有效文字不可丢失' } },
      { type, data: { [type === 'complete' ? 'output' : 'text']: { toString: null } } }]);
    await sending;
    expect(get('a').messages.at(-1)?.content).toContain('有效文字不可丢失');
    expect(get('a').messages.at(-1)?.content).toContain('文字格式无效');
    expect(get('a').messages.at(-1)?.isStreaming).toBe(false);
  });

  it('cannot republish buffered private data after disposal during a large chunk', async () => {
    const { store, get, channels, ack } = fixture();
    await store.selectSession('ws', 'a'); store.setDraft('ws', 'a', '任务');
    const sending = store.send('ws', 'a'); await vi.waitFor(() => expect(channels).toHaveLength(1));
    ack(channels[0]!, 'a'); await vi.waitFor(() => expect(get('a').run?.runId).toBe('run-a'));
    const unsubscribe = store.subscribe(state => {
      if (state.entries[conversationKey('ws', 'a')]?.messages.at(-1)?.traces.length === 128) store.dispose();
    });
    channels[0]!.emitMany([...Array.from({ length: 300 }, (_, index) => ({ type: 'workflow_event', data: { eventId: `private-${index}` } })),
      { type: 'complete', data: { output: 'private final' } }]);
    await sending; unsubscribe();
    expect(store.getState().entries).toEqual({});
    expect(store.getState().activeSessId).toBe('');
  });

  it('applies a mixed batch once without mutating previous snapshots', () => {
    const initial = answer('m');
    const events = [{ type: 'workflow_event', data: { eventId: 'e1' } },
      { type: 'text_delta', data: { text: '临时' } }, { type: 'workflow_event', data: { eventId: 'e1' } },
      { type: 'complete', data: { output: '最终', persisted: false } }];
    const batch = applyRunEvents(initial, events);
    expect(batch).toEqual(events.reduce((message, event) => applyRunEvent(message, event.type, event.data), initial));
    expect(initial).toEqual(answer('m'));
    expect(batch.traces).toHaveLength(1); expect(batch.content).toContain('最终');
    expect(batch.persisted).toBe(false);
    expect(applyRunEvents(batch, [{ type: 'agent_progress', data: {} }])).toBe(batch);
  });

  it.each([400, 404, 408, 409, 413, 429])('keeps rejected HTTP %s input as a draft without inventing a failed assistant message', async status => {
    const { store, request, get } = fixture();
    await store.selectSession('ws', 'a');
    store.setDraft('ws', 'a', '  中文草稿 🚀\n保留格式  ');
    request.mockResolvedValueOnce(json({ accepted: false, error: '任务尚未接受' }, status));
    await store.send('ws', 'a');
    expect(get('a').messages).toEqual([answer('a-old')]);
    expect(get('a').draft).toBe('  中文草稿 🚀\n保留格式  ');
    expect(get('a').error).toContain('本次未发送');
    expect(get('a').run).toBeUndefined();
    await store.selectSession('ws', 'b'); await store.selectSession('ws', 'a');
    expect(get('a').messages).toEqual([answer('a-old')]);
    expect(get('a').draft).toContain('中文草稿');
  });

  it('never overwrites newer typing or changes focus when an admission rejection arrives late', async () => {
    const { store, request, get } = fixture();
    await store.selectSession('ws', 'a'); store.setDraft('ws', 'a', 'submitted');
    const response = deferred<Response>(); request.mockImplementationOnce(() => response.promise);
    const sending = store.send('ws', 'a');
    store.setDraft('ws', 'a', 'newer draft'); await store.selectSession('ws', 'b');
    response.resolve(json({ accepted: false, error: 'busy' }, 409)); await sending;
    expect(get('a').draft).toBe('newer draft');
    expect(store.getState().activeSessId).toBe('b');
    expect(get('b').messages).toEqual([answer('b-old')]);
    expect(get('a').messages).toEqual([answer('a-old')]);
  });

  it('keeps a new-session draft when rate limited before task submission, without starting a model or inventing an answer', async () => {
    const { store, request, get, requests, channels } = fixture();
    store.setDraft('ws', '', '新会话中文草稿');
    request.mockResolvedValueOnce(json({ code: 'REQUEST_RATE_LIMITED', error: '此类请求过于频繁，请 60 秒后手动重试。' }, 429));
    await store.send('ws', '');
    expect(get('').draft).toBe('新会话中文草稿');
    expect(get('').messages).toEqual([]);
    expect(get('').run).toBeUndefined();
    expect(get('').error).toContain('本次任务未发送');
    expect(get('').error).toContain('60 秒');
    expect(channels).toHaveLength(0);
    expect(requests.some(item => item.path === '/api/agent/orchestrate')).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('preserves new-session typing if session creation fails after navigation, and does not claim its save status', async () => {
    const { store, request, get, channels } = fixture();
    store.setDraft('ws', '', '旧草稿');
    const creation = deferred<Response>(); request.mockImplementationOnce(() => creation.promise);
    const sending = store.send('ws', '');
    store.setDraft('ws', '', '新编辑内容'); await store.selectSession('ws', 'b');
    creation.resolve(json({ error: '响应丢失，需要核对' }, 503)); await sending;
    expect(get('').draft).toBe('新编辑内容');
    expect(get('').messages).toEqual([]);
    expect(get('').error).toContain('刷新对话列表核对');
    expect(store.getState().activeSessId).toBe('b');
    expect(channels).toHaveLength(0);
  });

  it('does not treat an ambiguous network/server failure as a proven unsubmitted task', async () => {
    const { store, request, get } = fixture();
    await store.selectSession('ws', 'a'); store.setDraft('ws', 'a', 'uncertain request');
    request.mockResolvedValueOnce(json({ error: 'upstream failed' }, 503));
    await store.send('ws', 'a');
    expect(get('a').messages).toHaveLength(3);
    expect(get('a').messages.at(-1)?.content).toContain('未收到完整结果');
    expect(get('a').error).not.toContain('本次未发送');
  });

  it('replaces the streamed draft with the reviewed answer and retains review details on history reload', () => {
    const review: NonNullable<ChatMessage['deliveryReview']> = { version: 1, status: 'needs_revision', model: 'fixture',
      checkedAt: '2026-09-12T00:00:00Z', checks: [], issues: ['预算不足，未核对完毕'], materialCount: 1 };
    review.previous = { output: '原稿', review: { ...review } };
    const initial = { ...answer('m1', '流式中的临时文本'), isStreaming: true };
    const completed = applyRunEvent(initial, 'complete', { output: '修订稿', runId: 'run-review', persisted: true,
      deliveryReview: review, totalCost: 0.03, totalTokens: { input: 10, output: 10 } }, 'run-review');
    expect(completed.content).toBe('修订稿'); expect(completed.isStreaming).toBe(false);
    expect(completed.deliveryReview).toEqual(review);
    const reloaded = reconcileMessages([completed], JSON.parse(JSON.stringify([completed])));
    expect(reloaded[0].deliveryReview).toEqual(review);
  });
  it('does not let a late history response change the selected conversation', async () => {
    const { store, request, get } = fixture();
    const slow = deferred<Response>();
    request.mockImplementationOnce(() => slow.promise);
    const a = store.selectSession('ws', 'a');
    await store.selectSession('ws', 'b');
    slow.resolve(json(session('a', [answer('late-a')]))); await a;
    expect(store.getState().activeSessId).toBe('b');
    expect(get('b').messages[0]?.id).toBe('b-old');
    expect(get('a').messages[0]?.id).toBe('late-a');
  });

  it('keeps drafts per workspace/session and ignores older reads of the same session', async () => {
    const { store, request, get } = fixture();
    store.setDraft('ws', 'a', 'A 中文草稿'); store.setDraft('ws', 'b', 'B 草稿');
    store.setDraft('another-ws', 'a', '其他工作区');
    const slow = deferred<Response>(); request.mockImplementationOnce(() => slow.promise);
    const old = store.selectSession('ws', 'a');
    await store.selectSession('ws', 'a');
    slow.resolve(json(session('a', [answer('stale')]))); await old;
    expect(get('a').messages[0]?.id).toBe('a-old');
    expect(get('a').draft).toBe('A 中文草稿');
    expect(get('b').draft).toBe('B 草稿');
    expect(store.getState().entries[conversationKey('another-ws', 'a')]?.draft).toBe('其他工作区');
  });

  it('routes simultaneous streams and late completions to their original session, with scoped cancellation', async () => {
    const { store, get, channels, requests, ack, done } = fixture();
    await store.selectSession('ws', 'a'); store.setDraft('ws', 'a', '任务 A');
    const a = store.send('ws', 'a'); await vi.waitFor(() => expect(channels).toHaveLength(1)); ack(channels[0]!, 'a');
    await vi.waitFor(() => expect(get('a').run?.runId).toBe('run-a'));
    await store.selectSession('ws', 'b'); store.setDraft('ws', 'b', '任务 B');
    const b = store.send('ws', 'b'); await vi.waitFor(() => expect(channels).toHaveLength(2)); ack(channels[1]!, 'b');
    await vi.waitFor(() => expect(get('b').run?.runId).toBe('run-b'));
    channels[0]!.emit('text_delta', { text: 'A 的中间文本' });
    channels[1]!.emit('text_delta', { text: 'B 的中间文本' });
    await vi.waitFor(() => expect(get('b').messages.at(-1)?.content).toBe('B 的中间文本'));
    expect(get('a').messages.at(-1)?.content).toBe('A 的中间文本');
    await store.stop('ws', 'b');
    expect(requests.filter(item => item.path.endsWith('/cancel')).map(item => item.path)).toEqual(['/api/runs/run-b/cancel']);
    done(channels[0]!, 'a'); await a;
    expect(store.getState().activeSessId).toBe('b');
    expect(get('b').run?.phase).toBe('stopping');
    expect(get('b').messages.at(-1)?.content).toBe('B 的中间文本');
    done(channels[1]!, 'b'); await b;
    expect(get('a').messages.at(-1)?.content).toContain('a 的最终结果');
    expect(get('b').messages.at(-1)?.content).toContain('b 的最终结果');
  });

  it('does not replace in-flight content with a receipt from session reload', async () => {
    const { store, request, get, channels, ack, done } = fixture();
    await store.selectSession('ws', 'a'); store.setDraft('ws', 'a', '任务 A');
    const running = store.send('ws', 'a'); await vi.waitFor(() => expect(channels).toHaveLength(1)); ack(channels[0]!, 'a');
    await vi.waitFor(() => expect(get('a').run?.runId).toBe('run-a'));
    const slow = deferred<Response>(); request.mockImplementationOnce(() => slow.promise);
    const read = store.refreshSession('ws', 'a');
    channels[0]!.emit('text_delta', { text: '实际进度' });
    await vi.waitFor(() => expect(get('a').messages.at(-1)?.content).toBe('实际进度'));
    slow.resolve(json(session('a', [answer('run-a-assistant', '等待生成')]))); await read;
    expect(get('a').messages.at(-1)?.content).toBe('实际进度');
    done(channels[0]!, 'a'); await running;
  });

  it('does not steal focus when session creation or first SSE acknowledgement arrives late', async () => {
    const { store, request, get, channels, ack, done } = fixture();
    store.selectWorkspace('ws'); store.setDraft('ws', '', '新任务');
    const created = deferred<Response>(); request.mockImplementationOnce(() => created.promise);
    const run = store.send('ws', '');
    await store.selectSession('ws', 'b');
    created.resolve(json(session('created')));
    await vi.waitFor(() => expect(channels).toHaveLength(1)); ack(channels[0]!, 'created');
    await vi.waitFor(() => expect(get('created').run?.runId).toBe('run-created'));
    expect(store.getState().activeSessId).toBe('b');
    expect(get('b').messages[0]?.id).toBe('b-old');
    done(channels[0]!, 'created'); await run;
  });

  it('does not discard an unsaved answer when the user reopens the session', async () => {
    const { store, get, channels, ack, done } = fixture();
    await store.selectSession('ws', 'a'); store.setDraft('ws', 'a', '任务');
    const run = store.send('ws', 'a'); await vi.waitFor(() => expect(channels).toHaveLength(1)); ack(channels[0]!, 'a');
    done(channels[0]!, 'a'); await run;
    await store.selectSession('ws', 'b'); await store.selectSession('ws', 'a');
    expect(get('a').messages.at(-1)?.content).toContain('保存失败');
    expect(get('a').run?.persisted).toBe(false);
  });

  it('rejects delete failures instead of clearing the current conversation', async () => {
    const { store, request, get } = fixture();
    await store.selectSession('ws', 'a');
    request.mockResolvedValueOnce(json({ error: '任务仍在运行' }, 409));
    await expect(store.deleteSession('ws', 'a')).rejects.toThrow('任务仍在运行');
    expect(store.getState().activeSessId).toBe('a');
    expect(get('a').messages).toHaveLength(1);
  });

  it('restores full fork messages immediately and does not switch to a late-created branch', async () => {
    const { store, request, get } = fixture();
    store.selectWorkspace('ws');
    request.mockResolvedValueOnce(json(session('fork', [answer('copied', '完整原文')])));
    await store.createSession('ws', { id: 'a', type: 'fork_full' });
    expect(store.getState().activeSessId).toBe('fork');
    expect(get('fork').messages[0]?.content).toBe('完整原文');
    const pending = deferred<Response>(); request.mockImplementationOnce(() => pending.promise);
    const creating = store.createSession('ws');
    await store.selectSession('ws', 'b');
    pending.resolve(json(session('new'))); await creating;
    expect(store.getState().activeSessId).toBe('b');
  });

  it('clears private state and ignores requests completing after logout/disposal', async () => {
    const { store, request } = fixture();
    const slow = deferred<Response>(); request.mockImplementationOnce(() => slow.promise);
    const read = store.selectSession('ws', 'a');
    store.dispose(); slow.resolve(json(session('a', [answer('private')]))); await read;
    expect(store.getState().entries).toEqual({});
    expect(store.getState().activeSessId).toBe('');
  });

  it('rejects cross-run workflow events and deduplicates canonical event IDs', () => {
    const message = answer('answer');
    const event = { eventId: 'evt', type: 'agent_spawn', runId: 'run-a', sessionId: 'a', data: {}, timestamp: 1 };
    expect(() => applyRunEvent(message, 'workflow_event', event, 'run-b', 'b')).toThrow('不属于');
    const updated = applyRunEvent(message, 'workflow_event', event, 'run-a', 'a');
    expect(applyRunEvent(updated, 'workflow_event', event, 'run-a', 'a').traces).toHaveLength(1);
    expect(applyRunEvent(updated, 'agent_spawn', {}, 'run-a', 'a')).toBe(updated);
  });

  it('keeps a disconnected partial answer and releases only that session', async () => {
    const { store, get, channels, ack } = fixture();
    await store.selectSession('ws', 'a'); store.setDraft('ws', 'a', '断流');
    const run = store.send('ws', 'a'); await vi.waitFor(() => expect(channels).toHaveLength(1)); ack(channels[0]!, 'a');
    channels[0]!.emit('text_delta', { text: '部分材料' }); channels[0]!.close(); await run;
    expect(get('a').run?.phase).toBe('finished');
    expect(get('a').messages.at(-1)?.content).toContain('部分材料');
    expect(get('a').messages.at(-1)?.content).toContain('未收到完整结果');
  });

  it('ignores a late failed stop response after the run already finished', async () => {
    const { store, request, get, channels, ack, done } = fixture();
    await store.selectSession('ws', 'a'); store.setDraft('ws', 'a', '任务');
    const run = store.send('ws', 'a'); await vi.waitFor(() => expect(channels).toHaveLength(1)); ack(channels[0]!, 'a');
    await vi.waitFor(() => expect(get('a').run?.runId).toBe('run-a'));
    const stopped = deferred<Response>(); request.mockImplementationOnce(() => stopped.promise);
    const stop = store.stop('ws', 'a');
    done(channels[0]!, 'a'); await run;
    stopped.resolve(json({ error: 'late failure' }, 500)); await stop;
    expect(get('a').run?.phase).toBe('finished');
    expect(get('a').run?.stopError).toBe('');
  });

  it('aborts owned streams and prevents them repopulating state after logout', async () => {
    const { store, requests, channels } = fixture();
    await store.selectSession('ws', 'a'); store.setDraft('ws', 'a', '私密任务');
    const run = store.send('ws', 'a'); await vi.waitFor(() => expect(channels).toHaveLength(1));
    store.dispose();
    expect(requests.find(item => item.path === '/api/agent/orchestrate')?.init?.signal?.aborted).toBe(true);
    channels[0]!.close(); await run;
    expect(store.getState().entries).toEqual({});
  });

  it('retains an older unsaved report when a later task is saved, without reordering messages', () => {
    const previous = answer('previous'), first = { ...answer('a'), persisted: false, run: { id: 'run-a', status: 'finished' as const } };
    const second = answer('b');
    const merged = reconcileMessages([previous, second], [previous, first, second]);
    expect(merged.map(message => message.id)).toEqual(['previous', 'a', 'b']);
    expect(reconcileMessages([previous, { ...first, content: '已恢复', persisted: undefined }, second], merged)[1]?.content).toBe('已恢复');
    expect(reconcileMessages([{ ...first, content: '运行标记', run: { id: 'run-a', status: 'running' } }], [first])[0]).toBe(first);
  });

  it('does not leave a failed final save looking like a permanently running task after reopening', async () => {
    const { store, request, get } = fixture();
    request.mockResolvedValueOnce(json(session('a', [{ ...answer('run-a-assistant', '任务已接收'),
      run: { id: 'run-a', status: 'running' } }])));
    request.mockResolvedValueOnce(json({ status: 'finished', persisted: false }));
    await store.selectSession('ws', 'a');
    expect(get('a').run?.phase).toBe('finished');
    expect(get('a').run?.persisted).toBe(false);
    expect(get('a').error).toContain('保存失败');
  });

  it('rereads the final message if a remote run completes between history and status requests', async () => {
    const { store, request, get } = fixture();
    request.mockResolvedValueOnce(json(session('a', [{ ...answer('run-a-assistant', '任务已接收'),
      run: { id: 'run-a', status: 'running' } }])));
    request.mockResolvedValueOnce(json({ status: 'finished', persisted: true }));
    request.mockResolvedValueOnce(json(session('a', [{ ...answer('run-a-assistant', '已保存的最终报告'),
      run: { id: 'run-a', status: 'finished' } }])));
    await store.selectSession('ws', 'a');
    expect(get('a').messages.at(-1)?.content).toBe('已保存的最终报告');
    expect(get('a').run?.phase).not.toBe('running');
  });

  it('keeps newer titles, costs and final messages when history arrives after a fresh workspace snapshot', async () => {
    const { store, request, get, sessions } = fixture();
    await store.refreshWorkspaces();
    const slow = deferred<Response>(); request.mockImplementationOnce(() => slow.promise);
    const reading = store.selectSession('ws', 'a');
    const final = { ...session('a', [answer('final', '完整结果')]), title: '新标题', totalCost: 0.5,
      updatedAt: '2026-09-12T01:00:00Z' };
    sessions.set('a', final); await store.refreshWorkspaces();
    slow.resolve(json({ ...session('a', [answer('old', '旧内容')]), updatedAt: '2026-09-12T00:00:00Z' }));
    await reading;
    expect(get('a').messages[0]?.content).toBe('完整结果');
    expect(store.getState().workspaces[0]?.sessions.find(item => item.id === 'a')).toEqual(final);
  });

  it('does not inspect private run status from history that arrives after logout', async () => {
    const { store, request, requests } = fixture();
    const slow = deferred<Response>(); request.mockImplementationOnce(() => slow.promise);
    const reading = store.selectSession('ws', 'a');
    store.dispose();
    slow.resolve(json(session('a', [{ ...answer('receipt'), run: { id: 'private-run', status: 'running' } }])));
    await reading;
    expect(requests.some(item => item.path.startsWith('/api/runs/'))).toBe(false);
    expect(store.getState().entries).toEqual({});
  });
});
