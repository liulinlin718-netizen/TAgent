// Open /?runFixture=<base>&modelFixture=<modelBase>&control=<controlPath> from verify-run-recovery.mjs --serve.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const fixture = await page.evaluate(() => Object.fromEntries(new URL(location.href).searchParams));
  const base = fixture.runFixture;
  check([base, fixture.modelFixture].every(url => /^http:\/\/127\.0\.0\.1:\d+$/.test(url) && !/:(3000|3001)$/.test(url)), 'Only isolated fixture ports');
  check(/^\/control-[\da-f-]+$/.test(fixture.control), 'Use the owned fixture control path');
  let userWrites = 0;
  const errors = [];
  page.on('request', request => { if (/127\.0\.0\.1:3001\/api\//.test(request.url()) && request.method() !== 'GET') userWrites++; });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(fixtureBase => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.origin === 'http://127.0.0.1:3001' && url.pathname.startsWith('/api/')) {
        return nativeFetch(fixtureBase + url.pathname + url.search, { ...init, credentials: 'omit' });
      }
      return nativeFetch(input, init);
    };
  }, base);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  const input = page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' });
  await input.waitFor();
  const before = await (await page.request.get(fixture.modelFixture + '/stats')).json();
  const title = `crash-synthesis 验收${Date.now().toString().slice(-6)}`;
  await input.fill(title);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.getByRole('button', { name: '停止任务', exact: true }).waitFor();
  // Wait for a real pending final synthesis request, not an arbitrary elapsed delay.
  await page.waitForFunction(async ({ base, title }) => {
    const data = await (await fetch(base + '/api/workspaces')).json();
    return data.workspaces.some(ws => ws.sessions.some(session => session.title === title));
  }, { base, title });
  for (let attempt = 0; ; attempt++) {
    const stats = await (await page.request.get(fixture.modelFixture + '/stats')).json();
    if (stats.waiting > before.waiting) break;
    check(attempt < 100, 'No pending synthesis request');
    await page.waitForTimeout(100);
  }
  check((await page.request.post(fixture.modelFixture + fixture.control)).ok(), 'Fixture restart must succeed');
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
  check(await page.getByRole('button', { name: '停止任务', exact: true }).count() === 0, 'Crash must release composer');
  await page.reload();
  await page.getByText(title, { exact: true }).click();
  await page.getByRole('heading', { name: '任务因服务中断而结束' }).waitFor();
  check((await page.locator('body').innerText()).includes('子任务完整材料'), 'Saved child output visible after reentering session');
  check(await input.isEnabled(), 'Reopened session must allow explicit new task');
  const open = page.getByRole('button', { name: '展开工作流看板', exact: true });
  if (await open.count()) await open.click();
  await page.getByRole('tab', { name: '实时流转', exact: true }).click();
  await page.getByText('服务中断 · 已恢复材料', { exact: true }).waitFor();
  const results = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width <= 1100 && await page.getByRole('dialog').isVisible()) {
      await page.getByRole('button', { name: '收起工作流看板', exact: true }).click();
    }
    await page.getByRole('heading', { name: '任务因服务中断而结束' }).scrollIntoViewIfNeeded();
    const rect = await input.boundingBox();
    check(rect && rect.x >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height, 'Composer fits viewport');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page horizontal overflow');
    await page.screenshot({ path: `output/playwright/task-recovered-${viewport.width}.png`, animations: 'disabled' });
    results.push({ viewport, recoveredVisible: true });
  }
  check(userWrites === 0, 'Never write to user backend');
  check(errors.length === 0, errors.join('\n'));
  return { passed: true, restartFromRealBrowser: true, results, userWrites, pageErrors: errors };
}
