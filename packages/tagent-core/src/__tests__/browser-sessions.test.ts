import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ context: vi.fn(), browser: vi.fn(), closeBrowser: vi.fn() }));
vi.mock('../tools/browser-pool.js', () => ({ getSharedBrowser: mocks.browser, closeSharedBrowser: mocks.closeBrowser }));
vi.mock('../tools/browser-network.js', () => ({ createPublicBrowserContext: mocks.context, resolvedPageUrl: (page: { url: () => string }) => page.url() }));
vi.mock('../tools/browser-snapshot.js', () => ({
  takeBrowserSnapshot: async (page: { url: () => string }) => page.url(),
  invalidateBrowserSnapshot: async () => {},
  resolveBrowserReference: vi.fn(),
}));
import { closeBrowser, createBrowserToolSession, setBrowserAgentId } from '../tools/browser.js';

function fixturePage() {
  let url = 'about:blank';
  let closed = false;
  const ctx = { close: vi.fn(async () => { closed = true; }), newPage: vi.fn() };
  const page = {
    goto: vi.fn(async (value: string) => { url = value; }),
    url: () => url,
    isClosed: () => closed,
    context: () => ctx,
    waitForLoadState: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({ title: url, headings: [], mainText: '', interactives: [], contentLength: 0 })),
  };
  ctx.newPage.mockResolvedValue(page);
  return { ctx, page };
}

beforeEach(() => { mocks.browser.mockResolvedValue({}); });
afterEach(async () => { await closeBrowser(); vi.clearAllMocks(); });
const tool = (session: ReturnType<typeof createBrowserToolSession>, name: string) => session.tools.find(item => item.definition.name === name)!;

describe('task-owned interactive browser sessions', () => {
  it('keeps concurrent navigation and snapshots in different pages even when the legacy agent ID changes', async () => {
    const a = fixturePage(), b = fixturePage();
    mocks.context.mockResolvedValueOnce(a.ctx).mockResolvedValueOnce(b.ctx);
    const first = createBrowserToolSession(), second = createBrowserToolSession();
    setBrowserAgentId('same-resident-agent');
    const outputs = await Promise.all([
      tool(first, 'browser_navigate').execute({ url: 'https://first.example/task' }),
      tool(second, 'browser_navigate').execute({ url: 'https://second.example/task' }),
    ]);
    expect(outputs[0]).toContain('first.example/task');
    expect(outputs[1]).toContain('second.example/task');
    setBrowserAgentId('another-agent');
    expect(await tool(first, 'browser_snapshot').execute({})).toContain('first.example/task');
    expect(await tool(second, 'browser_snapshot').execute({})).toContain('second.example/task');
    await first.close();
    expect(a.ctx.close).toHaveBeenCalledTimes(1);
    expect(b.ctx.close).not.toHaveBeenCalled();
    expect(await tool(first, 'browser_navigate').execute({ url: 'https://first.example/reopen' })).toContain('已结束');
    expect(await tool(second, 'browser_snapshot').execute({})).toContain('second.example/task');
    await second.close();
    expect(b.ctx.close).toHaveBeenCalledTimes(1);
  });

  it('freezes the domain policy and refuses forbidden navigation before opening a browser', async () => {
    const domains = ['allowed.example'];
    const session = createBrowserToolSession({ allowedDomains: domains });
    domains.push('forbidden.example');
    expect(await tool(session, 'browser_navigate').execute({ url: 'https://forbidden.example/' })).toContain('拦截');
    expect(mocks.context).not.toHaveBeenCalled();
    const page = fixturePage(); mocks.context.mockResolvedValueOnce(page.ctx);
    await tool(session, 'browser_navigate').execute({ url: 'https://allowed.example/' });
    expect(mocks.context.mock.calls[0][1]).toEqual(['allowed.example']);
    await session.close();
  });

  it('creates one context for overlapping calls in the same execution', async () => {
    const page = fixturePage(); mocks.context.mockResolvedValueOnce(page.ctx);
    const session = createBrowserToolSession();
    await Promise.all([1, 2].map(() => tool(session, 'browser_navigate').execute({ url: 'https://same.example/' })));
    expect(mocks.context).toHaveBeenCalledTimes(1);
    await session.close();
    await session.close();
    expect(page.ctx.close).toHaveBeenCalledTimes(1);
  });

  it('closes a context even when page creation or navigation fails', async () => {
    const page = fixturePage();
    page.ctx.newPage.mockRejectedValueOnce(new Error('Page creation failed'));
    mocks.context.mockResolvedValueOnce(page.ctx);
    const first = createBrowserToolSession();
    expect(await tool(first, 'browser_navigate').execute({ url: 'https://example.com/' })).toContain('失败');
    await first.close();
    expect(page.ctx.close).toHaveBeenCalledTimes(1);
    const next = fixturePage(); next.page.goto.mockRejectedValueOnce(new Error('Navigation failed'));
    mocks.context.mockResolvedValueOnce(next.ctx);
    const second = createBrowserToolSession();
    expect(await tool(second, 'browser_navigate').execute({ url: 'https://example.com/' })).toContain('失败');
    await second.close();
    expect(next.ctx.close).toHaveBeenCalledTimes(1);
  });

  it('awaits and closes a context still being created without reviving a closed session', async () => {
    const page = fixturePage();
    let resolveContext!: (value: typeof page.ctx) => void;
    mocks.context.mockImplementationOnce(() => new Promise(resolve => { resolveContext = resolve; }));
    const session = createBrowserToolSession();
    const navigation = tool(session, 'browser_navigate').execute({ url: 'https://example.com/' });
    await vi.waitFor(() => expect(resolveContext).toBeDefined());
    const closing = session.close();
    resolveContext(page.ctx);
    await Promise.all([navigation, closing]);
    expect(page.ctx.close).toHaveBeenCalledTimes(1);
    expect(await tool(session, 'browser_snapshot').execute({})).toContain('已结束');
  });
});
