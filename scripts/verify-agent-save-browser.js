// Run only in a dedicated browser with ?runFixture=<isolated workflow fixture URL>.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('runFixture'));
  check(base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base) && !/:(3000|3001)$/.test(base), 'Isolated fixture required');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  let failCreate = true, failBinding = false, userWrites = 0;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^http:\/\/(127\.0\.0\.1|localhost):3001\//.test(request.url()) && request.method() !== 'GET') userWrites++; });
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
  await page.route(base + '/api/**', async route => {
    const path = route.request().url().slice(base.length);
    if (route.request().method() === 'POST' && ((path === '/api/agents' && failCreate) || (path.endsWith('/override') && failBinding))) {
      await route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:3000' }, json: { error: 'Agent 保存失败，原配置仍然有效；请检查存储后重试。' } }); return;
    }
    await route.continue();
  });
  const list = async () => (await (await page.request.get(base + '/api/agents')).json()).agents;
  const name = `浏览器保存验收-${Date.now()}`;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole('heading', { name: '研究助手', exact: true }).waitFor();
  check(await page.locator('.recharts-radar').count() >= 6, 'Resident radar scores remain visible');
  const before = (await list()).length;
  await page.getByRole('button', { name: '新建 Agent', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill(name);
  await page.getByLabel('描述 / Soul 摘要', { exact: true }).fill('保存故障后保留草稿，UTF-8 中文 / symbols %');
  await page.getByLabel('Soul / 角色设定', { exact: true }).fill('仅基于用户材料整理办公交付物。');
  await page.getByRole('button', { name: '保存 Agent', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '原配置仍然有效' }).waitFor();
  check(await page.getByLabel('名称', { exact: true }).inputValue() === name, 'Failure must retain the draft');
  check((await list()).length === before, 'Failed save must not create an Agent');
  await page.screenshot({ path: 'output/playwright/agent-save-failure-desktop.png' });
  failCreate = false;
  await page.getByRole('button', { name: '保存 Agent', exact: true }).click();
  await page.getByRole('heading', { name: '新建 Agent Card', exact: true }).waitFor({ state: 'hidden' });
  let saved = (await list()).find(agent => agent.name === name);
  check(saved && saved.configurationRevision === 1, 'Save is acknowledged by the real fixture backend');
  await page.reload();
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await card.waitFor();
  const skill = page.getByRole('complementary', { name: 'Skills 快速绑定库' }).locator('article').first();
  const firstSkill = (await (await page.request.get(base + '/api/skills')).json()).skills[0];
  failBinding = true;
  const dataTransfer = await page.evaluateHandle(id => { const data = new DataTransfer(); data.setData('text/plain', id); return data; }, firstSkill.id);
  await skill.dispatchEvent('dragstart', { dataTransfer });
  await card.dispatchEvent('drop', { dataTransfer });
  await page.getByRole('alert').filter({ hasText: '原配置仍然有效' }).waitFor();
  check(!(await list()).find(agent => agent.id === saved.id).capabilities.skills.includes(firstSkill.id), 'Failed binding must not become saved');
  check(await card.getByText('拖拽右侧 Skill 到这里绑定', { exact: true }).isVisible(), 'Failed binding must not appear successful');
  failBinding = false;
  await skill.dispatchEvent('dragstart', { dataTransfer }); await card.dispatchEvent('drop', { dataTransfer });
  await card.getByText(firstSkill.name, { exact: true }).waitFor();
  saved = (await list()).find(agent => agent.id === saved.id);
  check(saved.capabilities.skills.includes(firstSkill.id), 'Confirmed binding is stored');
  const panel = page.getByRole('complementary', { name: 'Skills 快速绑定库' });
  const layout = await Promise.all([panel.boundingBox(), card.boundingBox()]);
  check(layout[0].x >= layout[1].x + layout[1].width, 'Skill library must not cover the Agent card');
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill(name + '-未提交');
  const concurrent = await page.request.post(`${base}/api/agents/${saved.id}/override`, { data: { mcpServers: ['concurrent-binding'], configurationRevision: saved.configurationRevision } });
  check(concurrent.ok(), 'Fixture concurrent update succeeds');
  await page.getByRole('button', { name: '保存 Agent', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '已被其他操作修改' }).waitFor();
  check(await page.getByLabel('名称', { exact: true }).inputValue() === name + '-未提交', 'Conflict keeps user edits');
  check((await list()).find(agent => agent.id === saved.id).capabilities.mcpServers.includes('concurrent-binding'), 'Conflict must not remove the concurrent binding');
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await page.getByRole('button', { name: '刷新列表', exact: true }).waitFor();
  check(await page.getByLabel('名称', { exact: true }).inputValue() === name + '-未提交', 'Refreshing the list retains the draft');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('alert').filter({ hasText: '已被其他操作修改' }).scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Editor and errors must fit mobile width');
    await page.screenshot({ path: `output/playwright/agent-save-conflict-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const childResponse = await page.request.post(base + '/api/agents/research-agent/spawn', { data: {
    name: '页面沉淀验收子 Agent', objective: '核查来源' } });
  check(childResponse.ok(), 'Create a temporary fixture Agent');
  const child = (await childResponse.json()).agent;
  await page.reload();
  await page.getByRole('button', { name: /^任务子 Agent/ }).click();
  const taskCard = page.locator('article').filter({ has: page.getByRole('heading', { name: child.name, exact: true }) });
  const beforePreview = (await list()).filter(agent => agent.type === 'resident').length;
  await taskCard.getByRole('button', { name: '保存到大厅', exact: true }).click();
  await page.getByRole('heading', { name: '新建 Agent Card', exact: true }).waitFor();
  check((await list()).filter(agent => agent.type === 'resident').length === beforePreview, 'Opening the builder is preview only');
  const promotedName = name + '-沉淀';
  await page.getByLabel('名称', { exact: true }).fill(promotedName);
  await page.getByRole('button', { name: '保存 Agent', exact: true }).click();
  await page.getByRole('heading', { name: '新建 Agent Card', exact: true }).waitFor({ state: 'hidden' });
  const promoted = (await list()).find(agent => agent.name === promotedName);
  check(promoted?.type === 'resident', 'Explicit confirmation creates a separate resident');
  const original = (await list()).find(agent => agent.id === child.id);
  check(original.type === 'task_spawned' && original.spawnMeta.promotedAgentId === promoted.id, 'Original task and promotion association remain intact');
  await page.reload();
  await page.getByRole('heading', { name: promotedName, exact: true }).waitFor();
  check(errors.length === 0, `Page errors: ${errors.join('; ')}`);
  check(userWrites === 0, 'No writes to the user backend');
  console.log(JSON.stringify({ status: 'passed', savedAgentId: saved.id, failureRetainsDraft: true, refreshed: true,
    skillBinding: true, confirmedPromotion: true, conflictRetainsDraft: true, radarRetained: true, skillsNotOverlapping: true, mobileWidths: [390, 320], userWrites }));
}
