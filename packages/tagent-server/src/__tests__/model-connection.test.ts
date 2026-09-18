import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { MemoryPersistence } from '@tagent/core';
import type { LLMCallParams, LLMProvider, LLMResponse } from '@tagent/ai';
import { ModelConnectionManager, createModelConnectionRoutes } from '../model-connection.js';
import { installAccessControl, resolveAccessConfig } from '../access-control.js';

const response = (): LLMResponse => ({ content: 'TAGENT_CONNECTION_OK private-output-not-persisted', toolCalls: [], model: 'deepseek-chat',
  usage: { inputTokens: 12, outputTokens: 4, cost: 0.0001 }, stopReason: 'end' });
async function setup() {
  const persistence = new MemoryPersistence();
  let time = 1000000, fingerprint = 'private-configuration-fingerprint', configured = true;
  const call = vi.fn<(params: LLMCallParams) => Promise<LLMResponse>>().mockResolvedValue(response());
  const provider: LLMProvider = { name: 'deepseek', call, stream() { throw new Error('Never stream a connection check'); } };
  const connect = () => {
    if (!configured) throw new Error('private-API-key-error');
    return { provider, model: 'deepseek-chat', endpoint: 'https://api.example.com/v1', timeoutMs: 1000, fingerprint };
  };
  const manager = await ModelConnectionManager.open(persistence, connect, () => time);
  return { manager, persistence, call, connect, now: () => time, advance: (ms = 31000) => { time += ms; },
    change: () => { fingerprint = 'changed'; }, unconfigure: () => { configured = false; } };
}
const consent = (manager: ModelConnectionManager) => { const { id, token } = manager.preview(); return { id, token, confirmed: true }; };

