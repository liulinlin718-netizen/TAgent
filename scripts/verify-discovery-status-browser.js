// Deterministic status UI checks; live provider/import evidence is verified separately.
// Run after fixtures/mcp-management-browser.js, against its isolated backend only.
async (page) => {
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('mcpFixture'));
  if (!base || /:(3000|3001)$/.test(base)) throw new Error('Isolated backend required');
  const steps = { skill: 0, mcp: 0 };
  const widths = [1440, 1024, 768, 390, 320];
  const writes = [];
  const watch = request => {
    if (request.method() !== 'GET' && /\/api\/(skills|mcp)(?:\/|$)/.test(request.url())) writes.push(request.url());
  };
  page.on('request', watch);
  await page.route('**/api/discovery/search', async route => {
    const { domain, query } = route.request().postDataJSON();
    const limited = steps[domain]++ > 0;
    const status = { id: 'github-repo', name: 'GitHub repositories', kind: 'github-repo', domains: [domain],
      requiresNetwork: true, supportsImportPreview: true, state: limited ? 'failed' : 'ok',
      cache: limited ? undefined : 'memory', lastCheckedAt: Date.now() - 20000,
      errorCode: limited ? 'rate_limit' : undefined, retryAt: limited ? Date.now() + 120000 : undefined,
      lastError: limited ? 'GitHub 已限流，请在提示时间后重试。' : undefined };
    await route.fulfill({ json: { query, domain, candidates: [{ name: 'Discovery fixture', providerId: 'curated', source: 'curated',
      url: 'https://github.com/anthropics/skills', description: 'Browser acceptance fixture' }],
      providerStatuses: [status, { ...status, id: 'curated', name: 'Curated sources', kind: 'curated', requiresNetwork: false,
        state: 'ok', cache: undefined, lastError: undefined, retryAt: undefined, errorCode: undefined }],
      providers: { 'github-repo': status.state, curated: 'ok' }, errors: limited ? [status.lastError] : [], note: '验收样例：未保存、未执行。' } });
  });
  try {
    for (const domain of ['skill', 'mcp']) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`http://127.0.0.1:3000/management/${domain === 'skill' ? 'skills' : 'mcp'}?mcpFixture=${encodeURIComponent(base)}`);
      const input = page.getByPlaceholder(domain === 'skill' ? '输入关键词，例如 last30days agent research' : '搜索 MCP，例如 filesystem、github、browser');
      await input.fill('fixture');
      await page.getByRole('button', { name: '搜索候选', exact: true }).click();
      await page.getByText('GitHub repositories: 缓存结果', { exact: true }).waitFor();
      if (await page.getByRole('button', { name: '关闭编辑器', exact: true }).count()) throw new Error('Search opened an editor');
      await page.getByRole('button', { name: '填入来源', exact: true }).click();
      const source = domain === 'skill' ? page.getByRole('textbox', { name: 'Skill 导入链接' }) : page.getByPlaceholder('输入 GitHub URL、普通 URL 或 npm 包名');
      if (await source.inputValue() !== 'https://github.com/anthropics/skills') throw new Error('Source was not filled');
      if (await page.getByRole('button', { name: '关闭编辑器', exact: true }).count()) throw new Error('Filling source created a draft');
      await page.getByRole('button', { name: '搜索候选', exact: true }).click();
      await page.getByText(/GitHub repositories: 已限流/).waitFor();
      if (await page.getByText('GitHub repositories: 缓存结果', { exact: true }).count()) throw new Error('Stale success status remained');
      for (const width of widths) {
        await page.setViewportSize({ width, height: 1000 });
        for (const control of [input, source, page.getByRole('button', { name: '搜索候选', exact: true })]) {
          await control.scrollIntoViewIfNeeded();
          const clipped = await control.evaluate(element => {
            const rect = element.getBoundingClientRect();
            const main = element.closest('main')?.getBoundingClientRect();
            return !main || rect.width < 80 || rect.left < main.left - 1 || rect.right > main.right + 1 || rect.right > innerWidth + 1;
          });
          if (clipped) throw new Error(`${domain}: search/import control clipped at ${width}`);
        }
        const statusBar = page.locator('[class*="providerStatusBar"]');
        await statusBar.scrollIntoViewIfNeeded();
        const overflow = await statusBar.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return [...element.children].some(child => { const childRect = child.getBoundingClientRect(); return childRect.left < rect.left - 1 || childRect.right > rect.right + 1; });
        });
        if (overflow || await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error(`${domain}: overflow at ${width}`);
        await page.screenshot({ path: `output/playwright/discovery-${domain}-status-${width}.png` });
      }
    }
    if (writes.length) throw new Error('Discovery wrote configuration or requested an import');
    return { status: 'passed', responseMode: 'explicit-ui-fixture', pages: ['skills', 'mcp'], cacheAndLimitLabels: true,
      searchOpensEditor: false, fillSourceCreatesDraft: false, importOrSaveRequests: writes.length, widths };
  } finally {
    page.off('request', watch);
    await page.unroute('**/api/discovery/search');
  }
}
