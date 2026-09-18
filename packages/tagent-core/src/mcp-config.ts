import { assertPublicUrl } from './public-network.js';

export type MCPTransportType = 'stdio' | 'sse' | 'http';
export interface MCPImportSource {
  kind: 'github' | 'npm' | 'registry' | 'url' | 'inline';
  url: string;
  fetchedAt: string;
  repository?: string;
  ref?: string;
  commit?: string;
  path?: string;
  contentHash?: string;
  packageName?: string;
  version?: string;
  integrity?: string;
}
export interface MCPInputRequirement {
  location: 'arg' | 'env' | 'header' | 'url';
  key: string;
  description: string;
  required: boolean;
  placeholder?: string;
}
export interface MCPServerConfig {
  id: string;
  name: string;
  type: MCPTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  revision?: number;
  executionApproved?: boolean;
  source?: MCPImportSource;
  requirements?: MCPInputRequirement[];
}

export const MCP_REDACTED = '[saved-secret]';
export class MCPConfigError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503 = 400) { super(message); }
}

export function isMCPRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringMap(value: unknown, headers = false): Record<string, string> {
  if (value === undefined) return {};
  if (!isMCPRecord(value) || Object.keys(value).length > 64) throw new MCPConfigError('变量必须为名称与文本值组成的对象，最多64项。');
  const entries = Object.entries(value);
  if (headers && new Set(entries.map(([key]) => key.toLowerCase())).size !== entries.length) throw new MCPConfigError('请求头名称不能重复。');
  for (const [key, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(key) || typeof item !== 'string' || item.length > 16000 || item.includes('\0')) throw new MCPConfigError('变量名称或内容无效。');
    if (headers && (/\r|\n/.test(item) || /^(host|connection|content-length|proxy-authorization|cookie|mcp-session-id|mcp-protocol-version)$/i.test(key))) throw new MCPConfigError('请求头包含保留字段或非法换行。');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Validation never interpolates host environment variables or grants runtime permission. */
export function validateMCPConfig(value: unknown, options: { allowIncomplete?: boolean } = {}): Omit<MCPServerConfig, 'id'> {
  if (!isMCPRecord(value) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160) throw new MCPConfigError('请填写有效的 MCP 名称。');
  if (!['stdio', 'http', 'sse'].includes(String(value.type))) throw new MCPConfigError('MCP 类型必须是 stdio、http 或 sse。');
  const result: Omit<MCPServerConfig, 'id'> = { name: value.name.trim(), type: value.type as MCPTransportType };
  if (value.source !== undefined) {
    if (!isMCPRecord(value.source) || !['github', 'npm', 'registry', 'url', 'inline'].includes(String(value.source.kind))) throw new MCPConfigError('MCP 来源元数据无效。');
    const source = value.source;
    if (typeof source.url !== 'string' || typeof source.fetchedAt !== 'string' || !Number.isFinite(Date.parse(source.fetchedAt))) throw new MCPConfigError('MCP 来源地址或日期无效。');
    if (source.kind === 'inline' && source.url !== 'inline') throw new MCPConfigError('内联 MCP 来源标记无效。');
    const fields = ['url', 'fetchedAt', 'repository', 'ref', 'commit', 'path', 'contentHash', 'packageName', 'version', 'integrity'];
    const safe: Record<string, string> = { kind: String(source.kind) };
    for (const key of fields) if (source[key] !== undefined) {
      if (typeof source[key] !== 'string' || source[key].length > 8192 || source[key].includes('\0')) throw new MCPConfigError('MCP 来源元数据无效。');
      safe[key] = source[key];
    }
    if (source.kind !== 'inline') {
      try { const url = assertPublicUrl(safe.url); url.search = ''; url.hash = ''; safe.url = url.toString(); }
      catch { throw new MCPConfigError('MCP 来源必须是公开 HTTP(S) 地址。'); }
    }
    result.source = safe as unknown as MCPImportSource;
  }
  if (value.requirements !== undefined) {
    if (!Array.isArray(value.requirements) || value.requirements.length > 192) throw new MCPConfigError('MCP 待填写字段过多或格式无效。');
    result.requirements = value.requirements.map(item => {
      if (!isMCPRecord(item) || !['arg', 'env', 'header', 'url'].includes(String(item.location)) || typeof item.key !== 'string' || item.key.length > 128 || typeof item.description !== 'string' || item.description.length > 2000 || typeof item.required !== 'boolean' || (item.placeholder !== undefined && (typeof item.placeholder !== 'string' || item.placeholder.length > 16000))) throw new MCPConfigError('MCP 待填写字段无效。');
      if (item.location === 'arg' && (!/^(0|[1-9][0-9]*)$/.test(item.key) || Number(item.key) > 127)) throw new MCPConfigError('MCP 参数位置无效。');
      if (item.placeholder === '') throw new MCPConfigError('MCP 字段占位符不能为空。');
      return { location: item.location, key: item.key, description: item.description, required: item.required, ...(item.placeholder === undefined ? {} : { placeholder: item.placeholder }) } as MCPInputRequirement;
    });
  }
  if (result.type === 'stdio') {
    if (typeof value.command !== 'string' || !value.command.trim() || value.command.length > 2048 || /[\0\r\n]/.test(value.command)) throw new MCPConfigError('请填写单个可执行文件名称或路径。');
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 128 || value.args.some(arg => typeof arg !== 'string' || arg.length > 16000 || arg.includes('\0')))) throw new MCPConfigError('命令参数必须为文本数组，最多128项。');
    result.command = value.command.trim();
    result.args = (value.args as string[] | undefined)?.slice() || [];
    result.env = stringMap(value.env);
  } else {
    if (typeof value.url !== 'string' || value.url.length > 8192) throw new MCPConfigError('请填写公开 MCP 服务地址。');
    try { result.url = assertPublicUrl(value.url).toString(); } catch { throw new MCPConfigError('MCP 地址必须是无用户名密码的公开 HTTP(S) 地址，不允许本机或内网地址。'); }
    result.headers = stringMap(value.headers, true);
    if (new URL(result.url).protocol !== 'https:' && (Object.values(result.headers).some(Boolean) || new URL(result.url).search)) throw new MCPConfigError('带认证信息的 MCP 必须使用 HTTPS。');
  }
  if (!options.allowIncomplete) {
    const missing = missingMCPInputs(result);
    if (missing.length) throw new MCPConfigError(`请先填写 MCP 配置：${missing.map(item => item.description || item.key).join('；')}`);
  }
  return result;
}

