export type ProviderFailureCode = 'dns' | 'tls' | 'connection' | 'timeout' | 'authentication' | 'permission'
  | 'quota' | 'rate_limit' | 'not_found' | 'context_limit' | 'tool_protocol' | 'invalid_request' | 'invalid_response' | 'upstream';

export interface ProviderOptions {
  apiKey?: string;
  baseURL?: string;
  name?: string;
  timeout?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
}

const notices: Record<ProviderFailureCode, string> = {
  dns: '模型服务域名解析失败，请检查服务地址和本机 DNS。',
  tls: '模型服务的安全连接校验失败，请检查系统时间、证书及可信代理；不要关闭证书校验。',
  connection: '无法连接模型服务或连接中断，请检查网络、服务地址与代理配置。',
  timeout: '模型请求超过时限，已停止等待；可缩小任务或由管理员调整请求时限。中断请求仍可能被服务商计费。',
  authentication: '模型服务认证失败，请检查所选服务的 API Key 是否正确、有效。',
  permission: '模型服务拒绝访问，请检查账户权限、模型访问范围与服务可用地区。',
  quota: '模型服务报告额度或余额不足，请检查该服务账户的用量与账单。',
  rate_limit: '模型服务请求过于频繁或达到速率限制，请稍后手动重试。',
  not_found: '模型或接口不存在，请检查模型名称、服务地址及兼容接口路径。',
  context_limit: '本次输入超过模型上下文限制，请缩小任务或减少材料后重试。',
  tool_protocol: '模型服务拒绝了工具消息配对或工具参数，需要检查工具协议；本次不会继续执行工具。',
  invalid_request: '模型服务不接受当前请求格式或参数，请检查模型与接口兼容性。',
  invalid_response: '模型服务返回了不完整或无法解析的响应，本次不能作为完整结果。',
  upstream: '模型服务返回异常，请稍后重试；持续失败时请联系服务提供方。',
};

/** Safe to show in a report: never retains provider bodies, headers, keys, prompts or raw causes. */
export class ProviderRequestError extends Error {
  readonly provider: string;
  constructor(provider: string, readonly code: ProviderFailureCode, readonly status?: number) {
    const label = /^[a-z0-9._-]{1,32}$/i.test(provider) ? provider : 'model';
    super(`${label} [${code}${status ? ` / HTTP ${status}` : ''}]：${notices[code]}`);
    this.name = 'ProviderRequestError';
    this.provider = label;
  }
}

export function classifyProviderError(provider: string, error: unknown): ProviderRequestError {
  if (error instanceof ProviderRequestError) return error;
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const codes: string[] = [], messages: string[] = [];
  let status: number | undefined;
  for (let index = 0; index < queue.length && index < 16; index++) {
    const item = queue[index];
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const value = item as Record<string, unknown>;
    if (status === undefined && typeof value.status === 'number' && Number.isInteger(value.status) && value.status >= 400 && value.status <= 599) status = value.status;
    for (const field of ['code', 'type', 'name']) if (typeof value[field] === 'string') codes.push(value[field].slice(0, 120));
    if (typeof value.message === 'string') messages.push(value.message.slice(0, 2048));
    queue.push(value.cause, value.error);
    if (Array.isArray(value.errors)) queue.push(...value.errors.slice(0, 8));
  }
  const code = codes.join(' '), message = messages.join(' ');
  const failure = (kind: ProviderFailureCode) => new ProviderRequestError(provider, kind, status);
  if (status === 401) return failure('authentication');
  if (status === 403) return failure('permission');
  if (status === 402 || /insufficient_quota|billing_hard_limit|credit_balance_too_low/i.test(code)) return failure('quota');
  if (status === 429) return failure('rate_limit');
  if (status === 404) return failure('not_found');
  if (status === 408 || /Timeout|ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT/i.test(code)) return failure('timeout');
  if (status === 400 || status === 413 || status === 422) {
    if (/context_length_exceeded|prompt_too_long/i.test(code) || /context.{0,30}(length|limit)|maximum context|prompt is too long/i.test(message)) return failure('context_limit');
    if (/tool_(use|result|call)|function.arguments/i.test(message)) return failure('tool_protocol');
    return failure('invalid_request');
  }
  if (status !== undefined) return failure('upstream');
  if (/ENOTFOUND|EAI_AGAIN|EAI_FAIL/.test(code)) return failure('dns');
  if (/CERT_|TLS_|SSL_|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return failure('tls');
  if (/ECONN|ENET|EHOST|UND_ERR_SOCKET|APIConnectionError/.test(code) || /connection|fetch failed|network/i.test(message)) return failure('connection');
  if (/SyntaxError/.test(code)) return failure('invalid_response');
  return failure('upstream');
}

/** Covers headers AND the complete response body/stream; caller cancellation keeps its own reason. */
export function providerRequest(provider: string, timeoutMs: number, caller?: AbortSignal) {
  caller?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('Model timeout must be a positive finite duration');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ProviderRequestError(provider, 'timeout')), timeoutMs);
  timer.unref?.();
  return {
    signal: caller ? AbortSignal.any([caller, controller.signal]) : controller.signal,
    fail(error: unknown): never {
      caller?.throwIfAborted();
      if (controller.signal.aborted) throw controller.signal.reason;
      throw classifyProviderError(provider, error);
    },
    dispose() { clearTimeout(timer); controller.abort(); },
  };
}
