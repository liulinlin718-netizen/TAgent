import { randomUUID } from 'node:crypto';

export type ToolApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'failed';
export interface ToolApprovalView {
  requestId: string; workspaceId: string; sessionId: string; runId: string; agentId: string; taskId?: string;
  toolName: string; mode: 'suggest' | 'auto_edit'; createdAt: number; expiresAt: number;
  status: ToolApprovalStatus; reason: string; argsPreview: string; redacted: boolean; truncated: boolean;
}
export interface ApprovalRequest {
  requestId: string; toolName: string; toolArgs: Record<string, unknown>;
  mode: 'suggest' | 'auto_edit'; createdAt: number; expiresAt: number;
  resolve: (approved: boolean) => void;
}
export type ApprovalHandler = (request: ApprovalRequest) => void | Promise<void>;

/** A missing UI, expired request or callback failure never grants permission. */
export function requestToolApproval(toolName: string, toolArgs: Record<string, unknown>, mode: 'suggest' | 'auto_edit' | 'full_auto',
  handler?: ApprovalHandler, signal?: AbortSignal, localReadOnly = false): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (mode === 'full_auto' || (mode === 'auto_edit' && localReadOnly)) return Promise.resolve(true);
  if (!handler) return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    const createdAt = Date.now(), expiresAt = createdAt + 120000;
    let settled = false;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolve(approved && !signal?.aborted && Date.now() < expiresAt);
    };
    const abort = () => settle(false), timer = setTimeout(abort, expiresAt - createdAt);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      Promise.resolve(handler({ requestId: `approval-${randomUUID()}`, toolName, toolArgs: structuredClone(toolArgs), mode,
        createdAt, expiresAt, resolve: settle })).catch(() => settle(false));
    } catch { settle(false); }
  });
}
