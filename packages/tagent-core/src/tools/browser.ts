/**
 * Browser Agent — Snapshot + Refs 交互式浏览器 (plan ref-agent-browser)
 *
 * AI 可以像人一样操作浏览器：导航 → 观察 Snapshot → 点击 → 输入 → 滚动
 *
 * Snapshot 返回正文摘要及已观察到的元素引用，不传完整 DOM。
 *
 * 工具列表：
 *   browser_navigate(url)   — 导航到页面，返回 Snapshot
 *   browser_click(ref)      — 点击 @eN 元素
 *   browser_type(ref, text) — 在 @eN 输入框中输入文字
 *   browser_snapshot()      — 获取当前页面 Snapshot（不导航）
 *   browser_scroll(dir)     — 滚动页面
 *
 * 安全：URL 白名单/黑名单，治理引擎配合
 */

import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { ToolExecutor } from './registry.js';
import { assertPublicUrl } from '../public-network.js';
import { createPublicBrowserContext } from './browser-network.js';
import { invalidateBrowserSnapshot, takeBrowserSnapshot as takeSnapshot, resolveBrowserReference } from './browser-snapshot.js';
import { getSharedBrowser, closeSharedBrowser } from './browser-pool.js';

// ─── Browser Session Pool ─────────────────────────────

const activePages = new Map<string, Page>(); // execution session -> Page
const pagePolicies = new Map<string, string>();
const pendingPages = new Map<string, Promise<Page>>();

async function getPage(agentId: string, allowedDomains?: string[] | null, signal?: AbortSignal): Promise<Page> {
  signal?.throwIfAborted();
  const pending = pendingPages.get(agentId);
  if (pending) await pending;
  let page = activePages.get(agentId);
  const policy = JSON.stringify(allowedDomains || []);
  if (page && allowedDomains !== undefined && pagePolicies.get(agentId) !== policy) {
    await page.context().close();
    activePages.delete(agentId);
    page = undefined;
  }
  if (!page || page.isClosed()) {
    const creating = (async () => {
      const browser = await getSharedBrowser();
      const context = await createPublicBrowserContext(browser, allowedDomains || undefined, signal);
      try {
        const created = await context.newPage();
        activePages.set(agentId, created);
        pagePolicies.set(agentId, policy);
        return created;
      } catch (error) { await context.close().catch(() => {}); throw error; }
    })();
    pendingPages.set(agentId, creating);
    try { page = await creating; } finally { pendingPages.delete(agentId); }
  }
  return page;
}

// ─── Domain Security ──────────────────────────────────

function checkDomain(url: string, allowedDomains?: string[]): { ok: boolean; reason?: string } {
  try {
    assertPublicUrl(url, allowedDomains);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : '无效地址' };
  }
}

function observedPage(sessionId: string): Page {
  const page = activePages.get(sessionId);
  if (!page || page.isClosed()) throw new Error('浏览器未打开任何页面，请先使用 browser_navigate。');
  return page;
}

// ─── Tool Factories ───────────────────────────────────

let currentAgentId = 'browser-agent';

/** @deprecated Use createBrowserToolSession for task-owned browser lifetimes. */
export function setBrowserAgentId(agentId: string): void {
  currentAgentId = agentId;
}

export interface BrowserToolOptions { sessionId?: string; allowedDomains?: string[]; signal?: AbortSignal }

export function createBrowserToolSession(options: { allowedDomains?: string[]; signal?: AbortSignal } = {}) {
  const settings = { sessionId: randomUUID(), allowedDomains: [...(options.allowedDomains || [])], signal: options.signal };
  let closed = false;
  let sequence: Promise<unknown> = Promise.resolve();
  const tools = [createBrowserNavigateTool(settings), createBrowserClickTool(settings), createBrowserTypeTool(settings),
    createBrowserSnapshotTool(settings), createBrowserScrollTool(settings)].map(tool => ({
    ...tool,
    execute: (args: Record<string, unknown>) => {
      const request = { ...args };
      const result = sequence.then(() => {
        options.signal?.throwIfAborted();
        return closed ? '浏览器任务已结束，不能继续操作。' : tool.execute(request);
      });
      sequence = result.catch(() => {});
      return result;
    },
  }));
  return {
    tools,
    async close() {
      closed = true;
      await closeBrowserSession(settings.sessionId);
      await sequence;
    },
  };
}

