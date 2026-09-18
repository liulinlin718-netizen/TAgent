import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import {
  assertPublicUrl, isMCPRecord, validateMCPConfig, redactMCPConfig, MCP_REDACTED,
  missingMCPInputs, type MCPServerConfig, type MCPImportSource, type MCPInputRequirement,
} from '@tagent/core';
import { fileBytes, fileUrl, importFetch, readTree, resolveGithub } from './github-source.js';
import { parseMCPDocument } from './mcp-formats.js';
import { createImportPreviewSafety, scanImportRisk } from './import-safety.js';

type Config = Omit<MCPServerConfig, 'id'>;
interface Option { name: string; config?: Config; url?: string; warning?: string; publicEnvKeys?: string[] }
interface Document { text: string; contentType: string; source: MCPImportSource; files: Array<{ path: string; bytes: number; sha256: string }> }
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const string = (value: unknown) => typeof value === 'string' ? value : '';
const record = (value: unknown) => isMCPRecord(value) ? value : {};
const list = (value: unknown) => Array.isArray(value) ? value : [];
const npmPattern = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@([a-zA-Z0-9][a-zA-Z0-9.+_-]*))?$/;
const registryRoot = 'https://registry.modelcontextprotocol.io/v0.1/servers/';
const sourceURL = (input: string) => { const url = assertPublicUrl(input); url.search = ''; url.hash = ''; return url.toString(); };
const provenance = (kind: MCPImportSource['kind'], url: string): MCPImportSource => ({ kind, url, fetchedAt: new Date().toISOString() });
const safety = (source: string, config?: Config, command = '') => createImportPreviewSafety({
  writesOnConfirm: ['.tagent/mcp.json'], commands: command ? [command] : [], envVars: Object.keys(config?.env || {}),
  externalSource: source, transport: config?.type,
  message: '确认保存只写入配置。预览不写入、不安装、不执行；stdio 任务调用还须单独授权。',
});

