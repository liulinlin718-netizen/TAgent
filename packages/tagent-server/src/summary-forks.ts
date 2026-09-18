import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Hono } from 'hono';
import { extractSummary, prepareSummaryFork, SummaryForkError } from '@tagent/core';
import type { SummaryForkConsent, SummaryForkRecord, SummaryForkView, SummaryMessage } from '@tagent/core';
import type { LLMProvider } from '@tagent/ai';
import { classifyProviderError } from '@tagent/ai';
import { ActiveRunError, type Session, type Store } from './store.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown, max = 300): value is string => typeof value === 'string' && value.length <= max;
const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1000 && value.every(id => str(id)) && new Set(value).size === value.length;
export function validateSummaryRecord(value: unknown): asserts value is SummaryForkRecord {
  if (!object(value) || !object(value.preview) || !object(value.usage)) throw new Error('摘要分支记录损坏，未覆盖原数据。');
  const { preview, usage } = value;
  if (!str(value.id) || !/^sumfork-[a-f0-9-]{36}$/.test(value.id) || !str(value.workspaceId) || !str(value.sourceSessionId)
    || value.targetSessionId !== value.id.replace('sumfork-', 'sess-summary-') || !num(value.startedAt)
    || !str(value.status) || !['running', 'ready', 'completed', 'failed', 'interrupted'].includes(value.status)
    || (value.status !== 'running' && (!num(value.completedAt) || value.completedAt < value.startedAt))
    || preview.version !== 1 || !str(preview.sourceHash) || !/^[a-f0-9]{64}$/.test(preview.sourceHash)
    || !['provider', 'model', 'endpoint'].every(key => str(preview[key], 2000))
    || !ids(value.preview.inputMessageIds) || !ids(value.preview.preservedMessageIds)
    || value.preview.maxModelCalls !== 1 || value.preview.maxOutputTokens !== 2048
    || !num(value.preview.inputBytes) || value.preview.inputBytes > 64000 || !num(value.preview.preservedCharacters) || value.preview.preservedCharacters > 8000
    || (value.preview.estimatedCost !== null && !num(value.preview.estimatedCost))
    || value.preview.requiresConfirmation !== true || value.preview.willWrite !== false || value.preview.willExecute !== false
    || !['input', 'output', 'knownCost'].every(key => num(usage[key]))
    || !num(usage.unsettledRequests) || usage.unsettledRequests > 1 || typeof usage.pricingKnown !== 'boolean'
    || (value.output !== undefined && !str(value.output, 32000)) || (value.rawOutput !== undefined && !str(value.rawOutput, 25000))
    || (value.error !== undefined && !str(value.error, 2000))) throw new Error('摘要分支记录损坏，未覆盖原数据。');
  if (['ready', 'completed'].includes(value.status) && (!value.output?.trim() || !Array.isArray(value.excerpts) || !value.excerpts.length || value.excerpts.length > 16)) throw new Error('摘要分支结果不完整。');
  if (value.excerpts !== undefined && (!Array.isArray(value.excerpts) || value.excerpts.length > 16 || value.excerpts.some((item: unknown) => !object(item)
    || !str(item.messageId) || !str(item.quote, 3000) || !str(item.role) || !['user', 'assistant'].includes(item.role)
    || !str(item.kind) || !['user_input', 'assistant_unverified', 'quoted_excerpt', 'fork_summary'].includes(item.kind)))) throw new Error('摘要来源记录无效。');
}

