// Start a fresh CLI browser with ?tableFixture=<isolated base>&tableStatus=<local model /fixture-status> from verify-table-runtime.mjs --serve.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const base = await page.evaluate(() => {
    const value = new URL(location.href).searchParams.get('tableFixture');
    if (!value) return null;
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && !['3000', '3001'].includes(url.port) ? url.origin : null;
  });
  check(base, 'Only an isolated local fixture is allowed');
  const statusUrl = await page.evaluate(() => new URL(location.href).searchParams.get('tableStatus'));
  check(statusUrl && /^http:\/\/127\.0\.0\.1:\d+\/fixture-status$/.test(statusUrl) && !/:(3000|3001)\//.test(statusUrl), 'Expected isolated model status');
  const before = await (await page.request.get(statusUrl)).json();
  const errors = [], userRequests = [], taskPosts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => {
    if (/^http:\/\/(localhost|127\.0\.0\.1):3001\/api\//.test(request.url())) userRequests.push(request.url());
    if (request.method() === 'POST' && request.url().endsWith('/api/agent/orchestrate')) taskPosts.push(request.url());
  });
  await page.addInitScript(fixture => {
    const native = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      return url.pathname.startsWith('/api/') ? native(fixture + url.pathname + url.search, { ...init, credentials: 'omit' }) : native(input, init);
    };
  }, base);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`http://127.0.0.1:3000/?tableFixture=${encodeURIComponent(base)}&tableStatus=${encodeURIComponent(statusUrl)}`);
  const panel = page.getByTestId('table-calculations').last();
  const aggregate = panel.locator('[data-calculation-action="aggregate"]');
  const table = aggregate.getByRole('region', { name: '统计结果表', exact: true });
  const readable = async locator => {
    await locator.scrollIntoViewIfNeeded();
    check(await locator.evaluate(element => {
      const box = element.getBoundingClientRect();
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
      }
      return box.width > 0 && box.height > 0 && box.left >= left - 2 && box.right <= right + 2 && box.top >= top - 2 && box.bottom <= bottom + 2;
    }), 'Important result or warning was clipped in the actual viewport');
  };
  const choose = async name => {
    await page.getByRole('button', { name: new RegExp(`^table-case-${name}：`) }).first().click();
    await panel.waitFor();
    check(!await panel.evaluate(element => element.open), 'Calculations default collapsed');
    await panel.locator(':scope > summary').click();
    await aggregate.locator(':scope > summary').click();
    await table.waitFor();
  };
  for (const name of ['csv', 'tsv', 'markdown', 'invalid']) {
    await choose(name);
    check((await panel.locator(':scope > summary').innerText()).includes('2 条记录'), 'Inspect and aggregate receipts should remain distinct');
    if (name === 'invalid') {
      check((await table.innerText()).includes('含无效值，未计算'), 'Invalid numeric value was hidden');
      check((await aggregate.innerText()).includes('未生成变化率'), 'Invalid comparison displayed as a number');
      await table.getByText('异常样本', { exact: true }).click();
      check((await table.innerText()).includes('=2+2'), 'Formula should remain literal text');
    } else {
      check((await table.innerText()).includes('0.3'), 'Exact decimal result missing');
      check((await aggregate.getByRole('region', { name: '基期与本期比较' }).innerText()).includes('100%'), 'Comparison result missing');
    }
    await aggregate.getByRole('button', { name: '核对原文', exact: true }).click();
    await aggregate.getByLabel('匹配的原始表格', { exact: true }).waitFor();
    check((await aggregate.getByRole('status').innerText()).includes('不代表'), 'Fingerprint must not be presented as a business/fact verdict');
    if (name === 'csv') {
      await aggregate.locator(':scope > summary').scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'output/playwright/table-calculation-desktop.png', animations: 'disabled' });
      await readable(aggregate.getByLabel('匹配的原始表格', { exact: true }));
      await page.screenshot({ path: 'output/playwright/table-calculation-source.png', animations: 'disabled' });
      const savedText = await aggregate.innerText();
      await page.reload(); await choose('csv');
      await aggregate.getByRole('button', { name: '核对原文', exact: true }).click();
      await aggregate.getByLabel('匹配的原始表格', { exact: true }).waitFor();
      check((await aggregate.innerText()) === savedText, 'Receipt or matching source changed after reload');
      await page.locator('summary').filter({ hasText: /^执行记录/ }).click();
      const history = page.getByRole('region', { name: '分页执行记录', exact: true });
      await history.getByLabel('筛选执行记录行为').selectOption('agent_tool_result');
      const event = history.locator('li').filter({ hasText: 'analyze_table' }).last();
      await event.locator(':scope > details > summary').click();
      const eventReceipt = event.locator('[data-calculation-action="aggregate"]');
      await eventReceipt.locator(':scope > summary').click();
      await eventReceipt.getByTestId('table-metric-value').first().waitFor();
      check((await eventReceipt.innerText()).includes('0.3'), 'Paginated history did not render the shared receipt');
      check(await eventReceipt.getByRole('button', { name: '核对原文' }).count() === 0, 'History without source messages must not claim original-text matching');
      await event.getByText('原始事件数据', { exact: true }).click();
      check((await event.getByLabel('事件数据', { exact: true }).innerText()).includes('selectionSha256'), 'Raw audit data must remain available');
    }
  }
  // Long labels and real 25-group tool output must paginate without dropping results.
  await choose('large');
  check(await table.locator('tbody tr').count() === 20, 'Initial group page should contain 20 groups');
  await aggregate.getByRole('button', { name: '加载更多分组', exact: true }).click();
  check(await table.locator('tbody tr').count() === 25, 'All recorded groups must remain accessible');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await readable(table.getByTestId('table-metric-value').first());
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page horizontal overflow');
    const box = await table.boundingBox(); check(box.x >= 0 && box.x + box.width <= width + 1, 'Table scroll region is outside the bubble');
    check(await table.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Compact results must not require horizontal scrolling');
    const name = table.locator('tbody tr').first().locator('th details');
    check((await name.boundingBox()).height <= 45, 'Long name should be compact before expansion');
    await name.locator(':scope > summary').click();
    check((await name.locator(':scope > span').innerText()).length > 100, 'Full group name lost after expansion');
    await name.locator(':scope > summary').click();
    await readable(table.getByTestId('table-metric-value').first());
    await page.screenshot({ path: `output/playwright/table-calculation-${width}.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: /暗色模式/ }).click();
  await choose('invalid');
  await page.setViewportSize({ width: 320, height: 640 });
  await readable(aggregate.getByTestId('table-quality'));
  check((await aggregate.getByTestId('table-quality').innerText()).includes('未计算'), 'Uncomputed summary missing above compact results');
  await readable(table.getByTestId('table-metric-value').first());
  check(await table.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Invalid status requires horizontal scrolling');
  await page.screenshot({ path: 'output/playwright/table-calculation-dark.png', animations: 'disabled' });
  await table.getByText('异常样本', { exact: true }).click();
  await readable(table.getByText('=2+2', { exact: true }));
  await page.screenshot({ path: 'output/playwright/table-calculation-invalid.png', animations: 'disabled' });
  const inspection = panel.locator('[data-calculation-action="inspect"]');
  await inspection.locator(':scope > summary').click();
  const profile = inspection.getByRole('region', { name: '字段检查表', exact: true });
  await readable(profile.locator('tbody tr').first());
  check(await profile.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Field counts require horizontal scrolling');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: /亮色模式|浅色模式/ }).click();
  const afterReading = await (await page.request.get(statusUrl)).json();
  check(afterReading.calls === before.calls && taskPosts.length === 0, 'Viewing and fingerprint matching must not invoke the model or start tasks');
  // One explicit new task exercises the browser's native SSE path, not mocked response text.
  const workspaceId = (await (await page.request.get(base + '/api/workspaces')).json()).workspaces[0].id;
  const title = `Table browser SSE fixture ${before.calls}`;
  const created = await page.request.post(`${base}/api/workspaces/${workspaceId}/sessions`, { data: { title } });
  check(created.ok(), 'Create an isolated empty session');
  await page.reload();
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).click();
  const input = page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' });
  const sent = page.waitForResponse(response => response.url() === base + '/api/agent/orchestrate');
  await input.fill('table-case-csv：只分析下列原表，收入单位为万元，不联网；按月份汇总并比较2月对1月的变化。\n月份,收入\n1月,0.1\n1月,0.2\n2月,0.6');
  await input.press('Enter');
  const stream = await (await sent).text();
  check(stream.split(/\r?\n\r?\n/).filter(block => /^event: complete$/m.test(block)).length === 1, 'Expected exactly one terminal event');
  await panel.waitFor();
  check(!await panel.evaluate(element => element.open), 'SSE updates must not open the calculation panel');
  await panel.locator(':scope > summary').click(); await aggregate.locator(':scope > summary').click();
  await aggregate.getByRole('button', { name: '核对原文', exact: true }).click();
  await aggregate.getByLabel('匹配的原始表格', { exact: true }).waitFor();
  const after = await (await page.request.get(statusUrl)).json();
  check(after.calls === before.calls + 8 && taskPosts.length === 1, 'Only the explicit submission may invoke the local model');
  const exports = [];
  const download = async (record, name) => {
    const event = page.waitForEvent('download');
    await record.getByRole('button', { name: '下载 Excel', exact: true }).click();
    const file = await event;
    check(/^tagent-.+-[a-f0-9]{12}\.xlsx$/.test(file.suggestedFilename()), 'Unexpected export filename');
    check(await file.failure() === null, 'Browser download failed');
    const path = `output/playwright/table-export-${name}.xlsx`;
    await file.saveAs(path); exports.push(path);
  };
  await download(aggregate, 'csv');
  await choose('large');
  check(await table.locator('tbody tr').count() === 20, 'Export acceptance must start before loading the last five groups');
  await download(aggregate, 'large');
  const closeWorkflow = page.getByRole('button', { name: '收起工作流看板', exact: true });
  if (await closeWorkflow.isVisible()) await closeWorkflow.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await readable(aggregate.getByRole('button', { name: '下载 Excel', exact: true }));
  await page.screenshot({ path: 'output/playwright/table-export-mobile.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await choose('invalid');
  await download(aggregate, 'invalid');
  await page.evaluate(() => {
    const create = URL.createObjectURL;
    URL.createObjectURL = function() { URL.createObjectURL = create; throw new Error('模拟本地文件生成失败'); };
  });
  await aggregate.getByRole('button', { name: '下载 Excel', exact: true }).click();
  await aggregate.getByRole('alert').waitFor();
  check((await aggregate.getByRole('alert').innerText()).includes('失败'), 'Export failure was not visible');
  await download(aggregate, 'invalid-retry');
  check(await aggregate.getByRole('alert').count() === 0, 'Successful retry retained an old error');
  const exportInspection = panel.locator('[data-calculation-action="inspect"]');
  await exportInspection.locator(':scope > summary').click();
  await download(exportInspection, 'inspection');
  await page.screenshot({ path: 'output/playwright/table-export-desktop.png', animations: 'disabled' });
  const afterExports = await (await page.request.get(statusUrl)).json();
  check(afterExports.calls === after.calls && taskPosts.length === 1, 'Export/retry must not call the model or start a task');
  check(after.errors.length === 0, `Fixture errors: ${after.errors.join('; ')}`);
  check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  check(userRequests.length === 0, 'Browser touched real user backend');
  return { passed: true, fixtureOnly: true, nativeSSE: true, localModelCalls: 8, readCalls: 0, originalHash: true, reload: true, groups: 25, widths: [1440, 390, 320], userRequests: 0, exports };
}
