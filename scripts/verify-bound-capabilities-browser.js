// Dedicated browser only, with ?runFixture=<verify-bound-capabilities.mjs --serve URL>.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('runFixture'));
  check(base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base) && !/:(3000|3001)$/.test(base), 'Isolated fixture required');
  let blockedRequests = 0, userWrites = 0;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^http:\/\/(localhost|127\.0\.0\.1):3001\//.test(request.url()) && request.method() !== 'GET') userWrites++; });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1:3000/') || url.startsWith(base + '/')) return route.continue();
    blockedRequests++; return route.abort();
  });
  await page.addInitScript(fixtureBase => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.port === '3001' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname.startsWith('/api/')) {
        return original(fixtureBase + url.pathname + url.search, { ...init, credentials: 'omit' });
      }
      return original(input, init);
    };
  }, base);
  const readAgent = async () => (await (await page.request.get(base + '/api/agents')).json()).agents.find(agent => agent.id === 'research-agent');
  const readMCP = async () => (await (await page.request.get(base + '/api/mcp')).json()).servers;
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: '研究助手', exact: true }) });
  const editor = page.getByRole('heading', { name: '编辑 Agent Card', exact: true });
  const resource = page.getByRole('checkbox', { name: /^允许读取 Skill 附属文件/ });
  const bound = page.getByRole('checkbox', { name: '绑定 Office fixture', exact: true });
  const allowed = page.getByRole('checkbox', { name: '允许调用 Office fixture', exact: true });
  const open = async () => { await card.getByRole('button', { name: '编辑', exact: true }).click(); await editor.waitFor(); };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload(); await card.waitFor();
  check(await page.locator('.recharts-radar').count() >= 6, 'Six resident radar scores remain');
  const panel = page.getByRole('complementary', { name: 'Skills 快速绑定库' });
  const cardBox = await card.boundingBox(), panelBox = await panel.boundingBox();
  check(panelBox.x >= cardBox.x + cardBox.width, 'Skill library must not cover Agent cards');
  await page.screenshot({ path: 'output/playwright/bound-capabilities-hall-1440.png' });
  const before = await readAgent();
  check(before.constraints.allowedTools.length === 0, 'Fixture starts with no tool permissions');
  await open();
  check(await bound.isChecked() && !await allowed.isChecked() && !await resource.isChecked(), 'Bound is not permitted');
  await bound.uncheck(); check(await allowed.isDisabled(), 'Unbound MCP cannot acquire permission');
  await bound.check(); check(!await allowed.isChecked(), 'Binding must not auto-grant');
  await allowed.check(); await resource.check();
  check(JSON.stringify(await readAgent()) === JSON.stringify(before), 'Draft permissions do not write');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await open(); check(!await allowed.isChecked() && !await resource.isChecked(), 'Cancel discards draft only');
  await page.getByRole('textbox', { name: '工具白名单', exact: true }).fill('custom_allowed');
  await allowed.check(); await resource.check();
  await page.getByRole('button', { name: '保存 Agent', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  const saved = await readAgent();
  check(saved.constraints.allowedTools.slice().sort().join(',') === ['custom_allowed', 'mcp_Office_fixture', 'read_skill_file'].sort().join(','), 'Explicit save includes chosen permissions and preserves custom entries');
  check((await readMCP())[0].executionApproved === false, 'Agent save cannot authorize MCP execution');
  await page.reload(); await card.waitFor(); await open();
  check(await bound.isChecked() && await allowed.isChecked() && await resource.isChecked(), 'Permission selection survives refresh');
  await page.getByRole('link', { name: '服务尚未授权执行 · MCP 管理', exact: true }).waitFor();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole('heading', { name: 'MCP 绑定与权限', exact: true }).scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Permission editor fits viewport');
    const boxes = await page.locator('input[type=checkbox]').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().width).map(element => {
      const box = element.getBoundingClientRect(); return { x: box.x, right: box.right };
    }));
    check(boxes.every(box => box.x >= 0 && box.right <= width), 'Checkboxes stay in viewport');
    await page.screenshot({ path: `output/playwright/bound-capabilities-editor-${width}.png` });
  }
  await page.getByRole('button', { name: '取消', exact: true }).click();
  const duplicate = await page.request.post(base + '/api/mcp', { data: { name: 'Office-fixture', type: 'stdio', command: 'fixture-never-executed' } });
  check(duplicate.ok(), 'Isolated collision fixture saved, not executed');
  await page.reload(); await card.waitFor(); await open();
  await page.getByRole('checkbox', { name: '绑定 Office-fixture', exact: true }).check();
  check(await page.getByText('工具标识冲突：需在 MCP 管理中修改服务名称', { exact: true }).count() === 2, 'Both conflicting bindings identified');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  check(JSON.stringify(await readAgent()) === JSON.stringify(saved), 'Canceled collision does not change saved Agent');
  check(errors.length === 0, `Page errors: ${errors.join('; ')}`);
  check(userWrites === 0, 'No writes to user backend');
  check(blockedRequests === 0, 'No external or user-backend requests attempted');
  return { status: 'passed', explicitSave: true, cancelNoWrite: true, bindingNoGrant: true, refresh: true,
    stdioApprovalSeparate: true, nameCollisionVisible: true, radarRetained: true, skillsNotOverlapping: true,
    viewportWidths: [1440, 390, 320], userWrites, blockedRequests };
}
