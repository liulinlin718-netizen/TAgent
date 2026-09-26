// Run in a dedicated Playwright CLI session against the temporary frontend on port 3210.
async (page) => {
  const fixture = null; // generated display data
  if (!fixture) throw new Error('Run readme-visuals-fixture.mts, then use output/playwright/readme-capture.js.');
  const origin = 'http://127.0.0.1:3210';
  const errors = [], blocked = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = request.url();
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (path.startsWith('/api/')) {
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: {
        'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'content-type',
      } });
      if (request.method() !== 'GET') { blocked.push(request.method() + ' ' + path); return route.abort(); }
      const data = path === '/api/auth/session' ? { authenticated: true, required: false }
        : path === '/api/workspaces' ? { workspaces: [{ ...fixture.workspace, sessions: [{ ...fixture.session, messages: [] }] }] }
        : path === `/api/workspaces/${fixture.workspace.id}/sessions/${fixture.session.id}`
          ? { session: fixture.session, nextBefore: null }
        : path === '/api/agents' ? { agents: fixture.agents }
        : path === '/api/skills' ? { skills: fixture.skills }
        : path === '/api/mcp' ? { servers: fixture.mcpServers }
        : fixture.benchmarks[path.split('/')[3]] && path.endsWith('/benchmark') ? fixture.benchmarks[path.split('/')[3]]
        : null;
      if (!data) { blocked.push(path); return route.fulfill({ status: 404, json: { error: 'Not a public demo route' } }); }
      return route.fulfill({ status: 200, json: data, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' } });
    }
    if (!url.startsWith(origin + '/')) { blocked.push(url.split('/').slice(0, 3).join('/')); return route.abort(); }
    return route.continue();
  });
  await page.setViewportSize({ width: 1600, height: 1050 });
  await page.goto(origin);
  await page.getByRole('heading', { name: 'TAgent 办公任务', exact: true }).waitFor();
  await page.getByRole('button', { name: '继续对话：营收简报 · 合成示例', exact: true }).click();
  await page.getByRole('heading', { name: '三个月营收简报', exact: true }).waitFor();
  await page.getByRole('button', { name: '展开工作流看板', exact: true }).click();
  await page.getByRole('tab', { name: '实时流转', exact: true }).waitFor();
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.locator('[class*="messages"]').first().evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: 'G:/tagent/output/playwright/readme-workspace.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1600, height: 1450 });
  await page.getByRole('separator', { name: '调整工作流宽度', exact: true }).press('End');
  await page.getByRole('tab', { name: '静态架构', exact: true }).click();
  await page.getByRole('button', { name: '查看架构全景', exact: true }).click();
  await page.getByRole('button', { name: '缩小架构', exact: true }).click();
  await page.waitForTimeout(600);
  const drawer = page.getByRole('tab', { name: '静态架构', exact: true }).locator('..').locator('..');
  await drawer.screenshot({ path: 'G:/tagent/output/playwright/readme-architecture.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1600, height: 1320 });
  await page.goto(origin + '/management/agents');
  await page.getByRole('heading', { name: '研究助手', exact: true }).waitFor();
  await page.locator('.recharts-radar').first().waitFor();
  // Recharts animates SVG geometry independently of CSS screenshot animation settings.
  await page.waitForTimeout(1600);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.screenshot({ path: 'G:/tagent/output/playwright/readme-agents.png', animations: 'disabled' });
  const researchCard = page.locator('article').filter({ has: page.getByRole('heading', { name: '研究助手', exact: true }) });
  await researchCard.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('checkbox', { name: '绑定 资料检索 · 演示服务', exact: true }).check();
  // Unsaved UI configuration only: capability and permission are separate controls.
  const bindings = page.getByRole('heading', { name: 'MCP 绑定与权限', exact: true }).locator('..').locator('..');
  await bindings.screenshot({ path: 'G:/tagent/output/playwright/readme-bindings.png', animations: 'disabled' });
  await page.goto(origin + '/management/skills');
  await page.getByRole('heading', { name: 'Skills 技能库', exact: true }).waitFor();
  await page.getByRole('button', { name: '新建 Skill', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('营收简报');
  await page.getByLabel('分类', { exact: true }).fill('document');
  await page.getByLabel('描述', { exact: true }).fill('将用户提供的营收表整理为简报，保留统计口径和材料边界。');
  await page.getByLabel('触发条件', { exact: true }).fill('营收简报, 月度经营总结');
  await page.getByLabel('适用 Agent', { exact: true }).fill('document-agent, data-agent');
  await page.getByPlaceholder('写清楚执行步骤、判断条件、降级策略。').fill('1. 确认读者、时间范围、单位和原始数据。\n2. 根据已核对的计算结果整理营收概览。\n3. 将事实、推断和待补材料分开，不编造业务原因。\n4. 输出摘要、数据表、风险和下月行动建议。');
  await page.getByRole('button', { name: '添加文档', exact: true }).click();
  await page.getByRole('combobox', { name: '类型', exact: true }).last().selectOption('checklist');
  await page.getByRole('textbox', { name: '标题', exact: true }).last().fill('交付检查清单');
  await page.getByPlaceholder('- 检查输出是否覆盖关键问题\n- 检查来源和风险').fill('- 合计来自已核对的数据，单位一致。\n- 未提供成本时不判断利润。\n- 待补信息和行动建议单独列出。');
  await page.getByRole('heading', { name: '文档包', exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.getByRole('heading', { name: '文档包', exact: true }).click();
  await page.getByRole('main').evaluate(element => element.scrollBy(0, -48));
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.screenshot({ path: 'G:/tagent/output/playwright/readme-skill-builder.png', animations: 'disabled' });
  if (errors.length || blocked.length) throw new Error(JSON.stringify({ errors, blocked }));
  return { images: 5, syntheticData: true, modelCalls: 0, userDataAccess: false, configurationSaved: false };
}
