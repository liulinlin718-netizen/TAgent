async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const api = 'http://127.0.0.1:3001/api/research-search';
  const original = await (await page.request.get(`${api}/settings`)).json();
  const originalTheme = await page.locator('html').getAttribute('data-theme');
  let saved = { ...JSON.parse(JSON.stringify(original)), provider: 'auto', origin: 'default', locked: false, revision: 0, updatedAt: undefined };
  let mode = 'normal';
  let probeStatus = 'available';
  let mutations = 0;
  let tests = 0;
  let finishProbe;
  let probeStarted;
  const consoleErrors = [];
  const onError = message => { if (message.type() === 'error' && !message.text().includes('Failed to load resource')) consoleErrors.push(message.text()); };
  page.on('console', onError);
  // Intercept every settings mutation. Never save fixtures in the user's workspace.
  const route = async route => {
    const request = route.request();
    if (request.method() === 'GET') {
      if (mode === 'load-failure') return route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } });
      return route.fulfill({ json: saved });
    }
    const body = request.postDataJSON();
    check(request.headers()['x-tagent-request'] === '1', 'Mutation must use the protected API wrapper');
    check(body.confirmed === true && body.confirmationVersion === saved.confirmationVersion, 'Missing explicit consent');
    check(Object.keys(body).every(key => ['provider', 'confirmed', 'confirmationVersion', 'expectedRevision'].includes(key)), 'Unexpected external data in settings request');
    if (request.method() === 'PUT') {
      mutations++;
      if (mode === 'conflict') return route.fulfill({ status: 409, json: { error: '配置已被其他页面修改，请刷新后重新确认。' } });
      if (mode === 'write-failure') return route.fulfill({ status: 503, json: { error: '搜索配置保存失败，原配置仍然有效；请检查存储后重试。' } });
      check(body.expectedRevision === saved.revision, 'Saving did not use loaded revision');
      saved = { ...saved, provider: body.provider, origin: 'saved', revision: saved.revision + 1, updatedAt: '2026-09-11T08:00:00.000Z' };
      if (mode === 'lost-response') return route.abort('failed');
      return route.fulfill({ json: saved });
    }
    check(request.method() === 'POST' && request.url().endsWith('/test'), 'Unexpected settings endpoint');
    tests++;
    if (mode === 'deferred') { probeStarted(); await new Promise(resolve => { finishProbe = resolve; }); }
    return route.fulfill({ json: { provider: body.provider, status: probeStatus, checkedAt: '2026-09-11T08:01:00.000Z', elapsedMs: 1200,
      query: saved.testQuery, diagnostics: [{ source: 'Parallel Search', status: probeStatus === 'available' ? 'ok' : probeStatus === 'empty' ? 'empty' : 'failed',
        parsedCount: probeStatus === 'failed' ? 0 : 3, relevantCount: probeStatus === 'available' ? 2 : 0,
        ...(probeStatus === 'failed' ? { error: '请求超时；未切换来源。' } : {}) }] } });
  };
  await page.route('**/api/research-search/**', route);
  const current = page.getByRole('region', { name: '当前搜索配置' });
  const consent = page.getByRole('checkbox');
  const test = page.getByRole('button', { name: '测试来源', exact: true });
  const save = page.getByRole('button', { name: '确认并启用', exact: true });
  const refresh = page.getByRole('button', { name: '刷新搜索配置' });
  const choose = async name => { await page.getByRole('radio', { name: new RegExp(`^${name} `) }).check(); };
  const ready = async () => { await refresh.waitFor(); await page.waitForFunction(() => !document.querySelector('button[aria-label="刷新搜索配置"]')?.disabled); };
  try {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.reload();
    await current.waitFor();
    await ready();
    check(mutations === 0 && tests === 0, 'Opening the page must not save or test');
    check(await save.isDisabled() && await test.isDisabled(), 'Consent must not be preselected');
    await choose('Parallel');
    check(await save.isDisabled(), 'Selecting a provider must not imply consent');
    await consent.check();
    mode = 'deferred';
    const started = new Promise(resolve => { probeStarted = resolve; });
    await test.click();
    await started;
    check(await save.isDisabled() && await refresh.isDisabled(), 'Running test must prevent conflicting UI actions');
    check((await current.innerText()).includes('现有搜索源'), 'Testing prematurely activated the provider');
    finishProbe();
    await page.getByText('找到相关候选', { exact: true }).waitFor();
    check(mutations === 0 && tests === 1, 'Testing saved a setting');
    check((await current.innerText()).includes('现有搜索源'), 'Successful test changed current source');
    await page.locator('main').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: 'output/playwright/search-settings-desktop.png', animations: 'disabled' });

    mode = 'normal';
    await save.click();
    await page.getByText(/^配置已保存/).waitFor();
    check((await current.innerText()).includes('Parallel') && mutations === 1, 'Explicit save was not reflected');
    check(!await consent.isChecked(), 'Saving must consume the current confirmation');
    await page.reload();
    await ready();
    check((await current.innerText()).includes('Parallel'), 'Reload did not restore saved provider');
    check(!await consent.isChecked(), 'Reload silently restored consent');
    await choose('现有搜索源');
    await consent.check();
    await choose('Parallel');
    check(!await consent.isChecked(), 'Provider change reused consent');

    await consent.check();
    mode = 'conflict';
    await save.click();
    await page.getByText('配置已被其他页面修改，请刷新后重新确认。').waitFor();
    check(await save.isDisabled() && await consent.isDisabled(), 'Stale configuration can be resubmitted');
    mode = 'normal';
    await refresh.click();
    await ready();
    await choose('现有搜索源');
    await consent.check();
    mode = 'write-failure';
    await save.click();
    await page.getByText(/^搜索配置保存失败/).waitFor();
    check((await current.innerText()).includes('Parallel'), 'Failed write changed displayed current provider');
    mode = 'lost-response';
    await save.click();
    await page.getByText(/^未能确认保存结果/).waitFor();
    check(await save.isDisabled(), 'Unknown save outcome must require refresh');
    mode = 'normal';
    await refresh.click();
    await ready();
    check((await current.innerText()).includes('现有搜索源'), 'Refresh did not resolve committed save with lost response');

    await choose('Parallel');
    await consent.check();
    probeStatus = 'empty';
    await test.click();
    await page.getByText('未找到相关候选', { exact: true }).waitFor();
    probeStatus = 'failed';
    await test.click();
    await page.getByText('搜索测试失败', { exact: true }).waitFor();
    await page.getByText('请求超时；未切换来源。').waitFor();
    check((await current.innerText()).includes('现有搜索源'), 'Failed probe changed active source');
    await page.setViewportSize({ width: 390, height: 844 });
    await save.scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile document overflows');
    check(await page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth), 'Mobile content overflows');
    const bounds = await save.boundingBox();
    check(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, 'Mobile save button is clipped');
    await page.screenshot({ path: 'output/playwright/search-settings-mobile.png', animations: 'disabled' });
    await page.locator('html').evaluate(element => element.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: 'output/playwright/search-settings-dark-mobile.png', animations: 'disabled' });

    saved = { ...saved, provider: 'auto', locked: true, origin: 'environment' };
    await refresh.click();
    await ready();
    const activeNav = await page.locator('nav [aria-current="page"]').boundingBox();
    check(activeNav && activeNav.x >= 0 && activeNav.x + activeNav.width <= 390, 'Active mobile navigation link is not visible after loading');
    check(await page.getByRole('radio').first().isDisabled(), 'Deployment-controlled selection is editable');
    await consent.check();
    check(await save.isDisabled() && await test.isEnabled(), 'Deployment pin must prohibit save but permit an explicit current-source test');
    saved = { ...saved, provider: 'invalid' };
    await refresh.click();
    await ready();
    await page.getByText(/^部署中的搜索源无效/).waitFor();
    check(await save.count() === 0 && await test.count() === 0, 'Invalid deployment must not offer alternate-provider execution');
    mode = 'load-failure';
    await refresh.click();
    await page.getByText('无法读取搜索配置，请检查后端连接后重试。').waitFor();
    check(consoleErrors.length === 0, `Unexpected browser errors: ${consoleErrors.join('\n')}`);
    return { fixtureOnly: true, tests, saveRequests: mutations, consent: true, lostResponseRecovery: true, conflictProtection: true, mobile: true, deploymentPin: true };
  } finally {
    if (finishProbe) finishProbe();
    await page.unroute('**/api/research-search/**', route);
    await page.locator('html').evaluate((element, value) => { if (value === null) element.removeAttribute('data-theme'); else element.setAttribute('data-theme', value); }, originalTheme);
    page.off('console', onError);
    const after = await (await page.request.get(`${api}/settings`)).json();
    check(JSON.stringify(after) === JSON.stringify(original), 'User search settings changed during fixture tests');
    await page.reload();
  }
}
