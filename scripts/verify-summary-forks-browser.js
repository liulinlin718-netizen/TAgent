async (page) => {
  const config = await page.evaluate(() => ({ base: new URL(location.href).searchParams.get('runFixture'), control: new URL(location.href).searchParams.get('summaryControl') }));
  for (const value of Object.values(config)) if (!value || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value) || /:(3000|3001)$/.test(value)) throw new Error('Isolated fixture required');
  const { base, control } = config, errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const get = url => page.evaluate(async url => { const response = await fetch(url); if (!response.ok) throw new Error('Fixture read failed'); return response.json(); }, url);
  const mode = value => page.evaluate(async url => { const response = await fetch(url, { method: 'POST' }); if (!response.ok) throw new Error('Fixture mode failed'); }, control + '/fixture/mode/' + value);
  const workspace = (await get(base + '/api/workspaces')).workspaces[0];
  const source = workspace.sessions.find(session => !session.parentSessionId && session.messages.some(message => message.id === 'ui-user'));
  const path = base + `/api/workspaces/${workspace.id}/sessions/${source.id}`;
  const dialog = page.getByRole('dialog', { name: '摘要分支', exact: true });
  const sourceButton = () => page.getByRole('complementary', { name: '工作区导航' }).getByRole('button', { name: /SUMMARY_UI/ }).filter({ hasNotText: '摘要分支' });
  const open = async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await sourceButton().click(); await sourceButton().focus();
    await page.getByRole('button', { name: '摘要 Fork', exact: true }).click();
    await dialog.getByRole('region', { name: '创建摘要分支' }).waitFor(); await dialog.ariaSnapshot();
  };
  const before = await get(control + '/fixture/state');
  if (await dialog.count()) await dialog.getByRole('button', { name: '关闭摘要分支' }).click();
  let failRead = true;
  await page.route(path + '/summary-forks', route => failRead && route.request().method() === 'GET'
    ? route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: '{"error":"摘要记录暂不可用"}' }) : route.continue());
  await open();
  await dialog.getByRole('alert').filter({ hasText: '摘要记录暂不可用' }).waitFor();
  failRead = false; await dialog.getByRole('button', { name: '重新读取摘要记录' }).click();
  await dialog.getByText('完整保留的消息', { exact: false }).click(); await dialog.ariaSnapshot();
  await dialog.getByRole('checkbox', { name: /1\. 用户/ }).check();
  await dialog.getByRole('button', { name: '预览范围与费用' }).click();
  await dialog.getByRole('button', { name: '确认调用模型并创建' }).waitFor(); await dialog.ariaSnapshot();
  assert((await get(control + '/fixture/state')).calls === before.calls, 'Opening and preview must never call a model');
  assert(JSON.stringify(await get(path)) === JSON.stringify(source), 'Preview changed source');
  assert((await dialog.innerText()).includes('本次摘要调用不外发其正文'), 'Preserved source privacy missing');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    const bounds = await dialog.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { fits: box.left >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1,
        overflow: [...element.querySelectorAll('*')].some(item => item.clientWidth > 0 && item.scrollWidth > item.clientWidth + 2) };
    });
    assert(bounds.fits && !bounds.overflow, `Summary dialog overflow at ${width}`);
    await page.screenshot({ path: `output/playwright/summary-preview-${width}.png` });
  }
  await mode('save-failure'); await dialog.getByRole('button', { name: '确认调用模型并创建' }).click();
  await dialog.getByRole('button', { name: '重试本地保存' }).waitFor(); await dialog.ariaSnapshot();
  assert((await get(control + '/fixture/state')).calls === before.calls + 1, 'Save failure replayed a model');
  await page.screenshot({ path: 'output/playwright/summary-save-failed-320.png' });
  await mode('success'); await dialog.getByRole('button', { name: '重试本地保存' }).click();
  await dialog.getByRole('status').filter({ hasText: '分支已保存' }).waitFor();
  assert((await get(control + '/fixture/state')).calls === before.calls + 1, 'Local save retry called a model');
  const saved = await get(path), first = saved.summaryForks[0];
  const branch = await get(base + `/api/workspaces/${workspace.id}/sessions/${first.targetSessionId}`);
  assert(branch.messages[1].content === source.messages[0].content && branch.messages[1].id === 'ui-user', 'Selected source not preserved exactly');
  assert(branch.totalCost === 0 && saved.totalCost === first.usage.knownCost && saved.totalCost > 0, 'Summary cost not accounted once');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole('button', { name: '关闭摘要分支' }).click();
  assert(await page.getByRole('button', { name: '摘要 Fork', exact: true }).evaluate(element => element === document.activeElement), 'Summary close lost focus');
  await open();
  await dialog.getByRole('button', { name: '打开新分支' }).click();
  await page.getByRole('main').getByRole('heading', { name: '会话摘要（原文提取）' }).waitFor();
  assert((await page.getByRole('main').innerText()).includes(source.messages[0].content), 'Branch missing preserved user message');
  await page.reload(); await open();
  assert((await get(control + '/fixture/state')).calls === before.calls + 1, 'Reload replayed summary');
  await mode('hold');
  await dialog.getByRole('button', { name: '预览范围与费用' }).click();
  await dialog.getByRole('button', { name: '确认调用模型并创建' }).click();
  await dialog.getByRole('button', { name: '停止摘要' }).waitFor();
  await dialog.getByRole('button', { name: '关闭摘要分支' }).click();
  const input = page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' });
  await input.fill('保留这条未发送草稿');
  await page.getByRole('button', { name: '查看摘要操作' }).waitFor();
  assert(await page.getByRole('button', { name: '发送任务' }).isDisabled(), 'Concurrent source task not disabled');
  await page.getByRole('button', { name: '查看摘要操作' }).click(); await dialog.ariaSnapshot();
  await dialog.getByRole('button', { name: '停止摘要' }).click();
  await dialog.getByRole('status').filter({ hasText: '已停止或中断' }).waitFor();
  const cancelled = (await get(path + '/summary-forks')).operations[0];
  assert(cancelled.record.usage.unsettledRequests === 1, 'Cancelled request falsely reported free');
  await dialog.getByRole('button', { name: '关闭摘要分支' }).click();
  assert(await input.inputValue() === '保留这条未发送草稿', 'Summary operation cleared task draft');
  await mode('invalid'); await open();
  await dialog.getByRole('button', { name: '预览范围与费用' }).click();
  await dialog.getByRole('button', { name: '确认调用模型并创建' }).click();
  await dialog.getByRole('status').filter({ hasText: '摘要未通过' }).waitFor();
  await dialog.getByText('查看模型返回（未通过核对，最多12000字）', { exact: true }).click();
  await dialog.ariaSnapshot(); await page.screenshot({ path: 'output/playwright/summary-history-desktop.png' });
  assert((await dialog.innerText()).includes('模型编造，不是来源原文。'), 'Invalid charged output lost');
  await mode('success');
  const history = (await get(path + '/summary-forks')).operations;
  assert(history.length === 3 && history.filter(view => view.record.status === 'completed').length === 1, 'Unexpected summary branches');
  assert((await get(control + '/fixture/state')).calls === before.calls + 3, 'More model calls than confirmations');
  assert(!writes.some(url => /:(3000|3001)\//.test(url)), 'User server write detected');
  assert(errors.length === 0, errors.join('\n'));
  return { passed: true, previewReadOnly: true, realSaveRecovery: true, preserveOriginal: true, cancel: true, draftRetained: true,
    invalidResultRetained: true, reload: true, focus: true, widths: [1440, 390, 320], localModelCalls: 3, userWrites: 0, errors };
}
