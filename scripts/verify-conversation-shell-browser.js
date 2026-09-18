// Use a dedicated browser with ?runFixture=<isolated port>; all API reads are fixtures.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('runFixture'));
  check(base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base) && !/:(3000|3001)$/.test(base), 'Isolated fixture address required');
  const errors = [];
  let writes = 0, mode = 'offline', release, held = false;
  const sessions = ['甲', '乙'].map((name, index) => ({ id: `s${index}`, title: `验收${name}`, messages: [],
    creationType: 'new', parentSessionId: null, totalCost: 0, updatedAt: '2026-09-12T00:00:00Z' }));
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(fixtureBase => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.origin === 'http://127.0.0.1:3001' && url.pathname.startsWith('/api/')) {
        return original(fixtureBase + url.pathname + url.search, { ...init, credentials: 'omit' });
      }
      return original(input, init);
    };
  }, base);
  const routeHandler = async route => {
    const path = route.request().url().slice(base.length);
    if (route.request().method() !== 'GET') { writes++; await route.abort(); return; }
    if (path === '/api/auth/session' && mode === 'hold') {
      held = true;
      await new Promise(done => { release = done; });
    }
    if (path === '/api/auth/session' && mode === 'offline') {
      await route.fulfill({ status: 503, json: { error: 'Fixture offline' } }); return;
    }
    const data = path === '/api/auth/session' ? { authenticated: true, required: false }
      : path === '/api/workspaces' ? { workspaces: [{ id: 'ws', name: '会话壳验收', description: '', residentAgents: [], sessions }] }
        : sessions.find(session => path === `/api/workspaces/ws/sessions/${session.id}`);
    check(data, `Unexpected API read: ${path}`);
    await route.fulfill({ status: 200, json: data }).catch(error => { if (mode !== 'hold') throw error; });
  };
  await page.route(base + '/api/**', routeHandler);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByRole('heading', { name: '暂时无法连接工作区' }).waitFor();
    mode = 'ready';
    await page.getByRole('button', { name: '重新连接', exact: true }).click();
    const input = page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' });
    await input.waitFor();
    const open = page.getByRole('button', { name: '打开导航', exact: true });
    await open.click();
    await page.getByRole('dialog', { name: '工作区导航' }).getByText('验收甲', { exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    check((await page.locator('main header').innerText()).includes('验收甲'), 'Navigation must select the session');
    await open.click(); await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    check(await open.evaluate(element => element === document.activeElement), 'Escape restores trigger focus');
    await open.click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 390, height: 844 });
    await open.waitFor();
    check(await page.getByRole('dialog').count() === 0, 'Resizing must not reopen stale navigation');
    await open.click();
    await page.getByRole('dialog', { name: '工作区导航' }).getByText('验收乙', { exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    check((await page.locator('main header').innerText()).includes('验收乙'), 'Second session selected');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page overflow');
    await page.screenshot({ path: 'output/playwright/conversation-shell-mobile.png', animations: 'disabled' });
    mode = 'hold';
    await page.reload();
    for (let i = 0; !held; i++) { check(i < 100, 'Initial access request not observed'); await page.waitForTimeout(50); }
    await page.evaluate(() => window.dispatchEvent(new Event('tagent:auth-required')));
    await page.getByRole('heading', { name: '登录工作区', exact: true }).waitFor();
    release();
    await page.waitForTimeout(250);
    check(await page.getByRole('heading', { name: '登录工作区', exact: true }).isVisible(), 'Late access response must not undo expiry');
    check(writes === 0 && errors.length === 0, `Unexpected writes/errors: ${writes}, ${errors.join(', ')}`);
    return { passed: true, offlineRetry: true, sessionSelectionClosesNavigation: true, escapeFocus: true,
      breakpointReset: true, expiryWinsLateCheck: true, writes, pageErrors: errors };
  } finally {
    release?.();
    await page.unroute(base + '/api/**', routeHandler);
  }
}
