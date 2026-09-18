import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { newBrowserPage, closeSharedBrowser } from '../packages/tagent-core/src/tools/browser-pool.js';
import { publicFetch } from '../packages/tagent-core/src/public-network.js';
import { resolvedPageUrl } from '../packages/tagent-core/src/tools/browser-network.js';

async function main() {
  let privateRequests = 0;
  let upgrades = 0;
  const server = createServer((_req, res) => { privateRequests++; res.setHeader('Access-Control-Allow-Origin', '*'); res.end('PRIVATE'); });
  server.on('upgrade', (_req, socket) => { upgrades++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const privateUrl = `http://127.0.0.1:${port}`;
  const fixture = 'http://network-acceptance.example';
  const realFetch = globalThis.fetch;
  // Only the public page is a fixture; private endpoints are real HTTP/WS listeners.
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === `${fixture}/redirect`) return new Response(null, { status: 302, headers: { location: privateUrl } });
    if (url === `${fixture}/public-redirect`) return new Response(null, { status: 302, headers: { location: '/final/article' } });
    if (url === `${fixture}/final/article`) return new Response('<h1>Public article</h1><a href="details">Details</a>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.startsWith(fixture)) return new Response('<h1>Network acceptance</h1>', { headers: { 'content-type': 'text/html' } });
    return realFetch(input, init);
  };
  try {
    const { ctx, page } = await newBrowserPage();
    try {
      await page.goto(fixture, { waitUntil: 'domcontentloaded' });
      assert.equal(await page.locator('h1').textContent(), 'Network acceptance');
      const outcomes = await page.evaluate(async ({ privateUrl, fixture, port }) => {
        const urls = [privateUrl, privateUrl.replace('127.0.0.1', '2130706433'), `${fixture}/redirect`];
        const fetches = await Promise.all(urls.map(url => fetch(url, { method: 'POST', body: 'test' }).then(() => 'allowed', () => 'blocked')));
        const frame = document.createElement('iframe');
        frame.src = privateUrl; document.body.append(frame);
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        const ws = await new Promise<string>(resolve => {
          const timer = setTimeout(() => { socket.close(); resolve('timeout'); }, 3000);
          socket.onopen = () => { clearTimeout(timer); socket.close(); resolve('allowed'); };
          socket.onerror = socket.onclose = () => { clearTimeout(timer); resolve('blocked'); };
        });
        return { fetches, ws };
      }, { privateUrl, fixture, port });
      assert.deepEqual(outcomes.fetches, ['blocked', 'blocked', 'blocked']);
      assert.equal(outcomes.ws, 'blocked');
      const deniedPage = await ctx.newPage();
      try { await assert.rejects(deniedPage.goto(privateUrl, { timeout: 3000 })); }
      finally { await deniedPage.close(); }
      await page.goto(`${fixture}/public-redirect`, { waitUntil: 'domcontentloaded' });
      assert.equal(resolvedPageUrl(page), `${fixture}/final/article`);
      assert.equal(await page.locator('a').getAttribute('href'), 'details');
      assert.equal(await page.locator('a').evaluate(element => (element as HTMLAnchorElement).href), `${fixture}/final/details`);
      assert.equal(privateRequests, 0);
      assert.equal(upgrades, 0);
      console.log('PASS: real Chromium blocks private navigation, frame, fetch, redirects and WebSockets; public fixture and final URL remain readable');
    } finally { await ctx.close(); }
    globalThis.fetch = realFetch;
    if (process.argv.includes('--live')) {
      for (const url of ['https://api.github.com/repos/modelcontextprotocol/servers', 'https://registry.npmjs.org/ipaddr.js/latest']) {
        const response = await publicFetch(url, { headers: { 'User-Agent': 'TAgent Network Acceptance' }, signal: AbortSignal.timeout(12000) });
        assert.ok(response.ok, `${new URL(url).host}: HTTP ${response.status}`);
        const result = await response.json();
        assert.ok(result.name);
        console.log(`PASS: public HTTPS ${new URL(url).host}`);
      }
      const { ctx, page } = await newBrowserPage();
      try {
        await page.goto('https://www.bing.com/news/search?q=AI+agent', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForSelector('a.title[data-author]', { timeout: 8000 }).catch(async () => {
          const directory = resolve('output/playwright');
          await mkdir(directory, { recursive: true });
          await writeFile(resolve(directory, 'network-bing.html'), await page.content(), 'utf8');
          await page.screenshot({ path: resolve(directory, 'network-bing.png') });
          console.error(`News page: ${resolvedPageUrl(page)}; title: ${await page.title()}`);
        });
        assert.ok(await page.locator('a.title[data-author]').count() > 0, 'Expected real news candidates');
        console.log('PASS: real Bing news browser search through guarded transport');
      } finally { await ctx.close(); }
    }
  } finally {
    globalThis.fetch = realFetch;
    await closeSharedBrowser();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
