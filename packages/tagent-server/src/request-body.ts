import type { Context, MiddlewareHandler } from 'hono';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DRAIN_BYTES = 16 * 1024 * 1024;
const DRAIN_TIMEOUT_MS = 1000;
const READ_TIMEOUT_MS = 30_000;
const taskRequest = (c: Context) => ['/api/agent/run', '/api/agent/orchestrate'].includes(c.req.path);

// Keep ownership of the reader after overflow. Closing an HTTP/1 response while a
// normal client is still uploading can hide the 413 behind a connection reset.
async function discardRemainder(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), DRAIN_TIMEOUT_MS); });
  try {
    let discarded = 0;
    while (discarded <= MAX_DRAIN_BYTES) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (!chunk || chunk.done) break;
      discarded += chunk.value.byteLength;
    }
  } catch { /* Rejection is already decided; a disconnected upload cannot change it. */ }
  finally { clearTimeout(timer); }
}

export const limitRequestBody: MiddlewareHandler = async (c, next) => {
  const body = c.req.raw.body;
  if (!body) return next();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = Symbol('request body timeout');
  const deadline = new Promise<typeof timeout>(resolve => { timer = setTimeout(() => resolve(timeout), READ_TIMEOUT_MS); });
  const reject = (code: string, error: string, status: 400 | 408 | 413) => {
    c.header('Connection', 'close');
    return c.json({ error, code, ...(taskRequest(c) ? { accepted: false } : {}) }, status);
  };
  try {
    // Do not trust Content-Length alone: the stream is the authoritative size.
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk === timeout) return reject('BODY_READ_TIMEOUT', '接收请求内容超时，本次未提交，请检查连接后再发送。', 408);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        await discardRemainder(reader);
        return reject('BODY_TOO_LARGE', '请求内容超过 2 MB 限制', 413);
      }
      chunks.push(chunk.value);
    }
  } catch {
    return reject('BODY_READ_FAILED', '请求内容未能完整接收，本次未提交。', 400);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  c.req.raw = new Request(c.req.raw, { body: bytes });
  return next();
};
