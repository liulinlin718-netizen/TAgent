/**
 * URL Reader Tool — 读取网页内容 (plan §3.10 安全协议)
 *
 * 获取网页内容并转换为纯文本。
 * 配合 web_search 使用：先搜索 → 找到 URL → 读取详情。
 *
 * 安全特性 (D12):
 * - 域名黑名单: 阻止访问内网/私有 IP
 * - 可配置白名单: 仅允许访问指定域名
 */

import type { ToolExecutor, ToolExecutionContext } from './registry.js';
import { requestSignal } from '../run-control.js';
import { assertPublicUrl, publicFetch } from '../public-network.js';
import { evidencePassages, extractPageEvidence, formatSourceReferences, makeResearchSource, normalizeSourceUrl, sourceRelevance, type ResearchSource } from '../research-evidence.js';
import { getResearchDateContext, isReadableMaterial } from './web-research.js';

// ─── Domain Security (D12) ───────────────────────────

/** 内网/私有地址黑名单 — 始终拦截 */
function isDomainAllowed(url: string, allowedDomains?: string[]): { allowed: boolean; reason?: string } {
  try {
    assertPublicUrl(url, allowedDomains);
    return { allowed: true };
  } catch (error) {
    return { allowed: false, reason: error instanceof Error ? error.message : '无效地址' };
  }
}

export function createUrlReaderTool(options?: { allowedDomains?: string[]; topic?: string; onSources?: (sources: ResearchSource[]) => void }): ToolExecutor {
  const allowedDomains = options?.allowedDomains;
  return {
    definition: {
      name: 'read_url',
      description: '读取指定 URL 的网页内容，提取纯文本。适合深入阅读搜索结果中的文章。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要读取的网页 URL',
          },
          maxLength: {
            type: 'number',
            description: '最大返回字符数（默认 5000）',
          },
        },
        required: ['url'],
      },
    },

    async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
      context?.signal?.throwIfAborted();
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      const size = Number(args.maxLength);
      const maxLength = Number.isFinite(size) && size > 0 ? Math.min(15000, Math.max(500, Math.floor(size))) : 5000;

      // D12: 域名安全检查
      const domainCheck = isDomainAllowed(url, allowedDomains);
      if (!domainCheck.allowed) {
        return `🛡️ URL 访问被治理引擎拦截: ${domainCheck.reason}`;
      }

      try {
        const response = await publicFetch(url, {
          headers: { 'User-Agent': 'TAgent/0.1 (Research Assistant)', Accept: 'text/html,application/xhtml+xml,text/plain' },
          signal: requestSignal(10000, context?.signal), allowedDomains,
        });
        const target = normalizeSourceUrl(response.url);

        if (!response.ok) {
          return `无法读取 URL (HTTP ${response.status}): ${url}`;
        }

        const contentType = response.headers.get('content-type') || '';
        if (!/text\/|html/i.test(contentType)) {
          await response.body?.cancel();
          return `暂不支持读取此内容类型: ${contentType || 'unknown'}`;
        }
        const html = Buffer.from(await response.arrayBuffer());
        const page = extractPageEvidence(html, target, contentType);
        const source = makeResearchSource({
          url: target, title: page.title || target, query: options?.topic || '',
          retrievedAt: getResearchDateContext().isoDate, publication: page.publication,
          readable: isReadableMaterial({ text: page.text }),
          relevant: options?.topic ? sourceRelevance(options.topic, page.text) >= 0.6 : true,
          excerpt: page.text.slice(0, 2400),
          references: page.references,
          passages: evidencePassages(page.text, options?.topic),
          requestedUrls: [normalizeSourceUrl(url)],
        });
        options?.onSources?.([source]);
        if (!source.readable) return `未读取到可用正文（可能是验证页面或正文过短）: ${target}`;
        let text = page.text;

        // Truncate
        if (text.length > maxLength) {
          text = text.slice(0, maxLength) + '\n\n[...内容已截断，共 ' + text.length + ' 字符]';
        }

        const date = source.publication.basis === 'publication_metadata' ? `${source.publication.date}（发布元数据）` : '未核实，仅可作背景';
        return `## 网页内容: ${page.title || target}\n- URL: ${target}\n- 读取日期: ${source.retrievedAt}\n- 发布日期: ${date}\n- 发布者: ${source.publisher === 'primary' ? '已识别发布方域名' : '身份未核实'}\n\n${text}${formatSourceReferences(source.references)}`;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `读取 URL 失败: ${msg}`;
      }
    },
  };
}