export async function recoverSummaryForks(store: Store) {
  let count = 0;
  for (const record of store.listSummaryForks()) {
    if (record.status === 'ready') { await store.completeSummaryFork(record.workspaceId, record.sourceSessionId, record.id); count++; }
    else if (record.status === 'running') {
      await store.recordSummaryResult({ ...record, status: 'interrupted', completedAt: Math.max(Date.now(), record.startedAt),
        error: '服务中断，未自动重跑模型。未收到的请求仍可能计费，请核对供应商账单。' }); count++;
    }
  }
  return count;
}
type Connection = { provider: LLMProvider; model: string; endpoint: string; connectionFingerprint: string };
type Admission = { consent: SummaryForkConsent; connectionFingerprint: string; workspaceId: string; sessionId: string };
export class SummaryForkManager {
  private consents = new Map<string, Admission>();
  private active?: { id: string; controller: AbortController; job?: Promise<void> };
  private unsaved = new Map<string, SummaryForkRecord>();
  constructor(readonly store: Store, private readonly connection: () => Connection) {}
  private source(workspaceId: string, sessionId: string): Session {
    const session = this.store.getSession(workspaceId, sessionId);
    if (!session) throw new SummaryForkError('来源会话不存在。', 404);
    return session;
  }
  list(workspaceId: string, sessionId: string) {
    return (this.source(workspaceId, sessionId).summaryForks || []).slice().reverse().map(record => this.view(workspaceId, sessionId, record.id));
  }
  view(workspaceId: string, sessionId: string, id: string): SummaryForkView {
    const saved = this.source(workspaceId, sessionId).summaryForks?.find(record => record.id === id);
    if (!saved) throw new SummaryForkError('摘要操作不存在。', 404);
    return { record: structuredClone(this.unsaved.get(id) || saved), persisted: !this.unsaved.has(id), canRetrySave: this.unsaved.has(id) };
  }
  preview(workspaceId: string, sessionId: string, preserve: unknown) {
    const source = this.source(workspaceId, sessionId);
    if (source.messages.some(message => message.run?.status === 'running') || source.summaryForks?.some(record => ['running', 'ready'].includes(record.status))) throw new SummaryForkError('来源会话仍在运行或等待保存，请先处理当前操作。', 409);
    const connection = this.connection();
    const { preview } = prepareSummaryFork(source.messages, preserve, { provider: connection.provider.name, model: connection.model, endpoint: connection.endpoint });
    const consent: SummaryForkConsent = { id: `sumfork-${randomUUID()}`, token: randomUUID(), expiresAt: Date.now() + 300000, preview };
    for (const [id, entry] of this.consents) if (entry.consent.expiresAt <= Date.now()) this.consents.delete(id);
    if (this.consents.size >= 50) this.consents.delete(this.consents.keys().next().value!);
    this.consents.set(consent.id, { consent: structuredClone(consent), connectionFingerprint: connection.connectionFingerprint, workspaceId, sessionId });
    return consent;
  }
  async start(workspaceId: string, sessionId: string, id: string, token: string) {
    const existing = this.source(workspaceId, sessionId).summaryForks?.find(record => record.id === id);
    if (existing) return this.view(workspaceId, sessionId, id);
    if (this.active || this.unsaved.size) throw new SummaryForkError('已有摘要操作正在运行或保存失败，请先处理该操作。', 409);
    const admission = this.consents.get(id);
    if (!admission || admission.workspaceId !== workspaceId || admission.sessionId !== sessionId || admission.consent.token !== token || admission.consent.expiresAt <= Date.now()) throw new SummaryForkError('摘要确认已过期或无效，请重新预览。', 409);
    this.consents.delete(id);
    const active = { id, controller: new AbortController(), job: undefined as Promise<void> | undefined };
    this.active = active;
    try {
      const source = this.source(workspaceId, sessionId), connection = this.connection();
      const prepared = prepareSummaryFork(source.messages, admission.consent.preview.preservedMessageIds, { provider: connection.provider.name, model: connection.model, endpoint: connection.endpoint });
      if (!isDeepStrictEqual(prepared.preview, admission.consent.preview) || connection.connectionFingerprint !== admission.connectionFingerprint) throw new SummaryForkError('历史或模型配置已变化，请重新预览确认。', 409);
      const record: SummaryForkRecord = { id, workspaceId, sourceSessionId: sessionId, targetSessionId: id.replace('sumfork-', 'sess-summary-'),
        preview: prepared.preview, status: 'running', startedAt: Date.now(), usage: { input: 0, output: 0, knownCost: 0, pricingKnown: prepared.preview.estimatedCost !== null, unsettledRequests: 1 } };
      await this.store.beginSummaryFork(record);
      active.job = this.execute(record, source.messages, prepared.input, connection, active.controller.signal).finally(() => { if (this.active === active) this.active = undefined; });
      return this.view(workspaceId, sessionId, id);
    } catch (error) { this.active = undefined; throw error; }
  }
  private async execute(record: SummaryForkRecord, messages: SummaryMessage[], input: Parameters<LLMProvider['call']>[0]['messages'], connection: Connection, signal: AbortSignal) {
    let result: SummaryForkRecord;
    try {
      const response = await connection.provider.call({ model: connection.model, messages: input, maxTokens: 2048, temperature: 0,
        signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]) });
      result = { ...record, completedAt: Math.max(Date.now(), record.startedAt), status: 'failed', rawOutput: Array.from(response.content).slice(0, 12000).join(''),
        usage: { input: response.usage.inputTokens, output: response.usage.outputTokens, knownCost: response.usage.cost,
          pricingKnown: record.usage.pricingKnown, unsettledRequests: 0 } };
      if (![result.usage.input, result.usage.output, result.usage.knownCost].every(num)) result = { ...result, usage: record.usage, error: '模型用量返回无效，费用待核对，未创建分支。' };
      else if (signal.aborted) result = { ...result, status: 'interrupted', error: '摘要已停止，保留已收到的内容与用量，不创建分支。' };
      else if (response.stopReason !== 'end' || response.toolCalls.length) result.error = '摘要返回不完整或试图调用工具，未创建分支。';
      else {
        try { result = { ...result, ...extractSummary(response.content, messages, record.preview.inputMessageIds), status: 'ready' }; }
        catch (error) { result.error = error instanceof SummaryForkError ? error.message : '摘要未通过原文核对，未创建分支。'; }
      }
    } catch (failure) {
      result = { ...record, completedAt: Math.max(Date.now(), record.startedAt), status: signal.aborted ? 'interrupted' : 'failed',
        error: `${signal.aborted ? '摘要已停止。' : classifyProviderError(connection.provider.name, failure).message} 未自动重试；此请求可能仍被计费，请核对供应商账单。` };
    }
    try {
      await this.store.recordSummaryResult(result);
      if (result.status === 'ready') {
        if (signal.aborted) {
          result = { ...result, status: 'interrupted', error: '摘要已停止，已生成内容保留，不创建分支。' };
          await this.store.recordSummaryResult(result);
        } else await this.store.completeSummaryFork(result.workspaceId, result.sourceSessionId, result.id);
      }
    } catch { this.unsaved.set(result.id, result); }
  }
  async retrySave(workspaceId: string, sessionId: string, id: string) {
    const view = this.view(workspaceId, sessionId, id);
    if (this.active) throw new SummaryForkError('摘要仍在处理，请稍后核对。', 409);
    if (!view.canRetrySave) return view;
    const record = view.record;
    await this.store.recordSummaryResult(record);
    if (record.status === 'ready') await this.store.completeSummaryFork(workspaceId, sessionId, id);
    this.unsaved.delete(id);
    return this.view(workspaceId, sessionId, id);
  }
  cancel(workspaceId: string, sessionId: string, id: string) {
    const view = this.view(workspaceId, sessionId, id);
    if (this.active?.id === id) this.active.controller.abort();
    return view;
  }
  async waitForIdle() { await this.active?.job; }
}

