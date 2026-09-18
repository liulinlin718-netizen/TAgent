async (page) => {
  const origin = 'http://127.0.0.1:3000';
  const api = 'http://127.0.0.1:3001';
  const failures = [], blocked = [];
  const check = (value, message) => { if (!value) throw new Error(message); };
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  // This is read-only deployment acceptance against existing local history, not a live task test.
  await page.route('**/*', route => {
    const request = route.request();
    if ((!request.url().startsWith(origin + '/') && !request.url().startsWith(api + '/'))
      || !['GET', 'HEAD'].includes(request.method())) {
      blocked.push({ method: request.method(), url: request.url().split('?')[0] });
      return route.abort();
    }
    return route.continue();
  });
  const health = await (await page.request.get(api + '/api/health')).json();
  check(health.status === 'ok' && health.persistence === 'file', 'Expected the local file instance.');
  const before = await (await page.request.get(api + '/api/workspaces')).json();
  check(before.workspaces.length > 0, 'Expected existing workspaces; no workspace will be created.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin);
  await page.waitForLoadState('networkidle');
  check(await page.getByRole('heading', { name: 'TAgent 办公任务' }).isVisible(), 'Home did not render.');
  check(await page.getByRole('textbox').isEnabled(), 'Task input never became ready.');
  await page.screenshot({ path: 'G:/tagent/output/playwright/local-home.png' });
  const history = page.getByRole('button', { name: /^继续对话：/ }).first();
  check(await history.count() > 0, 'Existing history did not load.');
  await history.click();
  await page.getByRole('button', { name: '展开工作流看板', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'G:/tagent/output/playwright/local-history.png' });
  const loaded = [];
  for (const path of ['/management/agents', '/management/skills', '/management/mcp']) {
    await page.goto(origin + path);
    await page.waitForLoadState('networkidle');
    check(await page.getByRole('heading').count() > 0, path + ' did not render.');
    check(!await page.getByText('Application error', { exact: false }).count(), path + ' has an error overlay.');
    loaded.push(path);
  }
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(origin);
    await page.waitForLoadState('networkidle');
    check(await page.getByRole('textbox').isEnabled(), 'Mobile task input did not load.');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile horizontal overflow.');
    await page.screenshot({ path: `G:/tagent/output/playwright/local-mobile-${width}.png` });
  }
  check(failures.length === 0, 'Browser errors: ' + failures.join('; '));
  check(blocked.length === 0, 'Unexpected external or modifying requests: ' + JSON.stringify(blocked));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin);
  return { passed: true, loaded, mobileWidths: [390, 320], errors: failures, blocked, submittedTasks: 0, mailboxAccess: false };
}
