import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';
import { classifyProviderError, ProviderRequestError } from '../provider-request.js';
import type { LLMProvider, LLMStreamEvent } from '../types.js';

const params = { model: 'fixture-model', messages: [{ role: 'user' as const, content: '中文 office fixture' }] };
const types = ['openai', 'anthropic'] as const;
const provider = (type: typeof types[number], options: { baseURL?: string; timeout?: number; fetch?: typeof fetch } = {}): LLMProvider =>
  type === 'openai' ? new OpenAIProvider({ apiKey: 'fixture-not-a-real-key', ...options })
    : new AnthropicProvider({ apiKey: 'fixture-not-a-real-key', ...options });
const openaiResponse = { id: 'fixture', model: params.model, choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
const anthropicResponse = { id: 'fixture', type: 'message', role: 'assistant', model: params.model, content: [{ type: 'text', text: '你好' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

async function localServer(handler: (request: IncomingMessage, response: ServerResponse) => void, test: (base: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  try { await test(`http://127.0.0.1:${address.port}`); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function streamFrame(type: typeof types[number], response: ServerResponse, complete = false) {
  const event = (value: object) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  if (type === 'openai') {
    event({ id: 'fixture', model: params.model, choices: [{ index: 0, delta: { role: 'assistant', content: '你好' }, finish_reason: null }] });
    if (complete) {
      event({ id: 'fixture', model: params.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
      response.end('data: [DONE]\n\n');
    }
  } else {
    const send = (value: { type: string; [key: string]: unknown }) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    send({ type: 'message_start', message: { ...anthropicResponse, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } });
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } });
    if (complete) {
      send({ type: 'content_block_stop', index: 0 });
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
      send({ type: 'message_stop' });
      response.end();
    }
  }
}

describe('safe model error classification', () => {
  it.each([
    [401, undefined, 'authentication'], [403, undefined, 'permission'], [402, undefined, 'quota'],
    [429, 'insufficient_quota', 'quota'], [429, 'rate_limit_exceeded', 'rate_limit'], [404, undefined, 'not_found'],
    [400, 'context_length_exceeded', 'context_limit'], [400, 'invalid_request_error', 'invalid_request'], [500, undefined, 'upstream'],
  ])('classifies HTTP %s / %s without leaking error bodies', (status, code, expected) => {
    const error = classifyProviderError('deepseek', { status, code, message: 'fixture-private-token; user confidential prompt', headers: { authorization: 'private-header' } });
    expect(error).toMatchObject({ code: expected, status, provider: 'deepseek' });
    expect(error.message).not.toMatch(/private|confidential/);
    expect(error).not.toHaveProperty('cause');
  });

  it.each([['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['CERT_HAS_EXPIRED', 'tls'], ['ECONNREFUSED', 'connection'], ['UND_ERR_CONNECT_TIMEOUT', 'timeout']])('unwraps nested transport code %s', (code, expected) => {
    const cause = Object.assign(new Error('secret internal URL'), { code });
    const error = new Error('Connection error', { cause: new AggregateError([cause], 'fetch failed') });
    expect(classifyProviderError('openai', error).code).toBe(expected);
  });

  it('detects tool protocol failures without echoing provider tool arguments', () => {
    const result = classifyProviderError('anthropic', { status: 400, message: 'tool_use ids need tool_result private-doc-body' });
    expect(result.code).toBe('tool_protocol');
    expect(result.message).not.toContain('private-doc-body');
  });

  it('is bounded for cyclic and aggregate errors', () => {
    const cycle = Object.assign(new Error('unknown'), { cause: null as unknown });
    cycle.cause = cycle;
    expect(classifyProviderError('invalid provider <secret>', cycle)).toMatchObject({ code: 'upstream', provider: 'model' });
  });
});

describe.each(types)('%s provider request lifecycle', type => {
  it('uses the real SDK request format and preserves valid UTF-8 results', async () => {
    let body: Record<string, unknown> | undefined;
    await localServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        body = JSON.parse(raw);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(type === 'openai' ? openaiResponse : anthropicResponse));
      });
    }, async baseURL => {
      const result = await provider(type, { baseURL }).call(params);
      expect(result).toMatchObject({ content: '你好', stopReason: 'end', usage: { inputTokens: 3, outputTokens: 2 } });
      expect(body?.messages).toEqual(params.messages);
    });
  });

  it('does not perform hidden SDK retries on connection failures', async () => {
    const fetcher = vi.fn(async () => { throw Object.assign(new Error('fetch failed secret endpoint'), { code: 'ENOTFOUND' }); });
    await expect(provider(type, { fetch: fetcher }).call(params)).rejects.toMatchObject({ code: 'dns' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sanitizes actual SDK HTTP failures for non-streaming and streaming callers', async () => {
    const fetcher = vi.fn(async () => json({ error: { type: 'authentication_error', message: 'fixture-private-token' } }, 401));
    const client = provider(type, { fetch: fetcher });
    await expect(client.call(params)).rejects.toMatchObject({ code: 'authentication', status: 401 });
    const events: LLMStreamEvent[] = [];
    const collect = async () => { for await (const event of client.stream(params)) events.push(event); };
    await expect(collect()).rejects.toMatchObject({ code: 'authentication', status: 401 });
    expect(events).toEqual([]);
  });

  it('rejects an invalid provider response instead of throwing an undefined-property error', async () => {
    const fetcher = vi.fn(async () => json({}));
    await expect(provider(type, { fetch: fetcher }).call(params)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('enforces the deadline after headers while JSON is still incomplete', async () => {
    let closed = false;
    await localServer((_request, response) => {
      response.on('close', () => { closed = true; });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"id":"fixture",');
    }, async baseURL => {
      const start = Date.now();
      await expect(provider(type, { baseURL, timeout: 200 }).call(params)).rejects.toMatchObject({ code: 'timeout' });
      expect(Date.now() - start).toBeLessThan(2000);
      await vi.waitFor(() => expect(closed).toBe(true));
    });
  });

  it('returns text and usage for a complete stream', async () => {
    await localServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      streamFrame(type, response, true);
    }, async baseURL => {
      const events: LLMStreamEvent[] = [];
      for await (const event of provider(type, { baseURL }).stream(params)) events.push(event);
      expect(events.some(event => event.type === 'text_delta' && event.content === '你好')).toBe(true);
      expect(events.some(event => event.type === 'usage' && event.usage?.outputTokens === 2)).toBe(true);
      expect(events.at(-1)?.type).toBe('done');
    });
  });

  it('times out a stalled stream, preserves received text, and never reports done', async () => {
    let closed = false;
    await localServer((_request, response) => {
      response.on('close', () => { closed = true; });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      streamFrame(type, response);
    }, async baseURL => {
      const events: LLMStreamEvent[] = [];
      const collect = async () => { for await (const event of provider(type, { baseURL, timeout: 200 }).stream(params)) events.push(event); };
      await expect(collect()).rejects.toMatchObject({ code: 'timeout' });
      expect(events.some(event => event.type === 'text_delta' && event.content === '你好')).toBe(true);
      expect(events.some(event => event.type === 'done')).toBe(false);
      await vi.waitFor(() => expect(closed).toBe(true));
    });
  });

  it('keeps caller cancellation distinct from timeout and releases the stream on early return', async () => {
    let closed = 0;
    await localServer((_request, response) => {
      response.on('close', () => { closed++; });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      streamFrame(type, response);
    }, async baseURL => {
      const client = provider(type, { baseURL, timeout: 2000 });
      const controller = new AbortController();
      const reason = new Error('caller stopped');
      const iterator = client.stream({ ...params, signal: controller.signal })[Symbol.asyncIterator]();
      let sawText = false;
      for (let index = 0; index < 8; index++) {
        const event = await iterator.next();
        if (event.value?.type === 'text_delta') { sawText = true; break; }
        if (event.done) break;
      }
      expect(sawText).toBe(true);
      controller.abort(reason);
      await expect(iterator.next()).rejects.toBe(reason);
      await vi.waitFor(() => expect(closed).toBe(1));
      for await (const event of client.stream(params)) if (event.type === 'text_delta') break;
      await vi.waitFor(() => expect(closed).toBe(2));
    });
  });

  it('never sends a pre-cancelled request', async () => {
    const fetcher = vi.fn();
    const controller = new AbortController();
    const reason = new Error('stopped before dispatch');
    controller.abort(reason);
    await expect(provider(type, { fetch: fetcher }).call({ ...params, signal: controller.signal })).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('current DeepSeek compatibility', () => {
  it.each(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'])('can dedicate the verification output cap to structured results for %s', async model => {
    const bodies: Record<string, unknown>[] = [];
    const client = new OpenAIProvider({ name: 'deepseek', apiKey: 'fixture', fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body))); return json(openaiResponse);
    } });
    await client.call({ ...params, model, purpose: 'verification', reasoning: 'disabled', maxTokens: 12288 });
    expect(bodies[0].thinking).toEqual({ type: 'disabled' });
    expect(bodies[0].reasoning_effort).toBeUndefined();
    expect(bodies[0].max_tokens).toBe(12288);
    expect(bodies[0].tools).toBeUndefined();
    expect(bodies[0].purpose).toBeUndefined();
    expect(bodies[0].reasoning).toBeUndefined();
  });
  it('never enables thinking history for a tool loop via an explicit reasoning override', async () => {
    let body: Record<string, unknown> = {};
    const client = new OpenAIProvider({ name: 'deepseek', apiKey: 'fixture', fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body)); return json(openaiResponse);
    } });
    await client.call({ ...params, model: 'deepseek-flash', reasoning: 'low',
      tools: [{ name: 'read', description: 'fixture', parameters: { type: 'object' } }] });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.reasoning_effort).toBeUndefined();
  });
  it.each([false, true])('enables low-effort verification only without tools (tools=%s)', async tools => {
    const bodies: Record<string, unknown>[] = [];
    const client = new OpenAIProvider({ name: 'deepseek', apiKey: 'fixture', fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body))); return json(openaiResponse);
    } });
    await client.call({ ...params, model: 'deepseek-flash', purpose: 'verification',
      ...(tools ? { tools: [{ name: 'read', description: 'fixture', parameters: { type: 'object' } }] } : {}) });
    expect(bodies[0].thinking).toEqual({ type: tools ? 'disabled' : 'enabled' });
    expect(bodies[0].reasoning_effort).toBe(tools ? undefined : 'low');
  });
  it.each([
    ['deepseek', 'deepseek-flash', true], ['deepseek', 'deepseek-v4-pro', true],
    ['openai', 'deepseek-flash', false], ['deepseek', 'custom-model', false], ['deepseek', 'deepseek-chat', false],
  ] as const)('sets explicit non-thinking mode only for %s / %s', async (name, model, disabled) => {
    const bodies: Record<string, unknown>[] = [];
    await localServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw); bodies.push(body);
        if (body.stream) { response.writeHead(200, { 'content-type': 'text/event-stream' }); streamFrame('openai', response, true); }
        else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(openaiResponse));
      });
    }, async baseURL => {
      const client = new OpenAIProvider({ apiKey: 'fixture', name, baseURL });
      const result = await client.call({ ...params, model });
      if (model === 'deepseek-flash') expect(result.usage.cost).toBeCloseTo(.0000033, 10);
      for await (const _event of client.stream({ ...params, model })) { /* Fully consume both request formats. */ }
    });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body.thinking).toEqual(disabled ? { type: 'disabled' } : undefined);
  });
  it.each([undefined, {}, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 3, completion_tokens: null }])(
    'does not turn missing or invalid usage into a zero-cost response: %j', async usage => {
      const client = new OpenAIProvider({ apiKey: 'fixture', fetch: async () => json({ ...openaiResponse, usage }) });
      await expect(client.call(params)).rejects.toMatchObject({ code: 'invalid_response' });
    });
});

it('does not complete an OpenAI-compatible stream that closes before a finish reason', async () => {
  await localServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    streamFrame('openai', response);
    response.end('data: [DONE]\n\n');
  }, async baseURL => {
    const collect = async () => { for await (const _event of provider('openai', { baseURL }).stream(params)) { /* Read to EOF. */ } };
    await expect(collect()).rejects.toBeInstanceOf(ProviderRequestError);
    await expect(collect()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
