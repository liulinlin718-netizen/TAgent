/**
 * URL Reader Tool — 读取网页内容
 *
 * 获取网页内容并转换为纯文本。
 * 配合 web_search 使用：先搜索 → 找到 URL → 读取详情。
 */

import type { ToolExecutor } from './registry.js';

export function createUrlReaderTool(): ToolExecutor {
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
