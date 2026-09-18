async (page) => {
  const settings = await page.evaluate(() => Object.fromEntries(new URL(location.href).searchParams));
  const { runFixture: base, modelFixture } = settings;
  for (const url of [base, modelFixture]) if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || /:(3000|3001)$/.test(url)) throw new Error('Isolated fixtures required');
  const check = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], userRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^http:\/\/(localhost|127\.0\.0\.1):3001\/api\//.test(request.url())) userRequests.push(request.url()); });
  const panel = page.getByTestId('delivery-review').last();
  const select = async (phase, action) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: new RegExp(`^office-stop-${phase} ${action}`) }).click();
    await panel.waitFor();
    if (!await panel.evaluate(element => element.open)) await panel.locator(':scope > summary').click();
    await panel.ariaSnapshot();
    check((await panel.locator(':scope > summary').innerText()).includes('尚未完成核对'), 'Interrupted review incorrectly passed');
    check((await panel.innerText()).includes('任务已中断'), 'Missing interruption notice');
  };
  for (const action of ['crash', 'cancel']) for (const phase of ['review', 'revision', 'recheck']) {
    await select(phase, action);
    const title = phase === 'revision' ? '修订模型回执' : '核对模型回执';
    await panel.getByText(title, { exact: true }).click(); await panel.ariaSnapshot();
    check((await panel.innerText()).includes('未收到完整用量'), 'Pending billing must not imply free');
    if (action === 'crash') check((await panel.innerText()).includes('实际执行结果未知'), 'Pending crash receipt not explained');
    if (phase === 'recheck') {
      await panel.getByText('上一次核对与保留原稿', { exact: true }).click(); await panel.ariaSnapshot();
      check((await panel.innerText()).includes('ORIGINAL_OFFICE_DRAFT'), 'Original draft lost');
      await panel.getByText('上一次核对模型回执', { exact: true }).click();
      await panel.getByText('修订模型回执', { exact: true }).click();
      await panel.ariaSnapshot();
      check((await panel.locator('pre').allTextContents()).join('\n').includes('OFFICE_CHECK_RETAINED'), 'Prior check receipt lost');
      check((await panel.locator('pre').allTextContents()).join('\n').includes('REVISED_OFFICE_DRAFT'), 'Paid revision receipt lost');
    }
    if (phase === 'recheck' && action === 'crash') for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await panel.getByText('核对模型回执', { exact: true }).scrollIntoViewIfNeeded();
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal overflow');
      await page.screenshot({ path: `output/playwright/office-recovery-${width}.png` });
    }
  }
  await select('review', 'cancel');
  const beforeStats = await (await page.request.get(modelFixture + '/stats')).json();
  const responsePromise = page.waitForResponse(response => response.url() === base + '/api/agent/orchestrate');
  const input = page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' });
  await input.fill('office-stop-review browser：仅整理给定办公笔记，不联网。'); await input.press('Enter');
  const response = await responsePromise;
  const deadline = Date.now() + 20000;
  let waiting = false;
  while (Date.now() < deadline) {
    const stats = await (await page.request.get(modelFixture + '/stats')).json();
    if (stats.waiting > beforeStats.waiting) { waiting = true; break; }
  }
  check(waiting, 'No actual pending verification call');
  await page.locator('body').ariaSnapshot();
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  const stream = await response.text();
  const endings = stream.split(/\r?\n\r?\n/).filter(block => /^event: complete$/m.test(block));
  check(endings.length === 1, 'Missing unique SSE final');
  const final = JSON.parse(endings[0].split(/\r?\n/).find(line => line.startsWith('data:')).slice(5));
  check(final.persisted && final.termination === 'cancelled' && !final.success, 'Stop did not persist a failed final');
  await page.getByRole('button', { name: '发送任务', exact: true }).waitFor();
  await panel.waitFor();
  if (!await panel.evaluate(element => element.open)) await panel.locator(':scope > summary').click();
  await panel.ariaSnapshot();
  check((await panel.innerText()).includes('任务已中断'), 'SSE review missing');
  const afterStats = await (await page.request.get(modelFixture + '/stats')).json();
  check(afterStats.calls - beforeStats.calls === 3, 'Unexpected automatic model retries');
  await page.reload(); await select('review', 'cancel');
  await panel.getByText('核对模型回执', { exact: true }).click();
  check((await panel.innerText()).includes('任务已停止'), 'Refreshed stop receipt lost');
  check((await (await page.request.get(modelFixture + '/stats')).json()).calls === afterStats.calls, 'Refresh re-ran the model');
  check(errors.length === 0, errors.join('\n')); check(userRequests.length === 0, 'User backend contacted');
  return { passed: true, historicalCases: 6, originalAndRevisedDrafts: true, cancellationSSE: true, reloadWithoutReplay: true,
    widths: [1440, 390, 320], userDataWrites: 0, externalModelCalls: 0, errors };
}
