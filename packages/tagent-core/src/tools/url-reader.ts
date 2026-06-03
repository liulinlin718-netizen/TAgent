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

import type { ToolExecutor } from './registry.js';

// ─── Domain Security (D12) ───────────────────────────

/** 内网/私有地址黑名单 — 始终拦截 */
const BLOCKED_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\.0\.0\.0$/,
  /^\[::1\]$/,
  /\.internal$/i,
  /\.local$/i,
  /\.corp$/i,
];

function isDomainAllowed(url: string, allowedDomains?: string[]): { allowed: boolean; reason?: string } {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { allowed: false, reason: `无效的 URL: ${url}` };
  }

  // 1. 黑名单检查 — 始终拦截私有地址
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(hostname)) {
      return { allowed: false, reason: `安全拦截: "${hostname}" 为内部/私有地址` };
    }
  }

  // 2. 白名单检查 — 如果配置了白名单，仅允许白名单域名
  if (allowedDomains && allowedDomains.length > 0) {
    const isWhitelisted = allowedDomains.some(domain => {
      if (domain.startsWith('.')) {
        // 通配符: .example.com 匹配 sub.example.com
        return hostname.endsWith(domain) || hostname === domain.slice(1);
      }
      return hostname === domain;
    });
    if (!isWhitelisted) {
      return { allowed: false, reason: `域名 "${hostname}" 不在白名单中。允许的域名: ${allowedDomains.join(', ')}` };
    }
  }

  return { allowed: true };
}

export function createUrlReaderTool(options?: { allowedDomains?: string[] }): ToolExecutor {
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

    async execute(args: Record<string, unknown>): Promise<string> {
      const url = args.url as string;
      const maxLength = (args.maxLength as number) || 5000;

      // D12: 域名安全检查
      const domainCheck = isDomainAllowed(url, allowedDomains);
      if (!domainCheck.allowed) {
        return `🛡️ URL 访问被治理引擎拦截: ${domainCheck.reason}`;
      }

      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'TAgent/0.1 (Research Assistant)',
            'Accept': 'text/html,application/xhtml+xml,text/plain',
          },
          signal: AbortSignal.timeout(10000), // 10s timeout
        });

        if (!response.ok) {
          return `无法读取 URL (HTTP ${response.status}): ${url}`;
        }

        const contentType = response.headers.get('content-type') || '';
        const html = await response.text();

        // Convert HTML to plain text (basic)
        let text = htmlToText(html);

        // Truncate
        if (text.length > maxLength) {
          text = text.slice(0, maxLength) + '\n\n[...内容已截断，共 ' + text.length + ' 字符]';
        }

        return `## 网页内容: ${url}\n\n${text}`;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `读取 URL 失败: ${msg}`;
      }
    },
  };
}

function htmlToText(html: string): string {
  let text = html;

  // Remove scripts and styles
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');

  // Convert common elements
  text = text.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n## $1\n');
  text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, '\n$1\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)');

  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Clean up whitespace
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}
