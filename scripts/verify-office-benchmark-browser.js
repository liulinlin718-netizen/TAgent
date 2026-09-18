// Run only with verify-office-benchmark-api.mts --serve and its two fixture URLs.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const { base, modelBase } = await page.evaluate(() => { const params = new URL(location.href).searchParams;
    return { base: params.get('runFixture'), modelBase: params.get('modelFixture') }; });
  for (const value of [base, modelBase]) check(value && /^http:\/\/127\.0\.0\.1:\d+$/.test(value) && !/:(3000|3001)$/.test(value), 'Dedicated local fixture required');
  let userWrites = 0, starts = 0, rejectStart = false;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^http:\/\/(localhost|127\.0\.0\.1):3001\//.test(request.url()) && request.method() !== 'GET') userWrites++; });
  await page.addInitScript(fixture => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.port === '3001' && ['localhost', '127.0.0.1'].includes(url.hostname)) return original(fixture + url.pathname + url.search, { ...init, credentials: 'omit' });
      return original(input, init);
    };
  }, base);
  await page.route(base + '/api/**', async route => {
    if (route.request().method() === 'POST' && route.request().url().endsWith('/live/start')) {
      starts++;
      if (rejectStart) { await route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:3000' }, json: { error: '评测保存失败，未启动模型。' } }); return; }
    }
    await route.continue();
  });
  const path = base + '/api/agents/document-agent/benchmark';
  const stats = async () => (await (await page.request.get(modelBase + '/__fixture/status')).json()).calls;
  const original = await (await page.request.get(base + '/api/agents/document-agent')).json();
  check((await page.request.put(base + '/api/agents/document-agent', { data: { soul: original.card.soul + '\nBrowser fixture edit', configurationRevision: original.configurationRevision } })).ok(), 'Fixture edit succeeds');
  const card = () => page.locator('article').filter({ has: page.getByRole('heading', { name: '文档助手', exact: true }) });
  const dialog = page.getByRole('dialog'), live = dialog.getByRole('region', { name: '受控办公实跑' });
  const open = async () => { await card().getByRole('button', { name: '评分与证据', exact: true }).click(); await live.getByRole('button', { name: '查看范围与费用' }).waitFor(); };
  const preview = async () => { await live.getByRole('button', { name: '查看范围与费用' }).click(); await live.getByRole('heading', { name: '确认本次评测' }).waitFor(); };
  const confirm = async () => { await live.getByRole('checkbox').check(); await live.getByRole('button', { name: '确认并运行八题评测' }).click(); };
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.reload();
  await card().getByText('配置已变更 · 静态估算', { exact: true }).waitFor();
  check(await page.locator('.recharts-radar').count() === 6, 'Six radar plots retained');
  const shelf = await page.getByRole('complementary', { name: 'Skills 快速绑定库' }).boundingBox(), box = await card().boundingBox();
  check(shelf.x >= box.x + box.width, 'Skills shelf does not cover agent card');
  const before = await stats(); await open(); await preview();
  check(await live.getByRole('button', { name: '确认并运行八题评测' }).isDisabled(), 'Explicit consent required');
  check(await stats() === before && starts === 0, 'Opening and preview do not call a model');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await live.getByRole('heading', { name: '确认本次评测' }).scrollIntoViewIfNeeded();
    const bounds = await dialog.boundingBox(); check(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'Dialog fits viewport');
    check(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Dialog has no horizontal overflow');
    await page.screenshot({ path: `output/playwright/office-benchmark-consent-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.request.post(modelBase + '/__fixture/control?mode=slow');
  await confirm(); await live.getByRole('button', { name: '停止评测' }).waitFor();
  await dialog.getByRole('button', { name: '关闭评分与证据' }).click(); await open();
  await live.getByText('固定材料题通过率', { exact: false }).waitFor({ timeout: 25000 });
  check(starts === 1 && await stats() === before + 11, 'Reopening observes one job, no duplicate model requests');
  await live.locator('details').first().locator('summary').click();
  await page.screenshot({ path: 'output/playwright/office-benchmark-results-1440.png' });
  await dialog.getByRole('button', { name: '关闭评分与证据' }).click();
  await card().getByText('Benchmark 实测 · 固定材料题', { exact: true }).waitFor();
  await page.reload(); await card().getByText('Benchmark 实测 · 固定材料题', { exact: true }).waitFor(); await open();
  await page.request.post(modelBase + '/__fixture/control?mode=hold');
  await preview(); const count = await stats(); await confirm();
  await live.getByRole('button', { name: '停止评测' }).click();
  await live.getByRole('status').filter({ hasText: '已中断' }).waitFor({ timeout: 10000 });
  check(await stats() <= count + 1, 'Cancellation does not start the next question');
  const history = await (await page.request.get(path + '/live/history')).json();
  const latest = await (await page.request.get(path + '/live/runs/' + history.runs[0].id)).json();
  check(latest.run.score === undefined, 'Interrupted suite has no overall score');
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: 'output/playwright/office-benchmark-cancel-390.png' });
  await preview(); rejectStart = true; const beforeFailure = await stats(); await confirm();
  await live.getByRole('alert').filter({ hasText: '未启动模型' }).waitFor();
  check(await stats() === beforeFailure, 'Failed admission does not dispatch model');
  check(await live.getByRole('button', { name: '查看范围与费用' }).isEnabled(), 'Failed start unlocks the panel');
  check(userWrites === 0 && errors.length === 0, `Unexpected user writes/errors ${userWrites}: ${errors.join('; ')}`);
  console.log(JSON.stringify({ status: 'passed', explicitStarts: starts, paidRequests: 0, userWrites, previewNoCalls: true,
    oneJobAcrossReopen: true, cancellation: true, failureVisible: true, measuredRadar: true, widths: [1440, 390, 320] }));
}
