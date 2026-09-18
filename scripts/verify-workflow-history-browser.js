async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('runFixture'));
  check(base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base) && !/:(3000|3001)$/.test(base), 'Isolated API required');
  await page.reload();
  await page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' }).waitFor();
  const errors = [], requests = [], finished = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('503 (Service Unavailable)')) errors.push(message.text()); });
  page.on('request', request => {
    if (request.url().includes('/traces/')) requests.push(request.url());
    if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(request.url());
  });
  page.on('requestfinished', request => { if (request.url().includes('/traces/')) finished.push(request.url()); });
  const workspaces = (await (await page.request.get(base + '/api/workspaces')).json()).workspaces;
  const session = workspaces.flatMap(ws => ws.sessions).find(session => session.messages.some(message => message.run?.id === 'run-history-fixture'));
  check(!!session, 'Seeded long run missing');
  const expected = session.messages.at(-1).traces;
  await page.getByRole('button', { name: /检查长任务执行记录/ }).click();
  await page.getByRole('heading', { name: '文档核对结果' }).waitFor();
  await page.locator('body').ariaSnapshot();
  const summary = page.locator('main summary').filter({ hasText: '执行记录' });
  check(await summary.count() === 1, 'Expected one execution record');
  check(requests.length === 0, 'Collapsed records must not request pages');
  await summary.click();
  const history = page.getByRole('region', { name: '分页执行记录' });
  await history.getByText(`已加载 40 / ${expected.length} 条`, { exact: true }).waitFor();
  await history.ariaSnapshot();
  check(finished.length === 1, 'Expected one completed first page; cancelled Strict Mode requests are not loaded pages: ' + JSON.stringify({ requests, finished }));
  const rows = history.getByRole('list', { name: '任务执行记录明细' }).locator(':scope > li');
  check(await rows.count() === 40, 'DOM should contain one page, not the full task');
  await history.getByRole('button', { name: '加载更多记录' }).click();
  await history.getByText(`已加载 80 / ${expected.length} 条`, { exact: true }).waitFor();
  check(await rows.count() === 80, 'Second page not appended');
  await history.getByRole('combobox', { name: '筛选执行记录协作者' }).selectOption('research-agent');
  await history.getByRole('combobox', { name: '筛选执行记录行为' }).selectOption('governance');
  const filtered = expected.filter(event => event.agentId === 'research-agent' && event.type === 'governance');
  await history.getByText(`已加载 ${filtered.length} / ${filtered.length} 条`, { exact: true }).waitFor();
  const summaries = await rows.locator('summary').allTextContents();
  check(filtered.every(event => summaries.some(text => text.includes(event.summary))), 'Filtered events differ from saved trace');
  await rows.first().locator('summary').click();
  await rows.first().getByRole('definition').filter({ hasText: filtered[0].eventId }).waitFor();
  check(await rows.first().getByLabel('事件数据').isVisible(), 'Event data not expandable');
  const fail = async route => route.fulfill({ status: 503, json: { error: '隔离验收：执行记录读取暂不可用。' },
    headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:3000' } });
  await page.route(base + '/api/workspaces/**/traces/**', fail);
  await history.getByRole('button', { name: '刷新执行记录', exact: true }).click();
  await history.getByRole('alert').waitFor();
  check(await rows.count() === filtered.length, 'Read failure erased already loaded records');
  await page.unroute(base + '/api/workspaces/**/traces/**', fail);
  await history.getByRole('button', { name: '重试读取' }).click();
  await history.getByRole('alert').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '展开工作流看板' }).click();
  await page.locator('body').ariaSnapshot();
  await page.getByRole('tab', { name: '静态架构' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length >= 4);
  const graph = await page.locator('.react-flow__node').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')).sort());
  await page.waitForFunction(() => [...document.querySelectorAll('path[class*="workflowRelationPath"]')].some(path => path.getAttribute('d') && path.getTotalLength() > 0));
  await history.getByRole('combobox', { name: '筛选执行记录协作者' }).selectOption('');
  await history.getByRole('combobox', { name: '筛选执行记录行为' }).selectOption('');
  await history.getByText(`已加载 40 / ${expected.length} 条`, { exact: true }).waitFor();
  check(JSON.stringify(await page.locator('.react-flow__node').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')).sort())) === JSON.stringify(graph), 'Paging changed architecture nodes');
  await page.getByRole('button', { name: '收起工作流看板', exact: true }).click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 900 });
    await history.scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Page overflow at ${width}`);
    const bounds = await history.evaluate(element => {
      const outer = element.getBoundingClientRect();
      return [...element.querySelectorAll('select, button, summary, pre')].filter(item => item.getClientRects().length).every(item => {
        const rect = item.getBoundingClientRect(); return rect.left >= outer.left - 1 && rect.right <= outer.right + 1;
      });
    });
    check(bounds, `History controls overflow at ${width}`);
    await page.screenshot({ path: `output/playwright/trace-history-${width}.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await summary.click(); const before = requests.length;
  await page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' }).fill('暂存的任务输入');
  check(requests.length === before, 'Closed history should not poll');
  await page.reload();
  await page.getByRole('button', { name: /检查长任务执行记录/ }).click();
  await page.getByRole('heading', { name: '文档核对结果' }).waitFor();
  check((await page.locator('main').innerText()).includes('中文'), 'UTF-8 reload failed');
  check(errors.length === 0, 'Browser errors: ' + errors.join('\n')); check(writes.length === 0, 'History UI made a write: ' + writes.join(','));
  return { passed: true, totalEvents: expected.length, lazyPages: true, filters: true, recoverableReadError: true, graphUnchanged: true,
    viewports: [1440, 390, 320], writes: 0, pageErrors: errors.length };
}