export function createBrowserNavigateTool(options?: BrowserToolOptions): ToolExecutor {
  const sessionId = options?.sessionId || currentAgentId;
  const allowedDomains = options?.allowedDomains ? [...options.allowedDomains] : undefined;
  return {
    definition: {
      name: 'browser_navigate',
      description: '用浏览器打开一个 URL，返回当前主文档的结构、正文摘要和最多30个可交互元素（标记为 @e1, @e2...）。只使用返回的编号；需要更多元素时滚动并刷新快照。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的网页 URL' },
        },
        required: ['url'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const url = args.url as string;
      const check = checkDomain(url, allowedDomains);
      if (!check.ok) return `🛡️ 浏览器导航被拦截: ${check.reason}`;

      try {
        const page = await getPage(sessionId, allowedDomains || null, options?.signal);
        await invalidateBrowserSnapshot(page);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        return await takeSnapshot(page);
      } catch (err) {
        return `浏览器导航失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createBrowserClickTool(options?: BrowserToolOptions): ToolExecutor {
  const sessionId = options?.sessionId || currentAgentId;
  return {
    definition: {
      name: 'browser_click',
      description: '点击页面上的可交互元素。参数 ref 是 Snapshot 中的元素编号，如 @e1, @e2。点击后自动返回新的 Snapshot。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '元素引用编号，如 @e1, @e2' },
        },
        required: ['ref'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      let clicked = false;
      try {
        const page = observedPage(sessionId);
        const target = await resolveBrowserReference(page, args.ref, 'click');
        await target.element.click({ trial: true, timeout: 5000 });
        // A control may change meaning while Playwright waits for an overlay or animation.
        await resolveBrowserReference(page, args.ref, 'click');
        await target.element.click({ timeout: 1000 });
        clicked = true;
        const snapshot = await takeSnapshot(page);
        return `已点击 ${args.ref} ${JSON.stringify(target.description.name)}\n\n${snapshot}`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return clicked
          ? `点击已执行，但更新快照失败：${reason}。请先获取 browser_snapshot 核对，不要重复点击。`
          : `未能完成或确认点击：${reason}。请先获取 browser_snapshot 核对，不要盲目重复操作。`;
      }
    },
  };
}

export function createBrowserTypeTool(options?: BrowserToolOptions): ToolExecutor {
  const sessionId = options?.sessionId || currentAgentId;
  return {
    definition: {
      name: 'browser_type',
      description: '在输入框中输入文字。ref 是 Snapshot 中的 textbox 元素编号（如 @e3），text 是要输入的内容。输入后自动返回新 Snapshot。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '输入框元素引用，如 @e3' },
          text: { type: 'string', description: '要输入的文字' },
        },
        required: ['ref', 'text'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      if (typeof args.text !== 'string') return '输入内容必须是字符串；未输入任何内容。';
      let filled = false;
      try {
        const page = observedPage(sessionId);
        const target = await resolveBrowserReference(page, args.ref, 'type');
        await target.element.fill(args.text, { timeout: 5000 });
        filled = true;
        return `已在 ${args.ref} 中输入文字。\n\n${await takeSnapshot(page)}`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return filled
          ? `输入已执行，但更新快照失败：${reason}。请先获取 browser_snapshot 核对，不要重复输入。`
          : `未能完成或确认输入：${reason}。请先获取 browser_snapshot 核对。`;
      }
    },
  };
}

export function createBrowserSnapshotTool(options?: BrowserToolOptions): ToolExecutor {
  const sessionId = options?.sessionId || currentAgentId;
  return {
    definition: {
      name: 'browser_snapshot',
      description: '获取当前浏览器页面的最新快照（Snapshot），反映页面当前状态。在不导航的情况下刷新页面视图。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    async execute(): Promise<string> {
      try {
        const page = activePages.get(sessionId);
        if (!page || page.isClosed()) return '浏览器未打开任何页面。请先用 browser_navigate 打开一个 URL。';
        return await takeSnapshot(page);
      } catch (err) {
        return `获取快照失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createBrowserScrollTool(options?: BrowserToolOptions): ToolExecutor {
  const sessionId = options?.sessionId || currentAgentId;
  return {
    definition: {
      name: 'browser_scroll',
      description: '滚动当前页面。direction: "down" 向下、"up" 向上、"bottom" 滚动到底部。滚动后自动返回新 Snapshot。',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', description: '滚动方向: down | up | bottom' },
        },
        required: ['direction'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const dir = args.direction || 'down';
      if (!['down', 'up', 'bottom'].includes(String(dir))) return '滚动方向必须为 down、up 或 bottom。';
      try {
        const page = observedPage(sessionId);
        if (dir === 'bottom') {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        } else if (dir === 'up') {
          await page.evaluate(() => window.scrollBy(0, -500));
        } else {
          await page.evaluate(() => window.scrollBy(0, 500));
        }
        return await takeSnapshot(page);
      } catch (err) {
        return `滚动失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ─── Cleanup ─────────────────────────────────────────

async function closeBrowserSession(sessionId: string): Promise<void> {
  await pendingPages.get(sessionId)?.catch(() => {});
  const page = activePages.get(sessionId);
  activePages.delete(sessionId);
  pagePolicies.delete(sessionId);
  if (page) await invalidateBrowserSnapshot(page);
  await page?.context().close().catch(() => {});
}

export async function closeBrowser(): Promise<void> {
  for (const sessionId of new Set([...activePages.keys(), ...pendingPages.keys()])) await closeBrowserSession(sessionId);
  await closeSharedBrowser();
}
