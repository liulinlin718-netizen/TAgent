import { describe, expect, it, vi } from 'vitest';
import { consumeRunStream } from '../../lib/run-stream';

const stream = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
};
describe('run stream lifecycle', () => {
  it('flushes bounded batches and the terminal event without waiting for EOF', async () => {
    const payload = Array.from({ length: 300 }, (_, index) => `event: workflow_event\ndata: {"eventId":"${index}"}\n\n`).join('')
      + 'event: complete\ndata: {"output":"终态"}\n\n';
    const cancelled = vi.fn(), event = vi.fn(), sizes: number[] = [];
    let pending = 0;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); }, cancel: cancelled });
    await consumeRunStream(body, (type, data) => { event(type, data); pending++; }, () => { sizes.push(pending); pending = 0; });
    expect(sizes).toEqual([128, 128, 45]);
    expect(event).toHaveBeenCalledTimes(301); expect(cancelled).toHaveBeenCalledOnce();
  });
  it('flushes complete events in a chunk while preserving split Unicode for the next chunk', async () => {
    const texts = ['event: text_delta\ndata: {"text":"一"}\n\nevent: text_delta\ndata: {"text":"二',
      '三"}\n\nevent: complete\ndata: {"output":"完整"}\n\n'];
    const event = vi.fn(), flush = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const text of texts) controller.enqueue(new TextEncoder().encode(text)); } });
    await consumeRunStream(body, event, flush);
    expect(event.mock.calls).toEqual([['text_delta', { text: '一' }], ['text_delta', { text: '二三' }], ['complete', { output: '完整' }]]);
    expect(flush).toHaveBeenCalledTimes(2);
  });
  it('decodes split UTF-8 and finishes on the terminal event', async () => {
    const event = vi.fn();
    await consumeRunStream(stream('event: session\r\ndata: {"runId":"run-one"}\r\n\r\nevent: complete\r\ndata: {"output":"中文😊","termination":"cancelled"}\r\n\r\n'), event);
    expect(event.mock.calls).toEqual([['session', { runId: 'run-one' }], ['complete', { output: '中文😊', termination: 'cancelled' }]]);
  });
  it('does not leave a running indicator on EOF without a terminal result', async () => {
    await expect(consumeRunStream(stream('event: text_delta\ndata: {"text":"partial"}\n\n'), () => {})).rejects.toThrow('未收到任务最终结果');
  });
  it('closes a malformed stream instead of silently dropping events', async () => {
    await expect(consumeRunStream(stream('event: complete\ndata: {\n\n'), () => {})).rejects.toThrow();
  });
});
