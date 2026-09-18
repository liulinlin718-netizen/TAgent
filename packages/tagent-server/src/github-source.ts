import { createHash } from 'node:crypto';
import { publicFetch, PublicNetworkError } from '@tagent/core';
import { githubClient } from './github-client.js';

const MAX_FILE = 120_000;
const shaPattern = /^[a-f0-9]{40}$/;
const encodedPath = (value: string) => value.split('/').map(encodeURIComponent).join('/');
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('远程内容格式无效。');
  return value as Record<string, unknown>;
};
const textValue = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export function validSkillFilePath(value: string): boolean {
  // Control bytes are intentionally forbidden in imported paths.
  // eslint-disable-next-line no-control-regex
  return value.length > 0 && !/[\\\x00-\x1f:]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export interface TreeEntry { path: string; type: string; mode: string; sha: string; size?: number }
export interface GitSource { owner: string; repo: string; ref: string; commit: string; tree: string; path: string; blob: boolean }

export async function githubJson(route: string, signal: AbortSignal, optional = false): Promise<unknown> {
  const response = await githubClient.get(route, { signal, allowMissing: optional });
  return response.status === 200 ? response.data : null;
}

export async function importFetch(url: string, options: Parameters<typeof publicFetch>[1]): Promise<Response> {
  try { return await publicFetch(url, options); }
  catch (error) {
    if (error instanceof PublicNetworkError) throw error;
    let current: unknown = error;
    const codes: string[] = [];
    for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
      const code = (current as Error & { code?: unknown }).code;
      if (typeof code === 'string' && /^[A-Z_0-9]+$/.test(code)) codes.push(code);
      current = current.cause;
    }
    throw new Error(`${new URL(url).hostname} 网络连接失败${codes.length ? `（${codes.join(', ')}）` : ''}。请检查网络、代理或稍后重试。`);
  }
}

export async function resolveGithub(url: URL, signal: AbortSignal): Promise<GitSource> {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [owner, rawRepo, kind, ...tail] = parts;
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)
      || (kind && !['tree', 'blob'].includes(kind))) throw new Error('请提供 GitHub 仓库、目录或文件链接。');
  if (tail.length > 16 || (kind && !tail.length)) throw new Error('GitHub 路径无效或过深，请粘贴具体 Skill 目录链接。');
  const prefix = `/repos/${owner}/${repo}`;
  const candidates = kind
    ? shaPattern.test(tail[0]) ? [1] : Array.from({ length: tail.length - (kind === 'blob' ? 1 : 0) }, (_, index) => tail.length - (kind === 'blob' ? 1 : 0) - index)
    : [0];
  // Resolve the longest real ref first, including branch names containing '/'.
  for (const length of candidates) {
    const ref = length ? tail.slice(0, length).join('/') : 'HEAD';
    const commitValue = await githubJson(`${prefix}/commits/${encodeURIComponent(ref)}`, signal, true);
    if (!commitValue) continue;
    const data = record(commitValue);
    const commit = textValue(data.sha);
    const tree = textValue(record(record(data.commit).tree).sha);
    const filePath = tail.slice(length).join('/');
    if (!shaPattern.test(commit) || !shaPattern.test(tree) || (filePath && !validSkillFilePath(filePath))) throw new Error('GitHub 版本或路径无效。');
    return { owner, repo, ref, commit, tree, path: filePath, blob: kind === 'blob' };
  }
  throw new Error('找不到链接指定的 GitHub 版本，请检查分支或提交链接。');
}

export async function readTree(source: GitSource, tree: string, signal: AbortSignal, recursive = false): Promise<TreeEntry[]> {
  const data = record(await githubJson(`/repos/${source.owner}/${source.repo}/git/trees/${tree}${recursive ? '?recursive=1' : ''}`, signal));
  if (data.truncated) throw new Error('仓库目录过大，GitHub 返回了不完整文件列表。请粘贴具体 Skill 子目录链接。');
  if (!Array.isArray(data.tree)) throw new Error('GitHub 未返回文件列表。');
  return data.tree.map(value => {
    const item = record(value);
    if (typeof item.path !== 'string' || !validSkillFilePath(item.path) || !shaPattern.test(String(item.sha))) throw new Error('GitHub 文件列表包含无效路径或版本。');
    return { path: item.path, type: String(item.type), mode: String(item.mode), sha: String(item.sha), size: typeof item.size === 'number' ? item.size : undefined };
  });
}

export function fileUrl(source: GitSource, path: string) {
  return `https://github.com/${source.owner}/${source.repo}/blob/${source.commit}/${encodedPath(path)}`;
}

export async function fileBytes(source: GitSource, entry: TreeEntry, signal: AbortSignal, root = ''): Promise<Buffer> {
  const filePath = [root, entry.path].filter(Boolean).join('/');
  let bytes: Buffer;
  try {
    const response = await importFetch(`https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.commit}/${encodedPath(filePath)}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), maxBytes: MAX_FILE });
    if (!response.ok) throw new Error(`无法读取 ${filePath}（HTTP ${response.status}），未生成占位内容。`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof PublicNetworkError || signal.aborted) throw error;
    const data = record(await githubJson(`/repos/${source.owner}/${source.repo}/git/blobs/${entry.sha}`, signal));
    if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new Error(`无法读取文件：${filePath}`);
    bytes = Buffer.from(data.content.replace(/\s/g, ''), 'base64');
  }
  if (bytes.length > MAX_FILE) throw new Error(`文件超过 120 KB：${entry.path}`);
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (sha !== entry.sha || (entry.size !== undefined && entry.size !== bytes.length)) throw new Error(`文件版本校验失败：${entry.path}`);
  return bytes;
}
