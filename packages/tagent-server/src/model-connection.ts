import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { calculateCost, classifyProviderError, MODEL_PRICING } from '@tagent/ai';
import type { LLMProvider } from '@tagent/ai';
import type { ModelConnectionCheck, ModelConnectionPreview, ModelConnectionView, PersistenceAdapter, OfficeReviewProfile } from '@tagent/core';

const KEY = 'model-checks';
const PROMPT = 'Reply with exactly TAGENT_CONNECTION_OK.';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
type Connection = { provider: LLMProvider; model: string; officeReview?: OfficeReviewProfile; endpoint: string; timeoutMs: number; fingerprint: string };
type StoredCheck = Omit<ModelConnectionCheck, 'persisted'> & { tokenHash: string };
type Consent = { preview: ModelConnectionPreview; fingerprint: string };
export class ModelConnectionError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 429 | 503) { super(message); }
}

function validateState(value: unknown): asserts value is { version: 1; checks: StoredCheck[] } {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.checks) || value.checks.length > 20
    || new Set(value.checks.map(item => item?.id)).size !== value.checks.length
    || value.checks.some(item => !object(item) || typeof item.id !== 'string' || !/^model-check-[a-f0-9-]{36}$/.test(item.id)
      || typeof item.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.tokenHash)
      || !['provider', 'model', 'endpoint'].every(key => typeof item[key] === 'string' && item[key].length <= 2000)
      || !['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(item.status))
      || !number(item.startedAt) || (item.status !== 'running' && (!number(item.completedAt) || item.completedAt < item.startedAt))
      || (item.tokens !== null && (!object(item.tokens) || !number(item.tokens.input) || !number(item.tokens.output)))
      || (item.estimatedCost !== null && !number(item.estimatedCost)) || typeof item.unsettled !== 'boolean'
      || (item.error !== undefined && (typeof item.error !== 'string' || item.error.length > 2000)))) {
    throw new Error('模型连接测试记录损坏，未覆盖原数据。');
  }
}

/** One confirmed fixed-prompt request, with durable admission and no automatic retries. */
export class ModelConnectionManager {
  private checks: StoredCheck[] = [];
  private consents = new Map<string, Consent>();
  private active?: { id: string; controller: AbortController; job?: Promise<void> };
  private unsaved?: StoredCheck;
  private pending: Promise<unknown> = Promise.resolve();
  private constructor(private readonly persistence: PersistenceAdapter, private readonly connect: () => Connection, private readonly now: () => number) {}

  static async open(persistence: PersistenceAdapter, connect: () => Connection, now = Date.now) {
    const manager = new ModelConnectionManager(persistence, connect, now);
    const state = await persistence.load<unknown>(KEY, { version: 1, checks: [] });
    validateState(state);
    manager.checks = structuredClone(state.checks);
    for (const check of manager.checks.filter(item => item.status === 'running')) {
      await manager.save({ ...check, status: 'interrupted', completedAt: Math.max(now(), check.startedAt),
        error: '服务中断，未自动重跑连接测试；未收到的请求仍可能计费，请核对服务商账单。' });
    }
    return manager;
  }

