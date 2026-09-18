import { randomUUID } from 'node:crypto';
import { RunAbortedError, type RunTermination } from '@tagent/core';

export class RunAdmissionError extends Error {
  constructor(readonly code: 'RUN_ALREADY_ACTIVE' | 'RUN_CAPACITY', readonly status: 409 | 429, message: string) {
    super(message);
    this.name = 'RunAdmissionError';
  }
}

export class RunRegistry {
  private reservations = new Map<symbol, { workspaceId?: string; sessionId?: string }>();
  private runs = new Map<string, {
    runId: string; workspaceId: string; sessionId: string;
    status: 'running' | 'stopping' | 'finalizing' | 'finished';
    controller: AbortController; timer: ReturnType<typeof setTimeout>;
    termination?: RunTermination; persisted?: boolean;
  }>();

  constructor(private deadlineMs = 600_000, private maxActiveRuns = 4) {
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 1_800_000) {
      throw new Error('TAGENT_RUN_TIMEOUT_MS must be between 1000 and 1800000');
    }
    if (!Number.isInteger(maxActiveRuns) || maxActiveRuns < 1 || maxActiveRuns > 16) {
      throw new Error('TAGENT_MAX_ACTIVE_RUNS must be between 1 and 16');
    }
  }

  create(workspaceId: string, sessionId: string) {
    const reservation = this.reserve(workspaceId, sessionId);
    try { return reservation.start(workspaceId, sessionId); }
    finally { reservation.release(); }
  }

  private assertSessionAvailable(workspaceId?: string, sessionId?: string, ownReservation?: symbol) {
    if (!workspaceId || !sessionId) return;
    const active = [...this.runs.values()].some(run => run.status !== 'finished'
      && run.workspaceId === workspaceId && run.sessionId === sessionId);
    const preparing = [...this.reservations].some(([key, run]) => key !== ownReservation
      && run.workspaceId === workspaceId && run.sessionId === sessionId);
    if (active || preparing) throw new RunAdmissionError('RUN_ALREADY_ACTIVE', 409,
      '此会话已有任务正在提交、执行或保存。请等待原任务结束，或先停止原任务。');
  }

  // Reserve synchronously before creating a session or awaiting persistence.
  reserve(workspaceId?: string, sessionId?: string) {
    this.assertSessionAvailable(workspaceId, sessionId);
    if ([...this.runs.values()].filter(run => run.status !== 'finished').length + this.reservations.size >= this.maxActiveRuns) {
      throw new RunAdmissionError('RUN_CAPACITY', 429,
        `当前已有 ${this.maxActiveRuns} 个任务正在处理。请等待其中一个任务结束后再发送。`);
    }
    const key = Symbol('run reservation');
    this.reservations.set(key, { workspaceId, sessionId });
    return {
      start: (resolvedWorkspaceId: string, resolvedSessionId: string) => {
        if (!this.reservations.has(key)) throw new Error('Run reservation already released or started');
        this.assertSessionAvailable(resolvedWorkspaceId, resolvedSessionId, key);
        const run = this.startRun(resolvedWorkspaceId, resolvedSessionId);
        this.reservations.delete(key);
        return run;
      },
      release: () => { this.reservations.delete(key); },
    };
  }

  private startRun(workspaceId: string, sessionId: string) {
    const runId = `run-${randomUUID()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => this.stop(runId, 'deadline'), this.deadlineMs);
    timer.unref();
    this.runs.set(runId, { runId, workspaceId, sessionId, status: 'running', controller, timer });
    return { runId, signal: controller.signal };
  }

  get(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const { controller: _controller, timer: _timer, ...status } = run;
    return status;
  }

  stop(runId: string, termination: RunTermination = 'cancelled') {
    const run = this.runs.get(runId);
    if (run?.status === 'running') {
      run.status = 'stopping';
      run.termination = termination;
      run.controller.abort(new RunAbortedError(termination));
    }
    return this.get(runId);
  }

  finalizing(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;
    clearTimeout(run.timer);
    run.status = 'finalizing';
  }

  finish(runId: string, persisted: boolean) {
    const run = this.runs.get(runId);
    if (!run) return;
    clearTimeout(run.timer);
    run.status = 'finished';
    run.persisted = persisted;
    // Keep a bounded set of terminal records for idempotent cancel/status requests.
    const completed = [...this.runs.values()].filter(item => item.status === 'finished');
    for (const old of completed.slice(0, Math.max(0, completed.length - 100))) this.runs.delete(old.runId);
  }
}
