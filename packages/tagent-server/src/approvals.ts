import type { ApprovalRequest, ToolApprovalStatus, ToolApprovalView } from '@tagent/core';
import { previewToolArguments } from './tool-arguments.js';

export class ApprovalError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503) { super(message); }
}
type Scope = Pick<ToolApprovalView, 'workspaceId' | 'sessionId' | 'runId' | 'agentId' | 'taskId'>;
type Entry = { view: ToolApprovalView; request: ApprovalRequest; publish: (view: ToolApprovalView) => Promise<void>;
  signal: AbortSignal; abort: () => void; timer: ReturnType<typeof setTimeout>; ready: boolean; settling?: Promise<ToolApprovalView> };
const reasons: Record<ToolApprovalStatus, string> = {
  pending: '当前 Agent 配置要求用户确认此工具及参数；未确认前不执行。',
  approved: '用户已批准本次参数。仅代表获得执行许可，不代表工具已执行成功。',
  denied: '用户拒绝本次工具调用；未执行，Agent 可改用其他方案或说明缺口。',
  expired: '等待确认已超时，默认拒绝；没有自动批准。',
  cancelled: '任务已停止或连接断开，本次执行许可失效。',
  failed: '审批记录保存失败，未授予执行许可。',
};
export class ApprovalRegistry {
  private pending = new Map<string, Entry>();
  private async publish(entry: Entry, view: ToolApprovalView) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entry.publish(structuredClone(view)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Approval checkpoint timeout')), 10000);
    })]); } finally { clearTimeout(timer); }
  }
  async register(scope: Scope, request: ApprovalRequest, signal: AbortSignal, publish: Entry['publish']) {
    if (signal.aborted || this.pending.size >= 64 || this.pending.has(request.requestId)) { request.resolve(false); return; }
    const args = previewToolArguments(request.toolArgs);
    const view: ToolApprovalView = { ...scope, requestId: request.requestId, toolName: request.toolName, mode: request.mode,
      createdAt: request.createdAt, expiresAt: request.expiresAt, status: 'pending', reason: reasons.pending,
      argsPreview: args.preview, redacted: args.redacted, truncated: args.truncated };
    const stop = () => { const entry = this.pending.get(request.requestId); if (entry) void this.settle(entry, 'cancelled').catch(() => {}); };
    const entry: Entry = { view, request, signal, publish, ready: false, abort: stop,
      timer: setTimeout(() => { void this.settle(entry, 'expired').catch(() => {}); }, Math.max(0, view.expiresAt - Date.now())) };
    this.pending.set(view.requestId, entry); signal.addEventListener('abort', stop, { once: true });
    try {
      await this.publish(entry, view); entry.ready = true;
      if (signal.aborted) stop();
    } catch {
      entry.request.resolve(false); this.remove(entry);
      throw new ApprovalError(reasons.failed, 503);
    }
  }
  private remove(entry: Entry) {
    clearTimeout(entry.timer); entry.signal.removeEventListener('abort', entry.abort); this.pending.delete(entry.view.requestId);
  }
  list(runId: string, sessionId: string) {
    return [...this.pending.values()].filter(entry => entry.ready && entry.view.runId === runId && entry.view.sessionId === sessionId)
      .map(entry => structuredClone(entry.view));
  }
  async decide(requestId: string, body: { approved: boolean; runId?: string; sessionId?: string }) {
    const entry = this.pending.get(requestId);
    if (!entry) throw new ApprovalError('该审批已结束或不存在，请刷新当前任务状态。', 404);
    if (!body.runId || !body.sessionId) throw new ApprovalError('审批必须指定所属 runId 和 sessionId。', 400);
    if (entry.view.runId !== body.runId || entry.view.sessionId !== body.sessionId) throw new ApprovalError('审批不属于当前任务。', 409);
    if (!entry.ready || entry.settling) throw new ApprovalError('审批正在保存或已被处理，请稍后核对记录。', 409);
    if (body.approved && entry.view.truncated) throw new ApprovalError('参数预览不完整，不能批准；请拒绝后缩小请求。', 400);
    return this.settle(entry, entry.signal.aborted ? 'cancelled' : Date.now() >= entry.view.expiresAt ? 'expired' : body.approved ? 'approved' : 'denied');
  }
  private settle(entry: Entry, status: ToolApprovalStatus): Promise<ToolApprovalView> {
    if (entry.settling) return entry.settling;
    clearTimeout(entry.timer);
    entry.view = { ...entry.view, status, reason: reasons[status] };
    entry.settling = (async () => {
      try {
        await this.publish(entry, entry.view);
        // Cancellation or expiry during the durable write revokes this approval.
        if (status === 'approved' && (entry.signal.aborted || Date.now() >= entry.view.expiresAt)) {
          const revoked = entry.signal.aborted ? 'cancelled' : 'expired';
          entry.view = { ...entry.view, status: revoked, reason: reasons[revoked] };
          await this.publish(entry, entry.view);
        }
        entry.request.resolve(entry.view.status === 'approved' && !entry.signal.aborted && Date.now() < entry.view.expiresAt);
        return structuredClone(entry.view);
      } catch { entry.request.resolve(false); throw new ApprovalError(reasons.failed, 503); }
      finally { this.remove(entry); }
    })();
    return entry.settling;
  }
  async finishRun(runId: string) {
    await Promise.allSettled([...this.pending.values()].filter(entry => entry.view.runId === runId).map(entry => this.settle(entry, 'cancelled')));
  }
}
