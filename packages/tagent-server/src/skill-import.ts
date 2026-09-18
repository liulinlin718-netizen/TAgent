import { createHash } from 'node:crypto';
import { load as loadYaml, JSON_SCHEMA } from 'js-yaml';
import { assertPublicUrl, createSkillPackageDraft } from '@tagent/core';
import type { SkillInput, SkillPackageFile, SkillPackageSource } from '@tagent/core';
import { createImportPreviewSafety, scanImportRisk } from './import-safety.js';
import { readSkillArchive } from './skill-archive.js';
import { resolveGithub, readTree, fileUrl, fileBytes, importFetch, type TreeEntry } from './github-source.js';
export { validSkillFilePath } from './github-source.js';

const MAX_FILE = 120_000;
const MAX_TOTAL = 1_000_000;
const MAX_FILES = 256;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('远程内容格式无效。');
  return value as Record<string, unknown>;
};
const textValue = (value: unknown) => typeof value === 'string' ? value.trim() : '';
interface ResolvedSkill { source: SkillPackageSource; files: SkillPackageFile[]; text: string; warnings: string[]; strict: boolean }

export interface SkillImportChoice { name: string; path: string; url: string }
export interface SkillImportRequest { source?: string; url?: string; markdown?: string; name?: string }

function safety(source: string, commands: string[] = [], envVars: string[] = []) {
  return createImportPreviewSafety({
    writesOnConfirm: ['.tagent/skills.json'], commands, envVars, externalSource: source,
    message: '确认后只保存 Skill 内容；不会安装依赖或执行附属脚本。',
  });
}

