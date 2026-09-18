// Start a fresh CLI browser at about:blank?providerFixture=<verify-provider-failures.mjs --serve base>.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const base = await page.evaluate(() => {
    const value = new URL(location.href).searchParams.get('providerFixture');
    if (!value) return null;
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && !['3000', '3001'].includes(url.port) ? url.origin : null;
  });
  check(base, 'Only an isolated loopback model fixture is allowed');
  const errors = [], userRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^http:\/\/(localhost|127\.0\.0\.1):3001\//, route => {
    userRequests.push(route.request().url()); return route.abort();
  });
  await page.addInitScript(fixture => {
    if (window.__providerFixtureCapture) return;
    window.__providerFixtureCapture = true;
    window.__providerFixtureStreams = [];
    const native = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const response = await (url.pathname.startsWith('/api/') ? native(fixture + url.pathname + url.search, { ...init, credentials: 'omit' }) : native(input, init));
      if (url.pathname === '/api/agent/orchestrate') {
        void response.clone().text().then(text => window.__providerFixtureStreams.push(text));
      }
      return response;
    };
  }, base);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`http://127.0.0.1:3000/?providerFixture=${encodeURIComponent(base)}`);
  const report = page.locator('main article').last();
  const originalReport = page.locator('main article').first();
  const scenes = [
    ['auth', '[authentication / HTTP 401]', '模型服务认证失败'],
    ['stal', '[timeout]', '模型请求超过时限'],
    ['synt', '[upstream / HTTP 503]', 'The team approved the supplied draft.'],
  ];
  for (const [prefix, code, expected] of scenes) {
    await page.getByRole('button', { name: new RegExp(`^provider-fixture-deepseek-${prefix}`) }).first().click();
    await originalReport.getByText(expected, { exact: false }).waitFor();
    const text = await originalReport.innerText();
    check(text.includes(code), `Missing actionable ${prefix} reason`);
    check(await originalReport.locator('ul > li > svg').count() === 0, 'Ordinary error bullets must not imply a passed check');
    check(!text.includes('fixture-private-provider-body'), 'Raw provider error leaked');
    check(await page.getByRole('button', { name: '停止任务', exact: true }).count() === 0, 'Finished failure still looks running');
    check((await page.locator('main').innerText()).includes('已结束'), 'No visible terminal status');
    await originalReport.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `output/playwright/provider-${prefix}-desktop.png`, animations: 'disabled' });
  }

  // Actual browser -> SSE -> production backend -> local SDK request -> persisted response.
  const workspaceResponse = await page.request.get(base + '/api/workspaces');
  check(workspaceResponse.ok(), 'Fixture workspaces unavailable');
  const workspaceId = (await workspaceResponse.json()).workspaces[0].id;
  const title = `provider-ui-${Date.now()}`;
  const created = await page.request.post(`${base}/api/workspaces/${workspaceId}/sessions`, { data: { title } });
  check(created.status() === 201, 'Could not create an isolated UI test session');
  await page.reload();
  await page.getByRole('button', { name: title, exact: true }).click();
  const input = page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' });
  await input.fill(`${title} 中文消息回归 🚀，只整理给定材料，不联网，没有确认交付日期。`);
  await input.press('Enter');
  await page.waitForFunction(() => window.__providerFixtureStreams.length === 1);
  const stream = await page.evaluate(() => window.__providerFixtureStreams[0]);
  const complete = stream.split(/\r?\n\r?\n/).filter(block => /^event: complete$/m.test(block));
  check(complete.length === 1, 'SSE did not return exactly one terminal event');
  await report.getByText('模型服务认证失败', { exact: false }).waitFor();
  await page.getByRole('button', { name: '发送任务', exact: true }).waitFor();
  check(await page.getByRole('status', { name: '任务运行中' }).count() === 0, 'Session still marked active');
  const beforeReload = await report.innerText();
  await page.reload();
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).click();
  await report.getByText('模型服务认证失败', { exact: false }).waitFor();
  check(await report.innerText() === beforeReload, 'Reload changed the stored failure report');
  check((await page.locator('main').innerText()).includes('中文消息回归 🚀'), 'UTF-8 user message was lost');

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await report.scrollIntoViewIfNeeded();
    const bounds = await report.boundingBox(), main = await page.locator('main').boundingBox();
    check(bounds.x >= main.x && bounds.x + bounds.width <= main.x + main.width + 1, 'Report escapes the conversation column');
    check(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'Report is clipped by the viewport');
    check(await report.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Report has horizontal content overflow');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page has horizontal overflow');
    await page.getByRole('button', { name: '展开工作流看板', exact: true }).click();
    await page.getByRole('button', { name: '收起工作流看板', exact: true }).click();
    await page.screenshot({ path: `output/playwright/provider-failure-${width}.png`, animations: 'disabled' });
  }
  check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  check(userRequests.length === 0, 'Browser attempted to contact the user backend');
  return { fixtureOnly: true, historyCases: 3, uniqueSseTerminal: true, reload: true,
    widths: [1440, 390, 320], userRequests: 0, paidCalls: 0 };
}
