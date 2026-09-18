export async function consumeRunStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (type: string, data: Record<string, unknown>) => void,
  afterBatch?: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let type = '';
  let data: string[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 2_000_000) throw new Error('事件数据超过大小限制');
      let end: number;
      // Flush completed frames in bounded groups, never waiting on the next network chunk or EOF.
      let dispatched = 0;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (!line) {
          if (data.length) {
            const parsed = JSON.parse(data.join('\n')) as Record<string, unknown>;
            onEvent(type, parsed);
            if (++dispatched === 128 || type === 'complete') { afterBatch?.(); dispatched = 0; }
            if (type === 'complete') return;
          }
          type = '';
          data = [];
        } else if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (dispatched) afterBatch?.();
      if (chunk.done) throw new Error('连接结束，但未收到任务最终结果');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