  private save(check: StoredCheck) {
    const operation = this.pending.then(async () => {
      const next = [...this.checks.filter(item => item.id !== check.id), structuredClone(check)].slice(-20);
      const state = { version: 1 as const, checks: next };
      validateState(state);
      await this.persistence.save(KEY, state);
      this.checks = next;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private retryAfter() {
    const last = this.checks.at(-1);
    return last ? Math.max(0, 30000 - (this.now() - last.startedAt)) : 0;
  }

  view(): ModelConnectionView {
    const checks = this.checks.map(item => item.id === this.unsaved?.id ? this.unsaved : item).map(item => {
      const { tokenHash: _secret, ...check } = item;
      return { ...check, persisted: this.unsaved?.id !== check.id };
    }).reverse();
    const common = { checks: structuredClone(checks), activeId: this.active?.id, retryAfterMs: this.retryAfter() };
    try {
      const connection = this.connect();
      return { ...common, configured: true, provider: connection.provider.name, model: connection.model, endpoint: connection.endpoint,
        officeReview: connection.officeReview ? { ...connection.officeReview } : { model: connection.model, reasoning: 'disabled' } };
    } catch {
      return { ...common, configured: false, configurationError: '模型配置不可用，请由部署管理员检查 Provider、API Key、模型名称和服务地址。' };
    }
  }

  preview(): ModelConnectionPreview {
    if (this.active) throw new ModelConnectionError('已有连接测试正在运行，请先等待或停止。', 409);
    if (this.unsaved) throw new ModelConnectionError('测试结果尚未保存，请先重试保存；不会重新调用模型。', 503);
    let connection: Connection;
    try { connection = this.connect(); } catch { throw new ModelConnectionError('模型配置不可用，请先检查部署配置。', 503); }
    const preview: ModelConnectionPreview = { id: `model-check-${randomUUID()}`, token: randomUUID(), expiresAt: this.now() + 300000,
      provider: connection.provider.name, model: connection.model, endpoint: connection.endpoint, prompt: PROMPT,
      maxModelCalls: 1, maxOutputTokens: 64, timeoutMs: Math.min(connection.timeoutMs, 15000),
      estimatedCost: MODEL_PRICING[connection.model] ? calculateCost(connection.model, { inputTokens: 128, outputTokens: 64 }) : null,
      requiresConfirmation: true, willWrite: false, willExecute: false };
    for (const [id, consent] of this.consents) if (consent.preview.expiresAt <= this.now()) this.consents.delete(id);
    if (this.consents.size >= 50) this.consents.delete(this.consents.keys().next().value!);
    this.consents.set(preview.id, { preview: structuredClone(preview), fingerprint: connection.fingerprint });
    return preview;
  }

  async start(body: unknown) {
    if (!object(body) || body.confirmed !== true || typeof body.id !== 'string' || typeof body.token !== 'string'
      || body.token.length > 100 || Object.keys(body).some(key => !['id', 'token', 'confirmed'].includes(key))) {
      throw new ModelConnectionError('连接测试需要有效的预览与明确费用确认；不能传入自定义提示词或工具。', 400);
    }
    const existing = this.checks.find(item => item.id === body.id);
    if (existing) {
      if (existing.tokenHash !== hash(body.token)) throw new ModelConnectionError('确认凭证无效。', 409);
      return this.view();
    }
    if (this.active) throw new ModelConnectionError('已有连接测试正在运行，请先等待或停止。', 409);
    if (this.unsaved) throw new ModelConnectionError('上次结果尚未保存，暂不开始新的付费请求。', 503);
    if (this.retryAfter()) throw new ModelConnectionError('连接测试间隔至少30秒，请稍后手动重试。', 429);
    const consent = this.consents.get(body.id);
    if (!consent || consent.preview.token !== body.token || consent.preview.expiresAt <= this.now()) throw new ModelConnectionError('测试确认已过期或失效，请重新预览。', 409);
    let connection: Connection;
    try { connection = this.connect(); } catch { throw new ModelConnectionError('模型配置不可用，请重新检查配置。', 503); }
    if (connection.fingerprint !== consent.fingerprint) throw new ModelConnectionError('模型配置已变化，请重新预览确认。', 409);
    this.consents.delete(body.id);
    const active = { id: body.id, controller: new AbortController(), job: undefined as Promise<void> | undefined };
    this.active = active;
    const check: StoredCheck = { id: body.id, tokenHash: hash(body.token), provider: consent.preview.provider,
      model: consent.preview.model, endpoint: consent.preview.endpoint, status: 'running', startedAt: this.now(),
      tokens: null, estimatedCost: null, unsettled: true };
    try { await this.save(check); }
    catch { this.active = undefined; throw new ModelConnectionError('无法保存测试开始记录，未调用模型，请检查存储。', 503); }
    active.job = this.execute(check, connection, consent.preview.timeoutMs, active.controller.signal)
      .finally(() => { if (this.active === active) this.active = undefined; });
    return this.view();
  }

  private async execute(initial: StoredCheck, connection: Connection, timeoutMs: number, signal: AbortSignal) {
    const result = { ...initial };
    if (signal.aborted) {
      result.status = 'cancelled';
      result.tokens = { input: 0, output: 0 };
      result.estimatedCost = 0;
      result.unsettled = false;
      result.error = '测试在发送前已停止，未调用模型。';
    } else try {
      const response = await connection.provider.call({ model: connection.model, messages: [{ role: 'user', content: PROMPT }],
        maxTokens: 64, temperature: 0, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
      if (number(response.usage.inputTokens) && number(response.usage.outputTokens)) {
        result.tokens = { input: response.usage.inputTokens, output: response.usage.outputTokens };
        result.estimatedCost = MODEL_PRICING[connection.model] ? calculateCost(connection.model, response.usage) : null;
        result.unsettled = false;
      }
      result.status = signal.aborted ? 'cancelled' : response.content.trim() && response.stopReason === 'end' && response.toolCalls.length === 0 ? 'succeeded' : 'failed';
      if (result.status === 'cancelled') result.error = '测试已停止，保留已收到的用量；不会自动重试。';
      if (result.status === 'failed') result.error = '模型有响应，但未完成无工具的短回复。请核对模型与接口参数兼容性；不代表连接完全不可达。';
    } catch (error) {
      result.status = signal.aborted ? 'cancelled' : 'failed';
      result.error = signal.aborted ? '连接测试已停止，未收到完整用量的请求仍可能计费。' : classifyProviderError(connection.provider.name, error).message;
    }
    result.completedAt = Math.max(this.now(), result.startedAt);
    try { await this.save(result); } catch { this.unsaved = result; }
  }

  cancel(id: string) {
    if (this.active?.id !== id && !this.checks.some(item => item.id === id)) throw new ModelConnectionError('测试记录不存在。', 404);
    if (this.active?.id === id) this.active.controller.abort();
    return this.view();
  }
  async retrySave(id: string) {
    if (this.active) throw new ModelConnectionError('测试尚未完成，请稍后核对。', 409);
    if (!this.checks.some(item => item.id === id)) throw new ModelConnectionError('测试记录不存在。', 404);
    if (this.unsaved?.id === id) {
      try { await this.save(this.unsaved); } catch { throw new ModelConnectionError('仍无法保存测试结果，请检查存储。', 503); }
      this.unsaved = undefined;
    }
    return this.view();
  }
  async waitForIdle() { await this.active?.job; }
}

export function createModelConnectionRoutes(manager: ModelConnectionManager) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ModelConnectionError && error.status === 429) c.header('Retry-After', String(Math.max(1, Math.ceil(manager.view().retryAfterMs / 1000))));
    return c.json({ error: error instanceof ModelConnectionError ? error.message : '连接测试暂不可用，请检查服务状态。' }, error instanceof ModelConnectionError ? error.status : 503);
  });
  app.get('/', c => c.json(manager.view()));
  app.post('/preview', async c => {
    const body = await c.req.json().catch(() => null);
    if (!object(body) || Object.keys(body).length) throw new ModelConnectionError('预览不接受提示词、密钥或自定义地址。', 400);
    return c.json(manager.preview());
  });
  app.post('/test', async c => c.json(await manager.start(await c.req.json().catch(() => null)), 202));
  app.post('/:id/cancel', c => c.json(manager.cancel(c.req.param('id'))));
  app.post('/:id/retry-save', async c => c.json(await manager.retrySave(c.req.param('id'))));
  return app;
}