export function missingMCPInputs(config: Omit<MCPServerConfig, 'id'>): MCPInputRequirement[] {
  return (config.requirements || []).filter(item => {
    const value = item.location === 'arg' ? config.args?.[Number(item.key)]
      : item.location === 'env' ? config.env?.[item.key] : item.location === 'header' ? config.headers?.[item.key] : config.url;
    return item.required && (!value?.trim() || (item.placeholder !== undefined && (value.includes(item.placeholder) || value.includes(encodeURIComponent(item.placeholder)))));
  });
}

const secretOption = /^--?[\w-]*(key|token|secret|password|credential|authorization)[\w-]*(=|$)/i;
function credentialValues(server: MCPServerConfig): string[] {
  const values = [...Object.values(server.env || {}), ...Object.values(server.headers || {})];
  for (const value of Object.values(server.headers || {})) { const token = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value); if (token) values.push(token[1]); }
  if (server.url) { try { values.push(...new URL(server.url).searchParams.values()); } catch { /* Legacy invalid URLs remain editable. */ } }
  let next = false;
  for (const arg of server.args || []) {
    if (next) { values.push(arg); next = false; }
    else if (secretOption.test(arg)) { if (arg.includes('=')) values.push(arg.slice(arg.indexOf('=') + 1)); else next = true; }
  }
  return [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length);
}