function utf8(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function githubSkill(url: URL, signal: AbortSignal): Promise<ResolvedSkill | { choices: SkillImportChoice[] }> {
  const source = await resolveGithub(url, signal);
  const selectedParts = source.path ? source.path.split('/') : [];
  const fileName = source.blob ? selectedParts.pop() : undefined;
  if (source.blob && !fileName) throw new Error('请提供具体文件链接。');
  let treeId = source.tree;
  for (const part of selectedParts) {
    const entry = (await readTree(source, treeId, signal)).find(item => item.path === part && item.type === 'tree');
    if (!entry) throw new Error('找不到指定 Skill 目录，不会改为导入仓库 README。');
    treeId = entry.sha;
  }
  const root = selectedParts.join('/');
  const top = await readTree(source, treeId, signal);
  const main = top.find(item => item.path === (fileName || 'SKILL.md'));
  if (!main) {
    if (fileName) throw new Error('找不到指定文件，不会改为导入仓库 README。');
    const choices = (await readTree(source, treeId, signal, true))
      .filter(item => item.type === 'blob' && item.path.split('/').at(-1) === 'SKILL.md' && item.mode === '100644')
      .map(item => ({ name: item.path.replace(/\/?SKILL\.md$/, '') || source.repo, path: [root, item.path].filter(Boolean).join('/'), url: fileUrl(source, [root, item.path].filter(Boolean).join('/')) }));
    if (!choices.length) throw new Error('该目录没有 SKILL.md。它可能是工具项目而非 Skill，请选择包含 SKILL.md 的目录；不会用 README 冒充 Skill。');
    return { choices };
  }
  if (main.type !== 'blob' || !['100644', '100755'].includes(main.mode)) throw new Error('Skill 入口必须是普通文件，不能是链接或子模块。');
  if (!/\.(md|markdown|txt)$/i.test(main.path)) throw new Error('请选择 SKILL.md 或 Markdown 文件，不能把代码文件当作执行说明。');
  if ((main.size || 0) > MAX_FILE) throw new Error('Skill 执行说明超过 120 KB，请拆分文件后重试。');
  const mainBytes = await fileBytes(source, main, signal, root);
  const text = utf8(mainBytes);
  const entryPath = [root, main.path].filter(Boolean).join('/');
  const files: SkillPackageFile[] = [{ path: main.path, url: fileUrl(source, entryPath), sha: main.sha, size: mainBytes.length, encoding: 'utf8', content: text, status: 'included' }];
  const warnings: string[] = [];
  let bytesUsed = mainBytes.length;
  const entries = main.path === 'SKILL.md' ? await readTree(source, treeId, signal, true) : [];
  if (entries.filter(item => item.type !== 'tree').length > MAX_FILES) throw new Error('Skill 超过 256 个文件，请选择更小的独立 Skill 目录。未生成不完整草稿。');
  const pending: Array<{ entry: TreeEntry; file: SkillPackageFile }> = [];
  for (const entry of entries) {
    if (entry.path === main.path || entry.type === 'tree') continue;
    const file: SkillPackageFile = { path: entry.path, url: fileUrl(source, [root, entry.path].filter(Boolean).join('/')), sha: entry.sha, size: entry.size || 0, status: 'reference_only' };
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) file.reason = '链接或子模块不导入';
    else if (entry.size === undefined || entry.size > MAX_FILE || bytesUsed + entry.size > MAX_TOTAL) file.reason = '超过文件或包大小限制';
    else { bytesUsed += entry.size; pending.push({ entry, file }); }
    files.push(file);
  }
  const downloads = new Map<string, Promise<Buffer>>([[main.sha, Promise.resolve(mainBytes)]]);
  const controller = new AbortController();
  const downloadSignal = AbortSignal.any([signal, controller.signal]);
  try {
    if (new Set(pending.map(item => item.entry.sha)).size > 8) {
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      const response = await importFetch(`https://api.github.com/repos/${source.owner}/${source.repo}/zipball/${source.commit}`, {
        signal: downloadSignal, maxBytes: 8_000_000,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error(`GitHub 归档读取失败（HTTP ${response.status}），未生成草稿。`);
      const wanted = new Map(pending.map(({ entry }) => [[root, entry.path].filter(Boolean).join('/'), entry.size!]));
      const archived = await readSkillArchive(Buffer.from(await response.arrayBuffer()), wanted, downloadSignal);
      for (const { entry } of pending) {
        const bytes = archived.get([root, entry.path].filter(Boolean).join('/'))!;
        const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (sha !== entry.sha) throw new Error(`归档文件版本校验失败：${entry.path}`);
        downloads.set(entry.sha, Promise.resolve(bytes));
      }
    }
    for (let offset = 0; offset < pending.length; offset += 4) await Promise.all(pending.slice(offset, offset + 4).map(async ({ entry, file }) => {
      if (!downloads.has(entry.sha)) downloads.set(entry.sha, fileBytes(source, entry, downloadSignal, root));
      const bytes = await downloads.get(entry.sha)!;
      try { file.content = utf8(bytes); file.encoding = file.content.includes('\0') ? 'base64' : 'utf8'; }
      catch { file.encoding = 'base64'; }
      if (file.encoding === 'base64') file.content = bytes.toString('base64');
      if (file.content?.startsWith('version https://git-lfs.github.com/spec/v1')) {
        file.reason = 'Git LFS 文件仅返回指针，未下载实际资源';
        delete file.content;
        delete file.encoding;
      } else file.status = 'included';
    }));
  } catch (error) { controller.abort(); throw error; }
  if (files.some(file => file.status !== 'included')) warnings.push('部分附属文件仅保留来源，未读取内容，风险扫描不完整。');
  if (main.path !== 'SKILL.md') warnings.push('这是单文件导入，未导入同目录资源。');
  return { text, files, warnings, strict: main.path === 'SKILL.md', source: { kind: 'github', url: fileUrl(source, entryPath), repository: `${source.owner}/${source.repo}`, ref: source.ref, commit: source.commit, root, complete: main.path === 'SKILL.md' && files.every(file => file.status === 'included') } };
}

function candidateFromResolved(resolved: ResolvedSkill, nameOverride?: string): SkillInput {
  const normalized = resolved.text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (normalized.startsWith('---\n') && !frontmatter) throw new Error('SKILL.md 的 YAML 元数据缺少结束分隔线。');
  let metadata: Record<string, unknown> = {};
  if (frontmatter) {
    try { metadata = record(loadYaml(frontmatter[1], { schema: JSON_SCHEMA })); }
    catch { throw new Error('Skill YAML 元数据无效，请检查重复字段、缩进或不支持的标签。'); }
  }
  if (resolved.strict && (!textValue(metadata.name) || !textValue(metadata.description))) throw new Error('SKILL.md 必须包含 name 和 description 元数据。');
  const instructions = frontmatter ? normalized.slice(frontmatter[0].length).trim() : normalized.trim();
  if (!instructions) throw new Error('Skill 没有执行说明，未生成草稿。');
  const name = nameOverride?.trim() || textValue(metadata.name) || instructions.match(/^#\s+(.+)$/m)?.[1]?.trim() || '导入的 Skill';
  const extra = metadata.metadata && typeof metadata.metadata === 'object' && !Array.isArray(metadata.metadata) ? metadata.metadata as Record<string, unknown> : {};
  const base = { name, description: textValue(metadata.description), category: textValue(metadata.category) || 'imported', trigger: textValue(metadata.trigger), body: instructions };
  const pkg = createSkillPackageDraft(base);
  pkg.manifest.version = String(metadata.version || extra.version || '1.0.0');
  pkg.manifest.license = textValue(metadata.license) || undefined;
  pkg.manifest.compatibility = textValue(metadata.compatibility) || undefined;
  pkg.manifest.tags = Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  pkg.files = resolved.files;
  pkg.source = resolved.source;
  pkg.inputs = [];
  pkg.outputs = [];
  pkg.tests = [];
  // External allowed-tools is metadata, never a grant of TAgent runtime permissions.
  if (metadata['allowed-tools']) resolved.warnings.push('来源声明了工具需求；不会自动授予 Agent 工具权限。');
  return { ...base, package: pkg };
}

export async function previewSkillImport(input: SkillImportRequest) {
  if (!input || typeof input !== 'object' || ['source', 'url', 'markdown', 'name'].some(key => input[key as keyof SkillImportRequest] !== undefined && typeof input[key as keyof SkillImportRequest] !== 'string')) throw new Error('导入参数必须为文本。');
  const sourceUrl = (input.source || input.url || '').trim();
  if (sourceUrl && input.markdown) throw new Error('URL 导入与粘贴 Markdown 请分开使用，避免覆盖远程来源。');
  let resolved: ResolvedSkill;
  const signal = AbortSignal.timeout(60_000);
  if (sourceUrl) {
    const url = await assertPublicUrl(sourceUrl);
    if (url.username || url.password) throw new Error('导入链接不能包含账号或密钥。');
    if (url.hostname === 'raw.githubusercontent.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      url.hostname = 'github.com';
      url.pathname = `/${parts.slice(0, 2).join('/')}/blob/${parts.slice(2).join('/')}`;
    }
    if (url.hostname === 'github.com') {
      const result = await githubSkill(url, signal);
      if ('choices' in result) return { status: 'selection_required' as const, choices: result.choices, ...safety(sourceUrl) };
      resolved = result;
    } else {
      const response = await importFetch(url.toString(), { signal, maxBytes: MAX_FILE });
      if (!response.ok) throw new Error(`读取 Skill 失败（HTTP ${response.status}），未生成占位草稿。`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const text = utf8(bytes);
      if (/text\/html/i.test(response.headers.get('content-type') || '') || /^\s*<!doctype html|^\s*<html/i.test(text)) throw new Error('该链接是网页，不是 Skill 文件。请粘贴原始 SKILL.md 链接。');
      resolved = { text, strict: false, source: { kind: 'url', url: sourceUrl, complete: false }, files: [{ path: 'SKILL.md', url: sourceUrl, size: bytes.length, encoding: 'utf8', content: text, status: 'included' }], warnings: ['单文件导入，未获取链接中的其他资源。'] };
    }
  } else {
    if (!input.markdown?.trim()) throw new Error('请提供 Skill URL 或 Markdown。');
    if (Buffer.byteLength(input.markdown) > MAX_FILE) throw new Error('Markdown 超过 120 KB。');
    resolved = { text: input.markdown, strict: false, source: { kind: 'inline', url: 'inline', complete: false }, files: [], warnings: [] };
  }
  const candidate = candidateFromResolved(resolved, input.name);
  const risk = scanImportRisk(resolved.files.length ? resolved.files.filter(file => file.encoding === 'utf8').map(file => `${file.path}\n${file.content || ''}`).join('\n') : resolved.text, resolved.source.url);
  if (resolved.files.some(file => file.encoding === 'base64')) resolved.warnings.push('二进制附件已保存原始字节，未扫描其内部行为，也不会执行。');
  if (resolved.files.some(file => file.path.startsWith('scripts/'))) resolved.warnings.push('脚本仅作为资源保存；当前不会安装依赖或执行脚本。');
  risk.flags.push(...resolved.warnings);
  if (risk.level === 'low') risk.level = 'medium';
  candidate.package!.manifest.riskLevel = risk.level;
  candidate.package!.riskNotes = risk.flags;
  if (Buffer.byteLength(JSON.stringify(candidate)) > 1_800_000) throw new Error('导入包超过可保存大小，请选择更小的 Skill 目录。');
  return { status: 'ready' as const, source: resolved.source, candidate, risk, warnings: resolved.warnings, preview: resolved.text.slice(0, 6000), ...safety(resolved.source.url, risk.commands, risk.envVars) };
}
