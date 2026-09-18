import type { LLMProvider, TokenUsage } from '@tagent/ai';
import type { OfficeDeliveryResult, OrchestratorResult, PersistenceAdapter, ResearchSource } from '@tagent/core';
import { assessResearchSources, completeOfficeReviewReceipt, getResearchDateContext, interruptedOfficeReview } from '@tagent/core';
import { Store, type ChatMessage, type TraceEvent } from './store.js';

interface RunCheckpoint {
  version: 1;
  runId: string;
  workspaceId: string;
  sessionId: string;
  savedAt: string;
  traces: TraceEvent[];
  draft: string;
  sources: ResearchSource[];
  artifacts: { agentId: string; taskId?: string; output: string }[];
  usage: { cost: number; input: number; output: number };
  finalMessage?: ChatMessage;
  officeDelivery?: OfficeDeliveryResult;
}

function checkpointKey(runId: string) {
  if (!/^run-[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Invalid run checkpoint ID');
  return `checkpoint-${runId}`;
}

async function discard(persistence: PersistenceAdapter, runId: string) {
  if (persistence.remove) await persistence.remove(checkpointKey(runId));
  else await persistence.save(checkpointKey(runId), null);
}

// Per-run writes never rewrite the full workspace. Model responses are checkpointed
// before handing control back to the loop; synchronous tool events have a small crash window.
export class RunJournal {
  private state: RunCheckpoint;
  private pending: Promise<void> = Promise.resolve();
  private failure?: unknown;

  constructor(private persistence: PersistenceAdapter, runId: string, workspaceId: string,
    sessionId: string, traces: TraceEvent[], private onFailure: () => void) {
    this.state = { version: 1, runId, workspaceId, sessionId, savedAt: new Date().toISOString(),
      traces, draft: '', sources: [], artifacts: [], usage: { cost: 0, input: 0, output: 0 } };
  }

  checkpoint(): Promise<void> {
    this.state.savedAt = new Date().toISOString();
    const snapshot = structuredClone(this.state);
    const operation = this.pending.catch(() => {}).then(() => this.persistence.save(checkpointKey(snapshot.runId), snapshot));
    this.pending = operation;
    void operation.catch(error => {
      if (!this.failure) { this.failure = error; this.onFailure(); }
    });
    return operation;
  }

  async flush() {
    await this.pending;
    if (this.failure) throw this.failure;
  }

  setSources(sources: ResearchSource[]) {
    this.state.sources = structuredClone(sources);
    void this.checkpoint();
  }

  addArtifact(agentId: string, output: string, taskId?: string) {
    const previous = this.state.artifacts.findIndex(item => item.agentId === agentId && item.taskId === taskId);
    const artifact = { agentId, taskId, output };
    if (previous >= 0) this.state.artifacts[previous] = artifact;
    else this.state.artifacts.push(artifact);
    void this.checkpoint();
  }

  setDraft(draft: string) { this.state.draft = draft; }

  async setOfficeDelivery(progress: OfficeDeliveryResult) {
    const next = structuredClone(progress);
    for (const key of ['receipt', 'revisionAttempt'] as const) {
      const received = this.state.officeDelivery?.review[key], incoming = next.review[key];
      // A failed disk write must not turn an already received/billed response into
      // an unknown network result. Never reuse a receipt from another request.
      if (received?.requestId && received.status === 'received' && incoming?.requestId === received.requestId
        && incoming.status !== 'received') next.review[key] = structuredClone(received);
    }
    this.state.officeDelivery = next;
    this.setDraft(progress.output);
    await this.checkpoint();
  }

  private addUsage(usage: TokenUsage) {
    this.state.usage.cost += usage.cost;
    this.state.usage.input += usage.inputTokens;
    this.state.usage.output += usage.outputTokens;
  }

  provider(provider: LLMProvider): LLMProvider {
    // The async generator below needs its enclosing journal, not the wrapper's this.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const journal = this;
    return {
      name: provider.name,
      async call(params) {
        await journal.flush();
        params.signal?.throwIfAborted();
        const response = await provider.call(params);
        journal.addUsage(response.usage);
        const review = journal.state.officeDelivery?.review;
        const target = review?.revisionAttempt?.status === 'pending' ? 'revisionAttempt' : review?.receipt?.status === 'pending' ? 'receipt' : undefined;
        // Save the received receipt with its usage before returning to Core, including
        // a crash between the SDK response and the structured review callback.
        if (review && target) review[target] = completeOfficeReviewReceipt(review[target]!, response);
        if (!target && !response.toolCalls.length && params.purpose !== 'verification') journal.setDraft(response.content);
        await journal.checkpoint();
        return response;
      },
      async *stream(params) {
        await journal.flush();
        params.signal?.throwIfAborted();
        let text = '';
        for await (const event of provider.stream(params)) {
          if (event.type === 'text_delta') { text += event.content || ''; if (params.purpose !== 'verification') journal.setDraft(text); }
          if (event.type === 'usage' && event.usage) journal.addUsage(event.usage);
          if (event.type === 'usage' || event.type === 'done') await journal.checkpoint();
          yield event;
        }
      },
    };
  }

  withKnownUsage(result: OrchestratorResult): OrchestratorResult {
    return { ...result, totalCost: Math.max(result.totalCost, this.state.usage.cost),
      ...(result.termination && this.state.officeDelivery ? { deliveryReview: interruptedOfficeReview(this.state.officeDelivery.review) } : {}),
      totalTokens: { input: Math.max(result.totalTokens.input, this.state.usage.input),
        output: Math.max(result.totalTokens.output, this.state.usage.output) } };
  }

  async prepareFinal(message: ChatMessage) {
    this.state.finalMessage = structuredClone(message);
    await this.checkpoint();
  }

  async discard() {
    await this.pending.catch(() => {});
    await discard(this.persistence, this.state.runId);
  }
}

function validateCheckpoint(value: unknown, receipt: NonNullable<ReturnType<Store['findRun']>>): asserts value is RunCheckpoint {
  const data = value as RunCheckpoint | null;
  if (!data || data.version !== 1 || data.runId !== receipt.message.run?.id
    || data.workspaceId !== receipt.workspaceId || data.sessionId !== receipt.sessionId
    || typeof data.savedAt !== 'string' || !Number.isFinite(Date.parse(data.savedAt)) || typeof data.draft !== 'string'
    || !Array.isArray(data.traces) || !Array.isArray(data.sources) || !Array.isArray(data.artifacts)
    || !data.usage || ![data.usage.cost, data.usage.input, data.usage.output].every(n => Number.isFinite(n) && n >= 0)
    || data.traces.some(trace => !trace || trace.runId !== data.runId || trace.sessionId !== data.sessionId
      || typeof trace.type !== 'string' || typeof trace.eventId !== 'string' || !trace.data)
    || data.artifacts.some(item => !item || typeof item.agentId !== 'string' || typeof item.output !== 'string')
    || data.sources.some(source => !source || typeof source.url !== 'string' || typeof source.title !== 'string'
      || typeof source.excerpt !== 'string' || !source.publication)) throw new Error('Invalid run checkpoint');
  if (data.officeDelivery !== undefined && !validOfficeProgress(data.officeDelivery)) throw new Error('Invalid office delivery checkpoint');
  const final = data.finalMessage;
  if (final && (final.id !== receipt.message.id || final.role !== 'assistant' || typeof final.content !== 'string'
    || final.run?.id !== data.runId || !['finished', 'interrupted'].includes(final.run.status)
    || !Number.isFinite(final.cost) || !Number.isFinite(final.tokens?.input) || !Number.isFinite(final.tokens?.output)
    || !Array.isArray(final.traces) || final.traces.filter(trace => trace.type === 'complete').length !== 1
    || final.traces.some(trace => trace.runId !== data.runId || trace.sessionId !== data.sessionId))) {
    throw new Error('Invalid final run checkpoint');
  }
}

function validOfficeProgress(value: unknown): value is OfficeDeliveryResult {
  if (!value || typeof value !== 'object') return false;
  const progress = value as OfficeDeliveryResult, review = progress.review;
  if (typeof progress.output !== 'string' || !review || review.version !== 1
    || !['passed', 'needs_revision', 'unverified'].includes(review.status) || typeof review.model !== 'string'
    || typeof review.checkedAt !== 'string' || !Number.isFinite(Date.parse(review.checkedAt))
    || !Number.isInteger(review.materialCount) || review.materialCount < 0
    || !Array.isArray(review.issues) || review.issues.some(issue => typeof issue !== 'string')
    || !Array.isArray(review.checks) || review.checks.some(check => !check || typeof check.id !== 'string'
      || typeof check.label !== 'string' || typeof check.reason !== 'string'
      || !['model', 'programmatic'].includes(check.method) || !['passed', 'failed', 'unverified'].includes(check.status)
      || (check.outputQuote !== undefined && typeof check.outputQuote !== 'string')
      || (check.evidence !== undefined && (!Array.isArray(check.evidence) || check.evidence.some(item => !item
        || typeof item.materialId !== 'string' || typeof item.label !== 'string' || typeof item.quote !== 'string'))))) return false;
  if (review.coverage && (!Number.isInteger(review.coverage.expectedBlocks) || !Number.isInteger(review.coverage.checkedBlocks)
    || review.coverage.checkedBlocks < 0 || review.coverage.expectedBlocks < review.coverage.checkedBlocks)) return false;
  for (const receipt of [review.receipt, review.revisionAttempt]) {
    if (receipt === undefined) continue;
    if (!receipt || !['pending', 'received', 'request_failed'].includes(receipt.status)
      || (receipt.requestId !== undefined && (typeof receipt.requestId !== 'string' || !receipt.requestId || receipt.requestId.length > 100))
      || ![receipt.inputCharacters, receipt.maxOutputTokens, receipt.unsettledRequests].every(n => Number.isInteger(n) && n >= 0)
      || (receipt.stopReason !== undefined && !['end', 'max_tokens', 'tool_use', 'unknown'].includes(receipt.stopReason))
      || (receipt.rawOutput !== undefined && (typeof receipt.rawOutput !== 'string' || Array.from(receipt.rawOutput).length > 24000))
      || (receipt.rawOutputTruncated !== undefined && typeof receipt.rawOutputTruncated !== 'boolean')
      || (receipt.error !== undefined && typeof receipt.error !== 'string')
      || (receipt.usage !== undefined && (!receipt.usage || ![receipt.usage.cost, receipt.usage.inputTokens, receipt.usage.outputTokens].every(n => Number.isFinite(n) && n >= 0)))) return false;
  }
  return !review.previous || (!review.previous.review?.previous && validOfficeProgress(review.previous));
}

export async function recoverInterruptedRuns(store: Store, persistence: PersistenceAdapter) {
  let recovered = 0;
  for (const receipt of store.listRuns()) {
    const run = receipt.message.run!;
    if (run.status !== 'running') {
      if (!receipt.message.traces?.some(trace => trace.data.checkpointUnavailable)) {
        await discard(persistence, run.id).catch(() => {});
      }
      continue;
    }
    let checkpoint: RunCheckpoint | undefined;
    let damaged = false;
    try {
      const saved = await persistence.load<unknown>(checkpointKey(run.id), null);
      if (saved !== null) { validateCheckpoint(saved, receipt); checkpoint = saved; }
    } catch { damaged = true; }
    const completedAt = new Date().toISOString();
    const traces = checkpoint?.traces.filter(trace => trace.type !== 'complete') || [];
    const usage = checkpoint?.usage || { cost: 0, input: 0, output: 0 };
    const originalTask = store.getMessages(receipt.workspaceId, receipt.sessionId)
      .find(message => message.id === `${run.id}-user` && message.role === 'user')?.content;
    const startedAt = new Date(run.startedAt);
    const researchDate = getResearchDateContext(Number.isFinite(startedAt.getTime()) ? startedAt : new Date(checkpoint?.savedAt || completedAt)).isoDate;
    const savedTime = checkpoint && new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium', hour12: false,
    }).format(new Date(checkpoint.savedAt));
    const artifactName = (artifact: RunCheckpoint['artifacts'][number]) => {
      const spawn = traces.find(trace => trace.type === 'agent_spawn' && trace.agentId === artifact.agentId
        && (!artifact.taskId || trace.taskId === artifact.taskId));
      return spawn?.agentSnapshot?.name || String(spawn?.data.agentName || artifact.agentId);
    };
    const recoveredMessage: ChatMessage = checkpoint?.finalMessage || {
      ...receipt.message, timestamp: completedAt,
      run: { ...run, status: 'interrupted', completedAt },
      content: ['## 任务因服务中断而结束',
        '> 服务重启前未完成本次任务，以下仅恢复已保存的检查点，不代表最终报告或已核验结论。',
        checkpoint ? `最后保存时间：${savedTime}（北京时间）` : '尚未保存可用的中间材料。',
        damaged ? '检查点无法读取，原始数据已保留，请检查存储；没有使用损坏的数据生成结论。' : '',
        ...((checkpoint?.artifacts || []).map(item => `### ${artifactName(item)}的已保存材料\n\n${item.output}`)),
        checkpoint?.draft && !checkpoint.artifacts.some(item => item.output === checkpoint.draft)
          ? `### 未完成的草稿\n\n${checkpoint.draft}` : '',
        checkpoint?.sources.length ? `### 已获取的来源（尚未完成核验）\n\n${checkpoint.sources.map(source =>
          `- <${source.url.replace(/>/g, '%3E')}>\n  来源日期线索：${source.publication.date || '未知'}；仅作待核验材料。\n  ${source.excerpt}`).join('\n\n')}` : '',
        '### 后续处理',
        '本次任务不会自动重跑模型或工具。请查看已保存内容后，重新发送需要继续的任务。',
        '已执行的外部操作不会撤销，尚未记录完成的操作状态未知，请先核实再重试。费用仅含已保存的服务商用量；中断中的请求可能仍被计费。',
      ].filter(Boolean).join('\n\n'),
      cost: usage.cost, tokens: { input: usage.input, output: usage.output }, iterations: checkpoint?.artifacts.length || 0,
      ...(checkpoint?.officeDelivery ? { deliveryReview: interruptedOfficeReview(checkpoint.officeDelivery.review) } : {}),
      ...(checkpoint?.sources.length ? { research: { sources: checkpoint.sources,
        assessment: { ...assessResearchSources(checkpoint.sources, researchDate, originalTask ?? true),
          status: 'insufficient_evidence' as const, issues: ['服务中断，材料尚未完成核验，不能视为已完成报告。'] } } } : {}),
      traces: [...traces, { type: 'complete', eventId: `${run.id}-recovered`, sessionId: receipt.sessionId, runId: run.id,
        timestamp: Date.now(), status: 'failed', summary: '服务中断，已恢复保存的材料',
        data: { success: false, termination: 'interrupted', recovery: true, checkpointUnavailable: damaged,
          totalCost: usage.cost, totalTokens: { input: usage.input, output: usage.output } } }],
    };
    // A failed workspace write must stop startup. Leave the receipt/checkpoint for the next attempt.
    await store.finishRun(receipt.workspaceId, receipt.sessionId, run.id, recoveredMessage);
    if (!damaged) await discard(persistence, run.id).catch(() => {});
    recovered++;
  }
  return recovered;
}
