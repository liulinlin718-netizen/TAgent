// Open about:blank?runtimeFixture=<isolated --serve office fixture URL> before running.
async (page) => {
  const origin = 'http://127.0.0.1:3310';
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('runtimeFixture'));
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || /:(3000|3001|3310)$/.test(base)) throw new Error('Isolated fixture required');
  const check = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (!url.startsWith(origin + '/')) return route.abort();
    if (url.startsWith(origin + '/api/')) {
      requests.push(url.slice(origin.length));
      const response = await route.fetch({ url: base + url.slice(origin.length),
        headers: { ...request.headers(), origin: 'http://127.0.0.1:3000' } });
      return route.fulfill({ response });
    }
    return route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + '/management/runtime');
  await page.getByRole('button', { name: '新建周期任务' }).click();
  await page.getByLabel('名称', { exact: true }).fill('页面验收待办');
  await page.getByRole('textbox', { name: '办公任务', exact: true }).fill('只整理合成材料，不执行外部操作。');
  check(!await page.getByRole('button', { name: '保存', exact: true }).isEnabled(), 'Save requires consent');
  await page.screenshot({ path: 'G:/tagent/output/playwright/runtime-desktop.png' });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Runtime overflow at ' + width);
    await page.getByRole('textbox', { name: '办公任务', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `G:/tagent/output/playwright/runtime-mobile-${width}.png` });
  }
  await page.getByRole('checkbox', { name: /确认保存/ }).check();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('heading', { name: '页面验收待办', exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑页面验收待办', exact: true }).click();
  await page.getByLabel('启用到期提醒', { exact: true }).uncheck();
  await page.getByRole('checkbox', { name: /确认保存/ }).check();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '编辑页面验收待办', exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin);
  await page.getByRole('button', { name: '只读探索', exact: true }).click();
  check(await page.getByText('公开网页检索；初步摘要，模型与搜索可能计费').isVisible(), 'Missing Explore cost notice');
  await page.getByRole('button', { name: /^office-case-repair.*\$/ }).click();
  await page.getByRole('button', { name: '执行快照', exact: true }).click();
  const selector = page.getByRole('combobox', { name: '执行时刻', exact: true });
  await selector.selectOption({ index: 1 });
  await page.getByRole('checkbox', { name: /保留为新分支/ }).waitFor();
  check(!await page.getByRole('button', { name: '创建快照分支', exact: true }).isEnabled(), 'Snapshot fork requires consent');
  await page.screenshot({ path: 'G:/tagent/output/playwright/snapshot-desktop.png' });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Snapshot overflow at ' + width);
    await page.screenshot({ path: `G:/tagent/output/playwright/snapshot-mobile-${width}.png` });
  }
  await page.getByRole('checkbox', { name: /保留为新分支/ }).check();
  await page.getByRole('button', { name: '创建快照分支', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  check(!requests.some(path => /\/api\/agent\/(run|orchestrate)/.test(path)), 'Controls unexpectedly ran a task');
  check(!errors.length, errors.join('\n'));
  return { passed: true, widths: [1440, 390, 320], snapshotFork: true, scheduleSave: true, exploreMode: true, modelRequests: 0 };
}