function npmInput(input: string): { name: string; selector: string } | undefined {
  let value = input.replace(/^npm:/, '');
  if (/^https?:/.test(value)) {
    const url = assertPublicUrl(value);
    if (['www.npmjs.com', 'npmjs.com'].includes(url.hostname)) value = decodeURIComponent(url.pathname.replace(/^\/package\//, '')).replace(/\/v\//, '@').replace(/\/$/, '');
    else if (url.hostname === 'registry.npmjs.org') {
      const parts = decodeURIComponent(url.pathname).slice(1).split('/');
      const name = parts[0]?.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift();
      value = `${name}${parts.length === 1 ? `@${parts[0]}` : parts.length ? '/invalid' : ''}`;
    } else return undefined;
  }
  const match = npmPattern.exec(value);
  return match ? { name: match[1], selector: match[2] || 'latest' } : undefined;
}

async function npmMetadata(name: string, selector: string, signal: AbortSignal) {
  if (!npmPattern.test(`${name}@${selector}`)) throw new Error('npm 包名或版本无效。');
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(selector)}`;
  const response = await importFetch(url, { signal, maxBytes: 400000, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`npm 包不存在或不可读取（HTTP ${response.status}）。`);
  const data = record(await response.json());
  if (data.name !== name || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(string(data.version))) throw new Error('npm 返回的包名或固定版本无效。');
  if (/^\d+\.\d+\.\d+/.test(selector) && data.version !== selector) throw new Error('npm 返回版本与指定版本不一致，未替换为其他版本。');
  const bins = typeof data.bin === 'string' ? { [name.split('/').pop()!]: data.bin } : record(data.bin);
  const names = Object.keys(bins);
  if (!names.length || names.length > 16 || names.some(bin => !/^[a-zA-Z0-9][\w.-]*$/.test(bin)
      // eslint-disable-next-line no-control-regex -- Reject control bytes in executable paths.
      || typeof bins[bin] !== 'string' || /[\\\x00-\x1f:]/.test(bins[bin] as string)
      || (bins[bin] as string).split('/').some(part => part === '..'))) throw new Error('npm 包没有可验证的命令入口，不能自动生成启动配置。');
  return { data, bins: names, version: String(data.version), url: `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(String(data.version))}` };
}

function templateRequirement(config: Config, location: MCPInputRequirement['location'], key: string, value: string, description?: string, required = true) {
  const placeholder = /\$?\{[^{}]+\}|<[^<>]+>|\bYOUR_[A-Z_]+\b|\/path\/to\/[^\s]*|\/Users\/username\/[^\s]*/i.exec(value)?.[0];
  if (required && (!value || placeholder)) (config.requirements ||= []).push({ location, key, description: description || `${location === 'arg' ? `参数 ${Number(key) + 1}` : key}`, required: true, ...(placeholder ? { placeholder } : {}) });
}

/** Imported credentials are never treated as the user's own credentials. */
function scrubCandidate(input: Config, publicEnvKeys: string[] = []): Config {
  const checked = validateMCPConfig(input, { allowIncomplete: true });
  const masked = redactMCPConfig({ id: 'preview', ...checked });
  const { id: _id, ...config } = masked;
  config.requirements = [...(checked.requirements || [])];
  for (const field of ['env', 'headers'] as const) {
    config[field] = Object.fromEntries(Object.entries(config[field] || {}).map(([key, value]) => {
      if (field === 'env' && publicEnvKeys.includes(key)) return [key, checked.env![key]];
      if (value === MCP_REDACTED) {
        if (!config.requirements!.some(item => item.location === (field === 'env' ? 'env' : 'header') && item.key === key)) config.requirements!.push({ location: field === 'env' ? 'env' : 'header', key, description: `填写自己的 ${key}`, required: true });
        return [key, ''];
      }
      return [key, value];
    }));
  }
  config.args = config.args?.map((arg, index) => {
    if (arg.includes(MCP_REDACTED)) {
      const placeholder = `<参数${index + 1}>`;
      config.requirements!.push({ location: 'arg', key: String(index), description: `填写参数 ${index + 1} 的凭据`, required: true, placeholder });
      return arg.replaceAll(MCP_REDACTED, placeholder);
    }
    templateRequirement(config, 'arg', String(index), arg);
    return arg;
  });
  if (config.url) {
    const url = new URL(config.url);
    for (const [key, value] of url.searchParams) if (value === MCP_REDACTED) {
      const placeholder = `TAGENT_INPUT_${config.requirements!.length}`;
      url.searchParams.set(key, placeholder);
      config.requirements!.push({ location: 'url', key, description: `填写地址参数 ${key}`, required: true, placeholder });
    }
    config.url = url.toString();
    templateRequirement(config, 'url', 'url', decodeURIComponent(config.url), '填写完整服务地址');
  }
  return validateMCPConfig(config, { allowIncomplete: true });
}

function explicitConfig(value: Record<string, unknown>, name: string): Config {
  const unsupported = ['cwd', 'envFile', 'envFilePath', 'inputs'].filter(key => value[key] !== undefined);
  if (unsupported.length) throw new Error(`配置使用了尚不支持的字段：${unsupported.join(', ')}，请用绝对路径和显式变量配置。`);
  const type = value.type === 'streamable-http' ? 'http' : value.type || (value.command ? 'stdio' : 'http');
  const config = validateMCPConfig({ ...value, name, type, url: value.url || value.serverUrl || value.httpUrl }, { allowIncomplete: true });
  for (const [key, value] of Object.entries(config.env || {})) templateRequirement(config, 'env', key, value);
  for (const [key, value] of Object.entries(config.headers || {})) templateRequirement(config, 'header', key, value);
  return config;
}

function registryVariables(config: Config, field: 'env' | 'headers', variables: unknown) {
  config[field] = {};
  for (const item of list(variables)) {
    const variable = record(item), key = string(variable.name);
    if (!key) throw new Error('Registry 变量缺少名称。');
    const value = variable.isSecret ? '' : string(variable.value) || string(variable.default);
    config[field]![key] = value;
    // Defaults belong to the publisher, not the local user's credential or directory.
    (config.requirements ||= []).push({ location: field === 'env' ? 'env' : 'header', key,
      description: string(variable.description) || key, required: variable.isRequired === true,
      ...(/\{[^{}]+\}/.test(value) ? { placeholder: /\{[^{}]+\}/.exec(value)![0] } : {}) });
  }
}

function registryArgs(config: Config, items: unknown) {
  for (const item of list(items)) {
    const arg = record(item);
    if (!['positional', 'named'].includes(string(arg.type))) throw new Error('Registry 参数类型不受支持。');
    const value = string(arg.value) || string(arg.default);
    if (!value && arg.isRequired !== true && !arg.variables) continue;
    if (arg.type === 'named') {
      if (!/^--?[a-zA-Z0-9][\w-]*$/.test(string(arg.name))) throw new Error('Registry 命名参数无效。');
      config.args!.push(String(arg.name));
    }
    const index = config.args!.length;
    const placeholder = `<${string(arg.valueHint) || `参数${index + 1}`}>`;
    config.args!.push(value || placeholder);
    templateRequirement(config, 'arg', String(index), value || placeholder, string(arg.description) || string(arg.valueHint));
  }
}

async function registryOptions(value: Record<string, unknown>, name: string, signal: AbortSignal): Promise<Option[]> {
  if (list(value.remotes).length + list(value.packages).length > 16) throw new Error('Registry 配置选项过多，请提供具体版本配置。');
  const options: Option[] = [];
  for (const [index, raw] of list(value.remotes).entries()) {
    const remote = record(raw);
    try {
      if (!['streamable-http', 'sse', 'http'].includes(string(remote.type))) throw new Error('不支持的远程传输类型。');
      const config: Config = { name, type: remote.type === 'sse' ? 'sse' : 'http', url: string(remote.url) };
      registryVariables(config, 'headers', remote.headers);
      options.push({ name: `${name} / ${config.type} ${index + 1}`, config });
    } catch (error) { options.push({ name: `${name} / 远程 ${index + 1}`, warning: (error as Error).message }); }
  }
  for (const raw of list(value.packages)) {
    const pkg = record(raw), label = `${name} / ${string(pkg.identifier) || string(pkg.registryType)}`;
    try {
      if (pkg.registryType !== 'npm' || (pkg.runtimeHint && pkg.runtimeHint !== 'npx')
          || (pkg.registryBaseUrl && !['https://registry.npmjs.org', 'https://registry.npmjs.org/'].includes(string(pkg.registryBaseUrl)))
          || record(pkg.transport).type !== 'stdio') throw new Error('该包需要其他运行环境，请按来源说明手动配置；未生成替代命令。');
      const metadata = await npmMetadata(string(pkg.identifier), string(pkg.version), signal);
      const runtimeArguments = list(pkg.runtimeArguments);
      if (runtimeArguments.some(arg => !['-y', '--yes'].includes(string(record(arg).value)) || record(arg).variables)) throw new Error('该包包含自定义 npm 运行参数，需手动核对，未丢弃参数生成配置。');
      for (const bin of metadata.bins) {
        const config: Config = { name, type: 'stdio', command: 'npx', args: ['--yes', `--package=${pkg.identifier}@${metadata.version}`, bin] };
        registryArgs(config, pkg.packageArguments);
        registryVariables(config, 'env', pkg.environmentVariables);
        const publicEnvKeys = list(pkg.environmentVariables).map(record)
          .filter(variable => !variable.isSecret && !/key|token|secret|password|credential|authorization/i.test(string(variable.name))
            && !/\{[^{}]+\}/.test(string(variable.value) || string(variable.default)))
          .map(variable => string(variable.name));
        options.push({ name: `${label} / ${bin}`, config, publicEnvKeys });
      }
    } catch (error) { options.push({ name: label, warning: (error as Error).message }); }
  }
  return options;
}

async function githubDocument(url: URL, signal: AbortSignal): Promise<Document | { source: MCPImportSource; options: Option[] }> {
  if (url.hostname === 'raw.githubusercontent.com') {
    const [owner, repo, ref, ...tail] = url.pathname.split('/').filter(Boolean);
    url = new URL(`https://github.com/${owner}/${repo}/blob/${ref}/${tail.join('/')}`);
  }
  const source = await resolveGithub(url, signal);
  const meta: MCPImportSource = { ...provenance('github', `https://github.com/${source.owner}/${source.repo}/tree/${source.commit}/${source.path}`), repository: `${source.owner}/${source.repo}`, ref: source.ref, commit: source.commit, path: source.path };
  const parts = source.path.split('/').filter(Boolean);
  const file = source.blob ? parts.pop() : undefined;
  let tree = source.tree;
  for (const part of parts) {
    const entry = (await readTree(source, tree, signal)).find(item => item.path === part && item.type === 'tree');
    if (!entry) throw new Error('找不到指定的 GitHub MCP 目录。');
    tree = entry.sha;
  }
  const entries = await readTree(source, tree, signal, !source.blob);
  if (!file) {
    const files = entries.filter(entry => entry.type === 'blob' && /^100(644|755)$/.test(entry.mode)
      && /(^|\/)(server\.json|\.?mcp\.json|README\.md|package\.json)$/i.test(entry.path));
    if (!files.length) throw new Error('目录中没有 MCP 配置或 README，请粘贴具体配置文件链接。');
    if (files.length > 48) throw new Error('仓库包含超过48份候选文档，请粘贴具体 MCP 子目录链接。');
    return { source: meta, options: files.map(entry => ({ name: [source.path, entry.path].filter(Boolean).join('/'), url: fileUrl(source, [source.path, entry.path].filter(Boolean).join('/')) })) };
  }
  const entry = entries.find(item => item.path === file && item.type === 'blob' && /^100(644|755)$/.test(item.mode));
  if (!entry) throw new Error('找不到指定的 MCP 配置文件，符号链接不可导入。');
  const bytes = await fileBytes(source, entry, signal, parts.join('/'));
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  meta.url = fileUrl(source, source.path); meta.contentHash = hash(bytes);
  return { text, contentType: '', source: meta, files: [{ path: source.path, bytes: bytes.length, sha256: hash(bytes) }] };
}

