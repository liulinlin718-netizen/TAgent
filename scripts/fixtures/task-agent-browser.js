// Bootstrap a fresh CLI browser at about:blank?taskFixture=<isolated backend base>.
async (page) => {
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('taskFixture'));
  const workflow = await page.evaluate(() => new URL(location.href).searchParams.has('workflow'));
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || /:(3000|3001)$/.test(base)) throw new Error('Isolated fixture required');
  await page.addInitScript(fixture => {
    const native = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      return url.pathname.startsWith('/api/') ? native(fixture + url.pathname + url.search, { ...init, credentials: 'omit' }) : native(input, init);
    };
  }, base);
  await page.route('**/api/**', route => {
    const url = route.request().url();
    if (/^http:\/\/(localhost|127\.0\.0\.1):3001\//.test(url)) return route.abort('blockedbyclient');
    return route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`http://127.0.0.1:3000${workflow ? '/' : '/management/agents'}?taskFixture=${encodeURIComponent(base)}${workflow ? `&workflowFixture=${encodeURIComponent(base)}&taskAgents=1` : ''}`);
  return { base, title: await page.title() };
}
