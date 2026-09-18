import { fromMarkdown } from 'mdast-util-from-markdown';
import { getNodeValue, parseTree, type Node, type ParseError } from 'jsonc-parser';
import { load } from 'cheerio';
import { isMCPRecord } from '@tagent/core';

export interface MCPDocumentEntry { name: string; value: Record<string, unknown> }

function parseJSON(text: string): unknown {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (!tree || errors.length) throw new Error('MCP JSON 配置格式无效。');
  let count = 0;
  function inspect(node: Node, depth: number) {
    if (++count > 12000 || depth > 32) throw new Error('MCP 配置结构过大或过深。');
    if (node.type === 'object') {
      const keys = node.children?.map(property => property.children?.[0].value) || [];
      if (new Set(keys).size !== keys.length) throw new Error('MCP JSON 中存在重复字段，请先消除歧义。');
    }
    for (const child of node.children || []) inspect(child, depth + 1);
  }
  inspect(tree, 0);
  return getNodeValue(tree);
}

function entries(value: unknown, fallback: string): MCPDocumentEntry[] {
  if (!isMCPRecord(value)) return [];
  if (isMCPRecord(value.server)) return entries(value.server, fallback);
  if (Array.isArray(value.servers)) return value.servers.flatMap((item, index) => entries(item, `${fallback} ${index + 1}`));
  for (const key of ['mcpServers', 'servers']) if (isMCPRecord(value[key])) {
    return Object.entries(value[key]).filter((entry): entry is [string, Record<string, unknown>] => isMCPRecord(entry[1]))
      .map(([name, config]) => ({ name, value: config }));
  }
  if (isMCPRecord(value.mcp)) return entries(value.mcp, fallback);
  if (Array.isArray(value.packages) || Array.isArray(value.remotes) || typeof value.command === 'string'
      || typeof value.url === 'string' || typeof value.serverUrl === 'string' || typeof value.httpUrl === 'string'
      || (typeof value.name === 'string' && value.bin !== undefined)) {
    return [{ name: typeof value.name === 'string' ? value.name : fallback, value }];
  }
  return [];
}

/** Only parse explicit configuration blocks. Prose never becomes executable configuration. */
export function parseMCPDocument(text: string, contentType = '', fallback = 'MCP Server'): MCPDocumentEntry[] {
  if (Buffer.byteLength(text) > 120000) throw new Error('MCP 文档超过 120 KB，请粘贴具体配置文件链接。');
  if (/^\s*[{[]/.test(text)) return entries(parseJSON(text), fallback);
  const blocks: string[] = [];
  if (/html/i.test(contentType) || /^\s*<!doctype|^\s*<html/i.test(text)) {
    const $ = load(text);
    $('pre').each((_, element) => { blocks.push($(element).text()); });
  } else {
    const tree = fromMarkdown(text);
    function visit(node: typeof tree | typeof tree.children[number]) {
      if (node.type === 'code' && (!node.lang || /^(json|jsonc)$/i.test(node.lang))) blocks.push(node.value);
      if ('children' in node) for (const child of node.children) visit(child as typeof tree.children[number]);
    }
    visit(tree);
  }
  if (blocks.length > 64) throw new Error('配置示例过多，请选择具体配置文件。');
  const result: MCPDocumentEntry[] = [];
  for (const [index, block] of blocks.entries()) {
    if (!/^\s*[{[]/.test(block)) continue;
    try { result.push(...entries(parseJSON(block), `${fallback} / 示例 ${index + 1}`)); }
    catch (error) {
      if (/mcpServers|"servers"|"command"|"remotes"|"packages"/.test(block)) throw error;
    }
  }
  return result;
}
