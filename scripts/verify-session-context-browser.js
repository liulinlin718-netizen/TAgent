async (page) => {
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('runFixture'));
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || /:(3000|3001)$/.test(base)) throw new Error('Isolated fixture required');
  await page.unrouteAll({ behavior: 'wait' });
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const api = async path => page.evaluate(async ({ base, path }) => {
    const response = await fetch(base + path); if (!response.ok) throw new Error('Fixture read failed'); return response.json();
  }, { base, path });
  const workspace = (await api('/api/workspaces')).workspaces[0];
  const branch = workspace.sessions.find(session => session.parentSessionId && session.messages.some(message => message.id === 'branch-result'));
  const parent = workspace.sessions.find(session => session.id === branch.parentSessionId);
  const path = `/api/workspaces/${workspace.id}/sessions/`;
  const dialog = page.getByRole('dialog', { name: '分支对比与引用' });
  if (await dialog.count()) await dialog.getByRole('button', { name: '关闭对比' }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const nav = page.getByRole('complementary', { name: '工作区导航' });
  const branchButton = nav.getByRole('button', { name: /SEED_BUDGET.*Fork/ });
  await branchButton.click(); await branchButton.focus();
  let failRead = true;
  await page.route(base + path + branch.id, route => {
    if (failRead && route.request().method() === 'GET') return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"对比读取暂不可用"}' });
    return route.continue();
  });
  await nav.getByRole('button', { name: '对比父分支', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '对比读取暂不可用' }).waitFor();
  failRead = false;
  await dialog.getByRole('button', { name: '重新读取对比' }).click();
  await dialog.getByRole('region', { name: '分支消息' }).waitFor();
  await dialog.ariaSnapshot();
  const branchRegion = dialog.getByRole('region', { name: '分支消息' });
  const article = branchRegion.getByRole('article').filter({ hasText: '## 分支备选方案' });
  assert((await article.innerText()).includes('BRANCH_ONLY_NOTE：中文'), 'Full source after 200 characters must be present');
  await page.screenshot({ path: 'output/playwright/session-diff-desktop.png' });
  const bounds = async () => {
    const result = await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { width: innerWidth, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: innerHeight,
        overflow: element.scrollWidth > element.clientWidth + 1 };
    });
    assert(result.left >= 0 && result.right <= result.width + 1 && result.bottom <= result.height + 1 && !result.overflow, 'Dialog exceeds viewport');
  };
  await bounds();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 }); await bounds();
    const tabs = dialog.getByRole('group', { name: '对比会话' });
    await tabs.getByRole('button', { name: '主线', exact: true }).click();
    assert(await dialog.getByRole('region', { name: '主线消息' }).isVisible(), 'Parent tab visible');
    await tabs.getByRole('button', { name: '分支', exact: true }).click();
    assert(await branchRegion.isVisible(), 'Branch tab visible');
    await page.screenshot({ path: `output/playwright/session-diff-${width}.png` });
  }
  await article.getByRole('button', { name: '引用此回复' }).click();
  await dialog.ariaSnapshot();
  const text = '该段是本机验收资料，保留原文与边界，不能当作已批准操作。';
  await dialog.getByRole('textbox', { name: '引用原文', exact: true }).fill('非来源原文');
  assert(await dialog.getByRole('button', { name: '预览引用', exact: true }).isDisabled(), 'Invented quote cannot preview');
  await dialog.getByRole('textbox', { name: '引用原文', exact: true }).fill(text);
  const before = await api(path + parent.id), sourceBefore = await api(path + branch.id);
  await dialog.getByRole('button', { name: '预览引用', exact: true }).click();
  await dialog.getByRole('button', { name: '确认引用到主线', exact: true }).waitFor();
  assert(JSON.stringify(await api(path + parent.id)) === JSON.stringify(before), 'Preview changed parent');
  assert(!writes.some(url => url.endsWith('/merge-to-parent')), 'No save before explicit confirmation');
  await dialog.ariaSnapshot(); await page.screenshot({ path: 'output/playwright/session-quote-preview-320.png' });
  let failSave = true;
  await page.route(base + path + branch.id + '/merge-to-parent', route => {
    if (failSave && route.request().method() === 'POST') { failSave = false; return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: '{"error":"验收写入失败"}' }); }
    return route.continue();
  });
  await dialog.getByRole('button', { name: '确认引用到主线', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '验收写入失败' }).waitFor();
  assert(JSON.stringify(await api(path + parent.id)) === JSON.stringify(before), 'Failed save changed parent');
  assert(await dialog.getByRole('blockquote').innerText() === text, 'Failed save lost draft');
  await dialog.getByRole('button', { name: '确认引用到主线', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: /引用已保存|未重复添加/ }).waitFor();
  const saved = await api(path + parent.id);
  assert(saved.messages.filter(message => message.quote?.sourceMessageId === 'branch-result' && message.content === text).length === 1, 'Saved excerpt exactly once');
  assert(JSON.stringify(await api(path + branch.id)) === JSON.stringify(sourceBefore), 'Quote mutated source');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole('button', { name: '关闭对比' }).click();
  assert(await nav.getByRole('button', { name: '对比父分支', exact: true }).evaluate(element => element === document.activeElement), 'Focus did not return to trigger');
  await page.reload(); await nav.getByRole('button', { name: /SEED_BUDGET/ }).filter({ hasNotText: 'Fork' }).first().click();
  await page.getByText('分支原文引用，未经独立核验', { exact: true }).first().waitFor();
  assert((await page.getByRole('main').innerText()).includes(text), 'Saved quote not restored in main conversation');
  await page.screenshot({ path: 'output/playwright/session-quote-saved-desktop.png' });
  assert(!writes.some(url => /:(3000|3001)\//.test(url)), 'User server write detected');
  assert(errors.length === 0, errors.join('\n'));
  return { passed: true, failureRetry: true, previewReadOnly: true, reload: true, focus: true, widths: [1440, 390, 320], errors, writes: writes.length, userWrites: 0 };
}