async function npmOptions(input: { name: string; selector: string }, signal: AbortSignal): Promise<{ source: MCPImportSource; options: Option[]; warnings: string[] }> {
  const metadata = await npmMetadata(input.name, input.selector, signal);
  const source: MCPImportSource = { ...provenance('npm', metadata.url), packageName: input.name, version: metadata.version,
    integrity: string(record(metadata.data.dist).integrity), contentHash: hash(JSON.stringify(metadata.data)) };
  const warnings = ['仅核实了 npm 包版本和命令入口，未安装或运行。启动参数、目录权限和额外依赖需要核对。'];
  if (string(metadata.data.mcpName)) {
    try {
      const response = await importFetch(`${registryRoot}${encodeURIComponent(string(metadata.data.mcpName))}/versions/latest`, { signal, maxBytes: 120000 });
      if (response.ok) {
        const body = record(await response.json()), server = record(body.server);
        const packages = list(server.packages).filter(pkg => record(pkg).identifier === input.name && record(pkg).version === metadata.version);
        if (packages.length) return { source, options: await registryOptions({ ...server, packages, remotes: [] }, input.name, signal), warnings };
      }
      warnings.push('未找到与该 npm 版本一致的 Registry 启动配置。');
    } catch { if (signal.aborted) throw new Error('导入元数据读取超时。'); warnings.push('Registry 暂不可达，启动参数尚未核实。'); }
  }
  const repository = record(metadata.data.repository);
  const repoURL = string(repository.url).replace(/^git\+/, '').replace(/\.git$/, '');
  const gitHead = string(metadata.data.gitHead);
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repoURL) && /^[a-f0-9]{40}$/.test(gitHead)) {
    try {
      const git = await resolveGithub(new URL(`${repoURL}/tree/${gitHead}`), signal);
      const tree = await readTree(git, git.tree, signal, true);
      const packageFiles = tree.filter(entry => entry.type === 'blob' && /^100(644|755)$/.test(entry.mode) && /(^|\/)package\.json$/.test(entry.path));
      const directory = string(repository.directory).replace(/\/$/, '');
      const candidates = directory ? packageFiles.filter(entry => entry.path === `${directory}/package.json`) : packageFiles;
      if (candidates.length > 16) throw new Error('包仓库过大，无法确认 README 位置。');
      for (const entry of candidates) {
        const packageJSON = record(JSON.parse((await fileBytes(git, entry, signal)).toString('utf8')));
        if (packageJSON.name !== input.name) continue;
        const root = entry.path.slice(0, -'package.json'.length);
        const readme = tree.find(item => item.path.toLowerCase() === `${root}readme.md`.toLowerCase() && item.type === 'blob' && /^100(644|755)$/.test(item.mode));
        if (!readme) continue;
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await fileBytes(git, readme, signal));
        const options = parseMCPDocument(text).flatMap(entry => {
          if (!['npx', 'npx.cmd'].includes(string(entry.value.command)) || !Array.isArray(entry.value.args)) return [];
          let packageFound = false;
          const args = entry.value.args.map(arg => {
            if (typeof arg !== 'string') return arg;
            const parsed = npmInput(arg.replace(/^--package=/, ''));
            if (parsed?.name !== input.name) return arg;
            packageFound = true;
            return `${arg.startsWith('--package=') ? '--package=' : ''}${input.name}@${metadata.version}`;
          });
          if (!packageFound) return [];
          return [{ name: `${input.name} / ${entry.name}`, config: explicitConfig({ ...entry.value, args }, input.name) }];
        });
        if (options.length) return { source: { ...source, repository: repoURL, commit: git.commit, path: readme.path }, options,
          warnings: ['启动参数来自该 npm 发布记录对应提交的 README；包版本已固定，尚未安装或验证连接。'] };
      }
      warnings.push('对应发布提交中未找到该包的明确 npx 配置示例。');
    } catch { if (signal.aborted) throw new Error('导入元数据读取超时。'); warnings.push('无法核对对应发布提交的 README，请检查启动参数。'); }
  }
  if (record(metadata.data.scripts).postinstall || record(metadata.data.scripts).preinstall) warnings.push('该包声明了安装生命周期脚本，授权运行前请审查来源。');
  return { source, warnings, options: metadata.bins.map(bin => ({ name: `${input.name} / ${bin}`, config: {
    name: input.name, type: 'stdio', command: 'npx', args: ['--yes', `--package=${input.name}@${metadata.version}`, bin], env: {},
  } })) };
}

