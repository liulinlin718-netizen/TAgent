// Start a fresh CLI browser at about:blank?officeFixture=<verify-office-runtime.mjs --serve base>.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const base = await page.evaluate(() => {
    const value = new URL(location.href).searchParams.get('officeFixture');
    if (!value) return null;
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && !['3000', '3001'].includes(url.port) ? url.origin : null;
  });
  check(base, 'Only an isolated local fixture is allowed');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const errors = [], userRequests = [], blocked = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  page.on('request', request => { if (/^http:\/\/(localhost|127\.0\.0\.1):3001\/api\//.test(request.url())) userRequests.push(request.url()); });
  await page.route('**/*', route => {
    const request = route.request(), url = request.url();
    const allowed = url.startsWith(base + '/') || (url.startsWith('http://127.0.0.1:3000/')
      && !url.startsWith('http://127.0.0.1:3000/api/') && ['GET', 'HEAD'].includes(request.method()));
    if (!allowed) { blocked.push(request.url().split('?')[0]); return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(fixture => {
    const native = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const result = url.pathname.startsWith('/api/') ? native(fixture + url.pathname + url.search, { ...init, credentials: 'omit' }) : native(input, init);
      if (url.pathname === '/api/agent/orchestrate') {
        return result.then(response => {
          window.__officeAcceptanceStream = response.clone().text();
          return response;
        });
      }
      return result;
    };
  }, base);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`http://127.0.0.1:3000/?officeFixture=${encodeURIComponent(base)}`);
  let panel = page.getByTestId('delivery-review').first();
  const selectCase = async mode => {
    const loaded = page.waitForResponse(response => response.request().method() === 'GET'
      && response.url().startsWith(base + '/api/workspaces/') && /\/sessions\/[^/?]+$/.test(response.url()));
    await page.getByRole('button', { name: new RegExp(`^office-case-${mode}`) }).click();
    const detail = await (await loaded).json();
    check(detail.messages[0].content.startsWith(`office-case-${mode}：`), 'Loaded a different case');
    await page.locator('main').getByText(detail.messages[0].content, { exact: true }).and(page.locator('div')).waitFor();
    await panel.waitFor();
  };
  const labels = { 'rows-repair': '办公交付核对通过', pass: '办公交付核对通过', repair: '办公交付核对通过', failed: '办公交付未通过完整核对', 'cut-review': '办公交付尚未完成核对', malformed: '办公交付尚未完成核对' };
  for (const mode of Object.keys(labels)) {
    await selectCase(mode);
    check((await panel.locator(':scope > summary').innerText()).includes(labels[mode]), `Wrong visible status for ${mode}`);
    check(!await panel.evaluate(element => element.open), 'Review should default to collapsed');
    await panel.locator(':scope > summary').click();
    if (mode === 'cut-review' || mode === 'malformed') {
      const summary = await panel.locator(':scope > summary').innerText();
      check(summary.includes('暂无检查结果') && !summary.includes('0/0'), 'Empty review must not look like a score');
      check((await panel.innerText()).includes('核对覆盖 0/3 处内容'), 'Missing incomplete coverage');
    }
    if (mode === 'cut-review') {
      check((await panel.innerText()).includes('输出达到长度限制'), 'Truncation reason hidden');
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
        const reason = panel.locator(':scope > div > ul > li').first();
        await reason.scrollIntoViewIfNeeded();
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Incomplete status overflows');
        const reasonBox = await reason.boundingBox();
        const composerBox = await page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' }).boundingBox();
        check(reasonBox.y >= 0 && reasonBox.y + reasonBox.height < composerBox.y, 'Incomplete reason is hidden behind composer');
        await page.screenshot({ path: `output/playwright/office-incomplete-${width}.png`, animations: 'disabled' });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    if (mode === 'rows-repair') {
      const row = panel.locator('[data-review-status="passed"]').filter({ hasText: '表格 1 · 第 2 行' });
      check(await row.count() === 1, 'Expected one separately reviewed table row');
      await row.locator(':scope > summary').click();
      check((await row.innerText()).includes('| 人员配置未提供 | 不能据此判断项目无人负责 |'), 'Row quote missing');
      const history = panel.getByText('上一次核对与保留原稿', { exact: true });
      await history.click();
      check((await panel.innerText()).includes('表格 1 · 第 2 行：'), 'Rejected row label missing from retained original');
      check(await panel.getByRole('cell', { name: '项目无人负责', exact: true }).count() === 1, 'Original unsupported row must remain visible');
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
        await row.scrollIntoViewIfNeeded();
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Table review horizontal overflow');
        const bounds = await row.boundingBox();
        check(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'Row check is clipped');
        await page.screenshot({ path: `output/playwright/office-rows-${width}.png`, animations: 'disabled' });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await history.click();
    }
    if (mode === 'repair' || mode === 'failed') {
      await panel.getByText('上一次核对与保留原稿', { exact: true }).click();
      check((await panel.innerText()).includes('合计320万元'), 'Rejected original is missing');
      await panel.getByText('上一次核对与保留原稿', { exact: true }).click();
    }
    if (mode === 'failed') {
      const failed = panel.locator('[data-review-status="failed"]').first();
      check(await failed.count() === 1, 'Programmatic sum failure must be visible');
      await failed.locator(':scope > summary').click();
      check((await failed.innerText()).includes('310'), 'Expected recomputed result is absent');
      check((await failed.innerText()).includes('320'), 'Wrong claimed result is absent');
      await panel.locator(':scope > summary').scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'output/playwright/office-review-desktop.png', animations: 'disabled' });
    }
    if (mode === 'malformed') check((await panel.innerText()).includes('核对 JSON 无效'), 'Malformed response has no readable explanation');
  }
  // Exercise the real browser SSE path against the local simulated model, not a canned fetch response.
  panel = page.getByTestId('delivery-review').last();
  const input = page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' });
  const pending = page.waitForResponse(response => response.url() === base + '/api/agent/orchestrate');
  await input.fill('office-case-repair：仅根据给定材料生成收入简报，不联网。1月100万元，2月120万元，3月90万元。未提供成本或业务原因。');
  await input.press('Enter');
  await pending;
  // Read a clone in the page: Chromium may evict completed SSE bodies from CDP.
  await page.waitForFunction(() => Boolean(window.__officeAcceptanceStream));
  const stream = await page.evaluate(() => window.__officeAcceptanceStream);
  const completions = stream.split(/\r?\n\r?\n/).filter(block => /^event: complete$/m.test(block));
  check(completions.length === 1, 'Expected one complete event');
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
  check((await panel.locator(':scope > summary').innerText()).includes(labels.repair), 'Streamed review was not applied');
  await panel.locator(':scope > summary').click();
  const beforeReload = await panel.innerText();
  await page.reload();
  await selectCase('malformed');
  await panel.locator(':scope > summary').click();
  check((await panel.innerText()) === beforeReload, 'Review changed after reload');
  const drawerToggle = page.getByRole('button', { name: '收起工作流看板', exact: true });
  if (await drawerToggle.isVisible()) await drawerToggle.click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await panel.locator(':scope > summary').scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal page overflow');
    const bounds = await panel.boundingBox();
    check(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'Review is clipped on mobile');
    const trigger = page.getByRole('button', { name: '展开工作流看板', exact: true });
    const triggerBox = await trigger.boundingBox(), header = await page.locator('main > header').boundingBox();
    check(triggerBox.y >= header.y && triggerBox.y + triggerBox.height <= header.y + header.height, 'Workflow trigger overlaps report content');
    await trigger.click();
    await page.getByRole('button', { name: '收起工作流看板', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '展开工作流看板');
    const failedOriginal = panel.getByText('上一次核对与保留原稿', { exact: true });
    await failedOriginal.click();
    check((await panel.innerText()).includes('合计320万元'), 'Mobile original draft missing');
    await page.screenshot({ path: `output/playwright/office-review-${width}.png`, animations: 'disabled' });
    await failedOriginal.click();
    const composer = await input.boundingBox();
    check(composer.y >= 0 && composer.y + composer.height <= 844, 'Composer is outside viewport');
  }
  check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  check(userRequests.length === 0, 'Browser touched the real user backend');
  check(blocked.length === 0, `Unexpected network requests: ${blocked.join('; ')}`);
  return { fixtureOnly: true, statuses: 3, rowLevelReview: true, incompleteReason: true, originalRetained: true, sse: true, reload: true, widths: [1440, 390, 320], userRequests: 0, externalRequests: 0 };
}
