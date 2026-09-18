// Run after logging into the dedicated verify-https-deployment.mjs --serve fixture.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const origin = await page.evaluate(() => location.origin);
  check(/^https:\/\/127\.0\.0\.1:\d+$/.test(origin) && !/:(3000|3001)$/.test(origin), 'Isolated HTTPS fixture required');
  const errors = [], blocked = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.context().route('**/*', route => {
    if (route.request().url().startsWith(origin + '/')) return route.continue();
    blocked.push(route.request().url()); return route.abort();
  });
  await page.routeWebSocket('**/*', ws => {
    if (ws.url().startsWith(origin.replace('https:', 'wss:') + '/')) ws.connectToServer();
    else { blocked.push(ws.url()); ws.close(); }
  });
  const health = await page.evaluate(async () => (await fetch('/api/health')).json());
  check(health.model?.status === 'unconfigured' && health.persistence === 'file', 'Never run this check with a configured model');
  const cookies = await page.context().cookies();
  const cookie = cookies.find(item => item.name === '__Host-tagent_session');
  check(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/', 'Secure session cookie missing');
  check(!await page.evaluate(() => document.cookie.includes('__Host-tagent_session')), 'HttpOnly cookie exposed to scripts');
  const title = `HTTPS ${Date.now()} 中文 🙂`;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + '/');
  await page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' }).fill(title);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.getByRole('heading', { name: '任务未能完整完成', exact: true }).waitFor();
  check(await page.getByRole('button', { name: '发送任务', exact: true }).isDisabled(), 'Composer not idle');
  const drawer = page.getByRole('complementary', { name: '工作流看板', exact: true });
  if (!await drawer.isVisible()) await page.getByRole('button', { name: '展开工作流看板', exact: true }).click();
  const side = await drawer.boundingBox(), main = await page.getByRole('main').boundingBox();
  check(main.x + main.width <= side.x + 1, 'Drawer overlaps main conversation');
  await page.screenshot({ path: 'output/playwright/https-desktop.png', animations: 'disabled' });
  await page.getByRole('button', { name: '收起工作流看板', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.getByRole('heading', { name: '任务未能完整完成', exact: true }).waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px page overflows`);
    await page.screenshot({ path: `output/playwright/https-mobile-${width}.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + '/management/agents');
  await page.getByRole('heading', { name: 'Agents 大厅', exact: true }).waitFor();
  check(!await page.getByRole('heading', { name: '登录工作区', exact: true }).isVisible(), 'Navigation lost login');
  await page.goto(origin + '/');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('heading', { name: '登录工作区', exact: true }).waitFor();
  check(!(await page.context().cookies()).some(item => item.name === '__Host-tagent_session'), 'Logout left session cookie');
  check(await page.evaluate(async () => (await fetch('/api/workspaces')).status) === 401, 'Logged out API still accessible');
  await page.reload();
  await page.getByRole('heading', { name: '登录工作区', exact: true }).waitFor();
  await page.screenshot({ path: 'output/playwright/https-logged-out.png', animations: 'disabled' });
  check(errors.length === 0, `Page errors: ${errors.join('; ')}`);
  check(blocked.length === 0, `Unexpected external requests: ${blocked.join('; ')}`);
  return { https: true, secureCookie: true, finalReport: true, history: true, threeColumns: true,
    mobileWidths: [390, 320], managementNavigation: true, logout: true, modelCalls: 0, errors, blocked };
}