export function redactMCPText(text: string, server: MCPServerConfig): string {
  let result = text;
  for (const secret of credentialValues(server)) {
    for (const variant of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) result = result.split(variant).join('[redacted]');
  }
  return result;
}

export function redactMCPValue<T>(value: T, server: MCPServerConfig): T {
  if (typeof value === 'string') return redactMCPText(value, server) as T;
  if (Array.isArray(value)) return value.map(item => redactMCPValue(item, server)) as T;
  if (isMCPRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactMCPText(key, server), redactMCPValue(item, server)])) as T;
  return value;
}

/** Complete masks, not credential prefixes. The placeholder can only restore an existing value. */
export function redactMCPConfig(server: MCPServerConfig): MCPServerConfig {
  const result = structuredClone(server);
  for (const field of ['env', 'headers'] as const) result[field] = Object.fromEntries(Object.entries(server[field] || {}).map(([key, value]) => [key, value ? MCP_REDACTED : '']));
  if (server.url) {
    try { const url = new URL(server.url); for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, MCP_REDACTED); result.url = url.toString(); }
    catch { result.url = ''; }
  }
  let secretNext = false;
  result.args = server.args?.map(arg => {
    if (secretNext) { secretNext = false; return MCP_REDACTED; }
    if (secretOption.test(arg)) {
      if (arg.includes('=')) return arg.slice(0, arg.indexOf('=') + 1) + MCP_REDACTED;
      secretNext = true; return arg;
    }
    return credentialValues(server).some(secret => arg.includes(secret)) ? MCP_REDACTED : arg;
  });
  return result;
}

export function restoreMCPUpdate(updates: Record<string, unknown>, previous: MCPServerConfig): Omit<MCPServerConfig, 'id'> {
  const masked = redactMCPConfig(previous);
  const merged = { ...previous, ...updates };
  let sameTarget = merged.type === previous.type && merged.command === previous.command;
  if (merged.type !== 'stdio') {
    try { sameTarget = merged.type === previous.type && new URL(String(merged.url)).origin === new URL(previous.url!).origin && new URL(String(merged.url)).pathname === new URL(previous.url!).pathname; }
    catch { sameTarget = false; }
  }
  if (!sameTarget) {
    for (const field of ['env', 'headers'] as const) if (Object.values(previous[field] || {}).some(Boolean) && !Object.hasOwn(updates, field)) throw new MCPConfigError('目标已改变，请重新输入凭据或明确清空变量。');
    if (masked.args?.some(arg => arg.includes(MCP_REDACTED)) && !Object.hasOwn(updates, 'args')) throw new MCPConfigError('命令已改变，请重新输入参数。');
  }
  for (const field of ['env', 'headers'] as const) if (isMCPRecord(updates[field])) {
    merged[field] = Object.fromEntries(Object.entries(updates[field]).map(([key, value]) => {
      if (value !== MCP_REDACTED) return [key, value];
      if (!sameTarget || !previous[field]?.[key]) throw new MCPConfigError('目标已改变或凭据不存在，请重新输入凭据。');
      return [key, previous[field]![key]];
    })) as Record<string, string>;
  }
  if (typeof updates.url === 'string' && (updates.url.includes(MCP_REDACTED) || updates.url.includes(encodeURIComponent(MCP_REDACTED)))) {
    if (!sameTarget || updates.url !== masked.url) throw new MCPConfigError('地址已改变，请重新输入完整 MCP 地址。');
    merged.url = previous.url;
  }
  if (Array.isArray(updates.args)) merged.args = updates.args.map((arg, index) => {
    if (typeof arg !== 'string' || !arg.includes(MCP_REDACTED)) return arg;
    if (!sameTarget || arg !== masked.args?.[index]) throw new MCPConfigError('参数已改变，请重新输入参数中的凭据。');
    return previous.args![index];
  });
  const config = validateMCPConfig(merged);
  if (JSON.stringify(config).includes(MCP_REDACTED)) throw new MCPConfigError('凭据占位符无效，请重新输入。');
  return config;
}