export async function previewMCPImport(input: unknown, signal = AbortSignal.timeout(30000)) {
  if (!isMCPRecord(input)) throw new Error('导入请求必须是 JSON 对象。');
  const supplied = ['source', 'url', 'packageName', 'text'].filter(key => input[key] !== undefined && input[key] !== '');
  if (supplied.length !== 1 || typeof input[supplied[0]] !== 'string') throw new Error('请分别提供一个来源地址、npm 包名或配置文本。');
  const raw = (input[supplied[0]] as string).trim();
  if (!raw || raw.length > (supplied[0] === 'text' ? 120000 : 8192)) throw new Error('导入来源为空或过长。');
  if (input.choiceId !== undefined && typeof input.choiceId !== 'string') throw new Error('配置选择无效。');
  let source: MCPImportSource;
  let options: Option[] = [];
  let warnings: string[] = [];
  let files: Document['files'] = [];
  let document: Document | undefined;
  const npm = supplied[0] === 'text' ? undefined : npmInput(raw);
  if (npm) ({ source, options, warnings } = await npmOptions(npm, signal));
  else if (supplied[0] === 'text') {
    source = { ...provenance('inline', 'inline'), contentHash: hash(raw) };
    document = { text: raw, contentType: '', source, files: [] };
  } else {
    const url = assertPublicUrl(raw);
    if (['github.com', 'www.github.com', 'raw.githubusercontent.com'].includes(url.hostname)) {
      const result = await githubDocument(url, signal);
      source = result.source;
      if ('options' in result) options = result.options; else document = result;
    } else {
      const response = await importFetch(url.toString(), { signal, maxBytes: 120000 });
      if (!response.ok) throw new Error(`来源读取失败（HTTP ${response.status}），没有生成替代配置。`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      source = { ...provenance(url.hostname === 'registry.modelcontextprotocol.io' ? 'registry' : 'url', sourceURL(raw)), contentHash: hash(bytes) };
      document = { text, contentType: response.headers.get('content-type') || '', source, files: [{ path: url.pathname, bytes: bytes.length, sha256: hash(bytes) }] };
    }
  }
  if (document) {
    files = document.files;
    for (const entry of parseMCPDocument(document.text, document.contentType)) {
      if (options.length >= 48) throw new Error('文档配置过多，请提供具体配置文件。');
      try {
        if (entry.value.packages || entry.value.remotes) options.push(...await registryOptions(entry.value, entry.name, signal));
        else if (entry.value.bin !== undefined && entry.value.name) {
          const npm = await npmOptions({ name: string(entry.value.name), selector: string(entry.value.version) || 'latest' }, signal);
          options.push(...npm.options); warnings.push(...npm.warnings);
        } else options.push({ name: entry.name, config: explicitConfig(entry.value, entry.name) });
      } catch (error) { options.push({ name: entry.name, warning: (error as Error).message }); }
    }
  }
  const unique = new Map<string, Option>();
  for (const option of options) {
    try {
      if (option.config) option.config = scrubCandidate({ ...option.config, source }, option.publicEnvKeys);
    } catch (error) { option.config = undefined; option.warning = (error as Error).message; }
    unique.set(hash(JSON.stringify({ ...option, config: option.config ? { ...option.config, source: undefined } : undefined })), option);
  }
  const choices = [...unique].map(([id, option]) => ({ id, name: option.name, url: option.url, type: option.config?.type,
    commandPreview: option.config?.type === 'stdio' ? [option.config.command!, ...(option.config.args || [])].map(part => JSON.stringify(part)).join(' ') : option.config?.url,
    error: option.warning, available: Boolean(option.config || option.url) }));
  if (!choices.length) throw new Error('未找到可解析的 MCP 配置。请提供 mcp.json、server.json、含 JSON 配置的 README 或 npm 包名；网页地址不会被当作 MCP 服务地址。');
  const selected = input.choiceId ? unique.get(input.choiceId) : choices.length === 1 ? unique.get(choices[0].id) : undefined;
  if (input.choiceId && !selected) throw new Error('来源内容已变化或选择无效，请重新预览。');
  if (!selected?.config) return { status: 'selection_required' as const, source, choices, files, warnings, ...safety(source.url) };
  const candidate = selected.config;
  const commandPreview = candidate.type === 'stdio' ? [candidate.command!, ...(candidate.args || [])].map(part => JSON.stringify(part)).join(' ') : '';
  const risk = scanImportRisk(JSON.stringify(candidate), source.url, commandPreview);
  // Risk classification may inspect prose, but never echo an upstream README's secrets or commands.
  if (document) {
    const documentRisk = scanImportRisk(document.text, source.url);
    risk.flags = [...new Set([...risk.flags, ...documentRisk.flags])];
    if (documentRisk.level === 'high') risk.level = 'high';
  }
  risk.commands = commandPreview ? [commandPreview] : [];
  risk.envVars = Object.keys(candidate.env || {});
  warnings = [...new Set([...warnings, '来源中的认证值不会直接沿用，请填写自己的凭据。预览不代表连接已经验证。'])];
  return { status: missingMCPInputs(candidate).length ? 'needs_input' as const : 'ready' as const, source, candidate, choices, files, warnings,
    risk, commandPreview, preview: JSON.stringify(candidate, null, 2), ...safety(source.url, candidate, commandPreview) };
}

export function createMCPImportRoutes() {
  const routes = new Hono();
  for (const path of ['/import', '/import/preview']) routes.post(path, async c => {
    try {
      const body = await c.req.json().catch(() => { throw new Error('导入请求必须是有效 JSON。'); });
      return c.json(await previewMCPImport(body, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)])));
    }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : 'MCP 导入失败。', ...safety('') }, 400); }
  });
  return routes;
}