describe('explicit model connection check', () => {
  it('view and preview are free, redact credentials and disclose a single bounded fixed prompt', async () => {
    const { manager, persistence, call } = await setup();
    expect(manager.view()).toMatchObject({ configured: true, checks: [] });
    const preview = manager.preview();
    expect(preview).toMatchObject({ requiresConfirmation: true, willWrite: false, willExecute: false, maxOutputTokens: 64,
      maxModelCalls: 1, timeoutMs: 1000, prompt: 'Reply with exactly TAGENT_CONNECTION_OK.' });
    expect(preview.estimatedCost).toBeGreaterThan(0);
    expect(call).not.toHaveBeenCalled();
    expect(await persistence.load('model-checks', null)).toBeNull();
    expect(JSON.stringify([preview, manager.view()])).not.toMatch(/private-configuration|API.key|tokenHash/);
  });
  it('sends no history, tools or external file content; saves usage but not model output or confirmation token', async () => {
    const { manager, persistence, call } = await setup();
    const body = consent(manager);
    await manager.start(body); await manager.waitForIdle();
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toMatchObject({ messages: [{ role: 'user', content: 'Reply with exactly TAGENT_CONNECTION_OK.' }], maxTokens: 64, temperature: 0 });
    expect(call.mock.calls[0][0].tools).toBeUndefined();
    expect(manager.view().checks[0]).toMatchObject({ status: 'succeeded', persisted: true, unsettled: false, tokens: { input: 12, output: 4 } });
    const stored = JSON.stringify(await persistence.load('model-checks', null));
    expect(stored).not.toContain(body.token);
    expect(stored).not.toContain('private-output');
    expect(JSON.stringify(manager.view())).not.toContain('tokenHash');
  });
  it.each([null, {}, { confirmed: false }, { confirmed: true, id: 'x', token: 'x', prompt: 'custom' }])('rejects missing/forged consent or custom input %j', async body => {
    const { manager, call } = await setup();
    await expect(manager.start(body)).rejects.toMatchObject({ status: 400 });
    expect(call).not.toHaveBeenCalled();
  });
  it('rejects expired or configuration-mismatched consent without a model call', async () => {
    const f = await setup(); const first = consent(f.manager);
    f.advance(300001);
    await expect(f.manager.start(first)).rejects.toMatchObject({ status: 409 });
    const second = consent(f.manager); f.change();
    await expect(f.manager.start(second)).rejects.toThrow('配置已变化');
    expect(f.call).not.toHaveBeenCalled();
  });
  it('duplicate confirmed submissions return the same saved result and do not rerun after restart', async () => {
    const f = await setup(); const body = consent(f.manager);
    await f.manager.start(body); await f.manager.waitForIdle();
    await f.manager.start(body);
    await expect(f.manager.start({ ...body, token: 'wrong' })).rejects.toMatchObject({ status: 409 });
    const reloaded = await ModelConnectionManager.open(f.persistence, f.connect, f.now);
    expect((await reloaded.start(body)).checks).toEqual(f.manager.view().checks);
    expect(f.call).toHaveBeenCalledTimes(1);
  });
  it('reserves one active check while durable admission is pending', async () => {
    const f = await setup(), body = consent(f.manager), other = consent(f.manager);
    const original = f.persistence.save.bind(f.persistence);
    let release!: () => void;
    vi.spyOn(f.persistence, 'save').mockImplementationOnce(async (key, value) => { await new Promise<void>(resolve => { release = resolve; }); await original(key, value); });
    const pending = f.manager.start(body);
    await expect(f.manager.start(other)).rejects.toMatchObject({ status: 409 });
    expect(f.call).not.toHaveBeenCalled();
    release(); await pending; await f.manager.waitForIdle();
    expect(f.call).toHaveBeenCalledTimes(1);
  });
  it('failed admission storage prevents the request; final storage failure only retries local saving', async () => {
    const f = await setup(); const body = consent(f.manager);
    const save = vi.spyOn(f.persistence, 'save').mockRejectedValueOnce(new Error('disk failure'));
    await expect(f.manager.start(body)).rejects.toMatchObject({ status: 503 });
    expect(f.call).not.toHaveBeenCalled();
    const second = consent(f.manager);
    save.mockRestore();
    const actual = f.persistence.save.bind(f.persistence);
    let saves = 0;
    vi.spyOn(f.persistence, 'save').mockImplementation((key, value) => ++saves === 2 ? Promise.reject(new Error('disk failure')) : actual(key, value));
    await f.manager.start(second); await f.manager.waitForIdle();
    expect(f.manager.view().checks[0]).toMatchObject({ persisted: false, status: 'succeeded', tokens: { input: 12, output: 4 } });
    expect(() => f.manager.preview()).toThrow('尚未保存');
    await f.manager.retrySave(second.id);
    expect(f.manager.view().checks[0].persisted).toBe(true);
    expect(f.call).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ status: 401, message: 'private-API-key' }, 'authentication'],
    [{ cause: { code: 'ENOTFOUND' }, message: 'private-host' }, 'dns'],
    [{ cause: { code: 'CERT_HAS_EXPIRED' } }, 'tls'],
    [{ name: 'TimeoutError' }, 'timeout'],
    [{ status: 429 }, 'rate_limit'],
  ])('persists safe failure %j without retries or invented zero cost', async (failure, code) => {
    const f = await setup(); f.call.mockRejectedValueOnce(failure);
    await f.manager.start(consent(f.manager)); await f.manager.waitForIdle();
    const record = f.manager.view().checks[0];
    expect(record).toMatchObject({ status: 'failed', tokens: null, estimatedCost: null, unsettled: true });
    expect(record.error).toContain(`[${code}`);
    expect(JSON.stringify(record)).not.toContain('private-');
    expect(f.call).toHaveBeenCalledTimes(1);
  });
  it('cancellation aborts the provider and settles the durable record', async () => {
    const f = await setup();
    f.call.mockImplementationOnce(({ signal }) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })));
    const body = consent(f.manager);
    await f.manager.start(body); f.manager.cancel(body.id); await f.manager.waitForIdle();
    expect(f.call.mock.calls[0][0].signal!.aborted).toBe(true);
    expect(f.manager.view()).toMatchObject({ activeId: undefined, checks: [{ status: 'cancelled', persisted: true, unsettled: true }] });
  });
  it('cancels during admission storage without sending a model request afterwards', async () => {
    const f = await setup(), body = consent(f.manager);
    const save = f.persistence.save.bind(f.persistence);
    let release!: () => void;
    vi.spyOn(f.persistence, 'save').mockImplementationOnce(async (key, value) => {
      await new Promise<void>(resolve => { release = resolve; }); await save(key, value);
    });
    const started = f.manager.start(body);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(f.manager.cancel(body.id).activeId).toBe(body.id);
    release(); await started; await f.manager.waitForIdle();
    expect(f.manager.view().checks[0]).toMatchObject({ status: 'cancelled', persisted: true, unsettled: false,
      tokens: { input: 0, output: 0 }, estimatedCost: 0 });
    await f.manager.start(body);
    expect(f.call).not.toHaveBeenCalled();
  });
  it('keeps unknown model prices distinct from zero cost even with complete usage', async () => {
    const f = await setup();
    const manager = await ModelConnectionManager.open(f.persistence, () => ({ ...f.connect(), model: 'unpriced-compatible-model' }), f.now);
    expect(manager.preview().estimatedCost).toBeNull();
    await manager.start(consent(manager)); await manager.waitForIdle();
    expect(manager.view().checks[0]).toMatchObject({ status: 'succeeded', tokens: { input: 12, output: 4 }, estimatedCost: null, unsettled: false });
    expect(f.call).toHaveBeenCalledTimes(1);
  });
  it('startup marks saved running checks interrupted without invoking the provider', async () => {
    const f = await setup(); const body = consent(f.manager);
    await f.manager.start(body); await f.manager.waitForIdle();
    const saved = await f.persistence.load<{ version: number; checks: Record<string, unknown>[] }>('model-checks', { version: 1, checks: [] });
    saved.checks[0] = { ...saved.checks[0], status: 'running', completedAt: undefined, tokens: null, estimatedCost: null, unsettled: true };
    await f.persistence.save('model-checks', saved); f.call.mockClear();
    const manager = await ModelConnectionManager.open(f.persistence, f.connect, f.now);
    expect((await manager.start(body)).checks[0]).toMatchObject({ status: 'interrupted', unsettled: true, persisted: true });
    expect(f.call).not.toHaveBeenCalled();
  });
  it('limits new checks and bounds retained records without an automatic model call', async () => {
    const f = await setup();
    for (let i = 0; i < 23; i++) {
      await f.manager.start(consent(f.manager)); await f.manager.waitForIdle();
      await expect(f.manager.start(consent(f.manager))).rejects.toMatchObject({ status: 429 });
      f.advance();
    }
    expect(f.manager.view().checks).toHaveLength(20); expect(f.call).toHaveBeenCalledTimes(23);
  });
  it('rejects truncated/tool-call responses and preserves received usage', async () => {
    const f = await setup(); f.call.mockResolvedValueOnce({ ...response(), stopReason: 'max_tokens' });
    await f.manager.start(consent(f.manager)); await f.manager.waitForIdle();
    expect(f.manager.view().checks[0]).toMatchObject({ status: 'failed', unsettled: false, tokens: { input: 12, output: 4 } });
  });
  it('unconfigured states remain readable and never expose errors containing configuration values', async () => {
    const f = await setup(); f.unconfigure();
    expect(f.manager.view()).toMatchObject({ configured: false });
    expect(JSON.stringify(f.manager.view())).not.toContain('private-API-key');
    expect(() => f.manager.preview()).toThrow('模型配置不可用');
    expect(f.call).not.toHaveBeenCalled();
  });
  it('corrupt durable records fail closed without overwriting them', async () => {
    const f = await setup(); const bad = { version: 88, checks: [] };
    await f.persistence.save('model-checks', bad);
    await expect(ModelConnectionManager.open(f.persistence, f.connect)).rejects.toThrow('记录损坏');
    expect(await f.persistence.load('model-checks', null)).toEqual(bad);
    expect(f.call).not.toHaveBeenCalled();
  });
  it('HTTP routes require instance authentication and never treat a provider 401 as an app login error', async () => {
    const f = await setup(), app = new Hono(), token = 'fixture-access-secret-'.repeat(3);
    installAccessControl(app, resolveAccessConfig({ TAGENT_ACCESS_TOKEN: token }, '127.0.0.1', 3001));
    app.route('/api/model-connection', createModelConnectionRoutes(f.manager));
    const base = 'http://localhost:3001/api/model-connection';
    expect((await app.request(base)).status).toBe(401);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    expect((await app.request(base, { headers })).status).toBe(200);
    expect((await app.request(base + '/preview', { method: 'POST', headers, body: '{"prompt":"private"}' })).status).toBe(400);
    const preview = await (await app.request(base + '/preview', { method: 'POST', headers, body: '{}' })).json();
    expect(f.call).not.toHaveBeenCalled();
    f.call.mockRejectedValueOnce({ status: 401 });
    const started = await app.request(base + '/test', { method: 'POST', headers, body: JSON.stringify({ id: preview.id, token: preview.token, confirmed: true }) });
    expect(started.status).toBe(202); await f.manager.waitForIdle();
    const result = await app.request(base, { headers }); expect(result.status).toBe(200);
    expect((await result.json()).checks[0].error).toContain('authentication');
  });
});
