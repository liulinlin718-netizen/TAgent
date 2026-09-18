import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { limitRequestBody } from '../request-body.js';

const maximum = 2 * 1024 * 1024;
const build = () => {
  const app = new Hono();
  const handled = vi.fn();
  app.use('*', limitRequestBody);
  app.post('*', async c => {
    handled();
    const body = await c.req.arrayBuffer();
    return c.json({ length: body.byteLength, prefix: new TextDecoder().decode(body.slice(0, 100)), marker: c.req.header('x-marker') });
  });
  return { app, handled };
};
const streamingRequest = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) => new Request('http://localhost/api/agent/run', {
  method: 'POST', body, headers, duplex: 'half',
} as RequestInit & { duplex: 'half' });

afterEach(() => vi.useRealTimers());

describe('bounded request body reader', () => {
  it('preserves UTF-8, request headers and exact-limit payloads', async () => {
    const { app, handled } = build();
    const text = '中文 / English 🚀';
    const response = await app.request('/api/agent/run', { method: 'POST', body: text, headers: { 'x-marker': 'kept' } });
    expect(await response.json()).toEqual({ prefix: text, length: Buffer.byteLength(text), marker: 'kept' });
    const boundary = await app.request('/api/agent/run', { method: 'POST', body: new Uint8Array(maximum) });
    expect((await boundary.json()).length).toBe(maximum);
    expect(handled).toHaveBeenCalledTimes(2);
  });

  it('counts all chunks even when Content-Length claims a smaller size', async () => {
    const { app, handled } = build();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(maximum)); controller.enqueue(new Uint8Array(1)); controller.close();
    } });
    const response = await app.fetch(streamingRequest(body, { 'content-length': '1' }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'BODY_TOO_LARGE', accepted: false });
    expect(handled).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it('does not wait indefinitely for an oversized upload to end', async () => {
    vi.useFakeTimers();
    const { app, handled } = build();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(maximum + 1)); } });
    const pending = app.fetch(streamingRequest(body));
    await vi.advanceTimersByTimeAsync(1000);
    const response = await pending;
    expect(response.status).toBe(413);
    expect(handled).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps bytes discarded from an upload that never stops producing data', async () => {
    const { app, handled } = build();
    let pulls = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(chunk); } });
    const response = await app.fetch(streamingRequest(body));
    expect(response.status).toBe(413);
    expect(pulls).toBeLessThanOrEqual(22);
    expect(handled).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it('rejects unfinished small uploads before any handler can run', async () => {
    vi.useFakeTimers();
    const { app, handled } = build();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1)); } });
    const pending = app.fetch(streamingRequest(body));
    await vi.advanceTimersByTimeAsync(30_000);
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ code: 'BODY_READ_TIMEOUT', accepted: false });
    expect(handled).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects read failures without leaking stream errors', async () => {
    const { app, handled } = build();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('private body error')); } });
    const response = await app.fetch(streamingRequest(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'BODY_READ_FAILED', accepted: false, error: '请求内容未能完整接收，本次未提交。' });
    expect(handled).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it('does not attach the task admission contract to management requests', async () => {
    const { app, handled } = build();
    const response = await app.request('/api/skills', { method: 'POST', body: new Uint8Array(maximum + 1) });
    expect(response.status).toBe(413);
    expect(await response.json()).not.toHaveProperty('accepted');
    expect(handled).not.toHaveBeenCalled();
  });
});
