/**
 * Shared Playwright Browser Pool
 * All browser-based tools share one Chromium instance.
 */
import { chromium, type Browser } from 'playwright';
import { createPublicBrowserContext } from './browser-network.js';

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

export async function getSharedBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!launching) {
    // Concurrent research agents share the same in-flight launch as well as the browser.
    launching = chromium.launch({
      headless: true,
      chromiumSandbox: true,
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    }).then(instance => { browser = instance; return instance; }).finally(() => { launching = null; });
  }
  return launching;
}

export async function newBrowserPage(allowedDomains?: string[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const b = await getSharedBrowser();
  const ctx = await createPublicBrowserContext(b, allowedDomains, signal);
  try {
    signal?.throwIfAborted();
    const page = await ctx.newPage();
    return { ctx, page };
  } catch (error) { await ctx.close().catch(() => {}); throw error; }
}

export async function closeSharedBrowser(): Promise<void> {
  if (launching) await launching.catch(() => {});
  const current = browser;
  browser = null;
  if (current) await current.close();
}
