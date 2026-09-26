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
        : path === '/api/mcp' ? { servers: [] }
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
  await page.setViewportSize({ width: 1600, height: 1320 });
  await page.goto(origin + '/management/agents');
  await page.getByRole('heading', { name: '研究助手', exact: true }).waitFor();
  await page.locator('.recharts-radar').first().waitFor();
  // Recharts animates SVG geometry independently of CSS screenshot animation settings.
  await page.waitForTimeout(1600);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.screenshot({ path: 'G:/tagent/output/playwright/readme-agents.png', animations: 'disabled' });
  if (errors.length || blocked.length) throw new Error(JSON.stringify({ errors, blocked }));
  return { images: 2, syntheticData: true, modelCalls: 0, userDataAccess: false };
}