export function createSummaryForkRoutes(manager: SummaryForkManager) {
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error instanceof SummaryForkError || error instanceof ActiveRunError ? error.message : '摘要操作无法保存或处理，请检查服务状态；不会自动重跑模型。' }, error instanceof SummaryForkError ? error.status : error instanceof ActiveRunError ? 409 : 503));
  const base = '/workspaces/:wsId/sessions/:sessId';
  app.post(base + '/fork/preview', async c => {
    const body = await c.req.json().catch(() => null);
    if (!object(body)) return c.json({ error: '摘要预览参数无效。' }, 400);
    return c.json(manager.preview(c.req.param('wsId')!, c.req.param('sessId')!, body.preservedMessageIds ?? []));
  });
  app.post(base + '/fork', async c => {
    const body = await c.req.json().catch(() => null);
    if (!object(body) || !str(body.forkType) || !['fork_full', 'fork_summary'].includes(body.forkType)) return c.json({ error: 'Invalid fork type' }, 400);
    if (body.forkType === 'fork_full') {
      const session = await manager.store.forkSession(c.req.param('wsId')!, c.req.param('sessId')!, 'fork_full');
      if (!session) return c.json({ error: 'Source session not found' }, 404);
      return c.json(session, 201);
    }
    if (body.confirmed !== true || typeof body.previewId !== 'string' || typeof body.token !== 'string') return c.json({ error: '摘要会调用模型，请先预览范围和费用，再明确确认。' }, 400);
    return c.json(await manager.start(c.req.param('wsId')!, c.req.param('sessId')!, body.previewId, body.token), 202);
  });
  app.get(base + '/summary-forks', c => c.json({ operations: manager.list(c.req.param('wsId')!, c.req.param('sessId')!) }));
  app.get(base + '/summary-forks/:id', c => c.json(manager.view(c.req.param('wsId')!, c.req.param('sessId')!, c.req.param('id')!)));
  app.post(base + '/summary-forks/:id/retry-save', async c => c.json(await manager.retrySave(c.req.param('wsId')!, c.req.param('sessId')!, c.req.param('id')!)));
  app.post(base + '/summary-forks/:id/cancel', c => c.json(manager.cancel(c.req.param('wsId')!, c.req.param('sessId')!, c.req.param('id')!)));
  return app;
}
