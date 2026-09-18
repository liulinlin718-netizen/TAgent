import type { LLMProvider } from '@tagent/ai';

export type RunTermination = 'cancelled' | 'disconnected' | 'deadline' | 'storage_failure';

export class RunAbortedError extends Error {
  constructor(readonly termination: RunTermination) {
    super(termination === 'storage_failure' ? '任务检查点保存失败，已停止后续执行。'
      : termination === 'deadline' ? '任务达到总时限，已停止。'
      : termination === 'disconnected' ? '连接已断开，任务已停止。' : '任务已取消。');
    this.name = 'RunAbortedError';
  }
}

export function runTermination(signal: AbortSignal): RunTermination {
  return signal.reason instanceof RunAbortedError ? signal.reason.termination : 'cancelled';
}

export function terminationNotice(signal: AbortSignal): string {
  return new RunAbortedError(runTermination(signal)).message
    + ' 已完成的材料会保留，但尚未完成的内容不代表已核验结论。已执行的外部操作不会自动撤销；中断请求可能仍被服务商计费，显示费用仅含已收到的用量。';
}

export function withRunSignal(provider: LLMProvider, signal?: AbortSignal): LLMProvider {
  if (!signal) return provider;
  const combine = (other?: AbortSignal) => other && other !== signal ? AbortSignal.any([signal, other]) : signal;
  // Every nested synthesis/rewrite uses the same run boundary without mutating the shared provider.
  return {
    name: provider.name,
    call(params) {
      signal.throwIfAborted();
      return provider.call({ ...params, signal: combine(params.signal) });
    },
    async *stream(params) {
      signal.throwIfAborted();
      yield* provider.stream({ ...params, signal: combine(params.signal) });
    },
  };
}

export function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
