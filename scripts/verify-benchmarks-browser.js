// Dedicated browser only: ?runFixture must reference scripts/verify-benchmarks.mjs --serve.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('runFixture'));
  check(base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base) && !/:(3000|3001)$/.test(base), 'Isolated fixture required');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  let failSave = false, posts = 0, userWrites = 0;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^http:\/\/(localhost|127\.0\.0\.1):3001\//.test(request.url()) && request.method() !== 'GET') userWrites++; });
  await page.addInitScript(fixtureBase => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.port === '3001' && ['localhost', '127.0.0.1'].includes(url.hostname)) return original(fixtureBase + url.pathname + url.search, { ...init, credentials: 'omit' });
      return original(input, init);
    };
  }, base);
  await page.route(base + '/api/**', async route => {
    if (route.request().method() === 'POST' && route.request().url().endsWith('/benchmark/run')) {
      posts++;
      if (failSave) { await route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:3000' },
        json: { error: '评测结果保存失败，原记录未改变，请检查存储后重试。' } }); return; }
    }
    await route.continue();
  });
  const history = async () => (await (await page.request.get(base + '/api/agents/document-agent/benchmark/history')).json()).runs;
  const card = () => page.locator('article').filter({ has: page.getByRole('heading', { name: '文档助手', exact: true }) });
  const open = async () => { await card().getByRole('button', { name: '评分与证据', exact: true }).click(); await page.getByRole('button', { name: '检查并保存记录', exact: true }).waitFor(); };
  const dialog = page.getByRole('dialog');
  const agent = await (await page.request.get(base + '/api/agents/document-agent')).json();
  const edited = await page.request.put(base + '/api/agents/document-agent', { data: { soul: agent.card.soul + '\nBrowser fixture revision', configurationRevision: agent.configurationRevision } });
  check(edited.ok(), 'Isolated configuration edit makes the previous record stale');
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.reload();
  await card().getByText('配置已变更 · 静态估算', { exact: true }).waitFor();
  check(await page.locator('.recharts-radar').count() === 6, 'All resident radar plots must remain');
  const panel = page.getByRole('complementary', { name: 'Skills 快速绑定库' });
  const panelBox = await panel.boundingBox(), cardBox = await card().boundingBox();
  check(panelBox.x >= cardBox.x + cardBox.width, 'Skills shelf must not cover agent cards');
  const before = (await history()).length;
  await open();
  check(posts === 0, 'Opening must not save or execute a benchmark');
  await dialog.getByRole('button', { name: '检查并保存记录', exact: true }).click();
  await dialog.getByRole('button', { name: '检查并保存记录', exact: true }).waitFor();
  check((await history()).length === before + 1, 'Explicit configuration check persists');
  check(!(await dialog.innerText()).includes('旧记录不用于'), 'Current configuration is no longer stale');
  const saved = (await history())[0]; check(saved.mode === 'static_capability', 'Configuration check is not live task testing');
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.textContent?.includes('评分与证据'), undefined, { timeout: 3000 });
  await page.reload(); await open();
  check(await dialog.getByRole('combobox', { name: '检查记录', exact: true }).inputValue() === saved.runId, 'Refresh restores persisted record');
  const sources = (await (await page.request.get(base + '/api/agents/document-agent/benchmark/sources')).json()).sources;
  const failed = sources.find(source => source.title.includes('失败'));
  await dialog.getByRole('combobox', { name: '来源任务', exact: true }).selectOption(failed.runId);
  const response = page.waitForResponse(response => response.url() === base + '/api/agents/document-agent/benchmark/run' && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '复核并保存记录', exact: true }).click(); check((await response).status() === 201, 'Saved source review succeeds');
  await dialog.getByRole('heading', { name: '任务证据 · 不计入配置分', exact: true }).waitFor();
  const outcome = dialog.locator('details').filter({ hasText: '执行收尾记录' });
  check((await outcome.locator('summary').innerText()).includes('存在问题'), 'Failed task is not scored as a successful delivery');
  for (const label of ['来源与事实质量', '办公交付质量']) {
    const detail = dialog.locator('details').filter({ hasText: label }); check((await detail.locator('summary').innerText()).includes('未验证'), 'Unverified facts stay unverified');
  }
  await outcome.locator('summary').click(); check((await outcome.innerText()).includes('事件：'), 'Evidence links to event IDs');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await outcome.scrollIntoViewIfNeeded();
    const box = await dialog.boundingBox(); check(box.x >= 0 && box.x + box.width <= width + 1, 'Dialog fits viewport');
    check(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Dialog has no horizontal overflow');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page has no horizontal overflow');
    await page.screenshot({ path: `output/playwright/benchmark-evidence-${width}.png` });
  }
  failSave = true; const countBeforeFailure = (await history()).length;
  await dialog.getByRole('button', { name: '检查并保存记录', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '原记录未改变' }).waitFor();
  check((await history()).length === countBeforeFailure, 'Failed save does not change history');
  check(await dialog.getByRole('button', { name: '关闭评分与证据' }).isEnabled(), 'Failure releases the busy state');
  await page.screenshot({ path: 'output/playwright/benchmark-save-failure-320.png' });
  failSave = false;
  await dialog.getByRole('button', { name: '查看来源任务', exact: true }).click();
  await page.waitForURL('http://127.0.0.1:3000/');
  await page.getByRole('textbox').first().waitFor();
  check(await page.evaluate(id => JSON.stringify(document.body.innerText).includes('评分证据验收失败') && !!id, failed.sessionId), 'Source task is accessible from its evidence');
  check(userWrites === 0 && errors.length === 0, `Unexpected user writes or page errors: ${userWrites} ${errors.join('; ')}`);
  check(posts === 3, 'Only the two explicit saves and the injected failure posted');
  console.log(JSON.stringify({ status: 'passed', historyRefreshed: true, explicitActions: posts, sourceTaskNavigation: true,
    failurePreservesHistory: true, evidenceNotQualityScore: true, radarAndSkillsRetained: true, widths: [1440, 390, 320], userWrites }));
}
