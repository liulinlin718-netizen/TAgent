// Run after scripts/fixtures/run-admission-browser.js against --serve.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('admissionFixture'));
  check(/^http:\/\/127\.0\.0\.1:\d+$/.test(base) && !/:(3000|3001)$/.test(base), 'Isolated fixture required');
  const errors = [], requests = [];
  page.context().on('page', tab => tab.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  page.context().on('request', request => { if (/^http:\/\/(localhost|127\.0\.0\.1):3001\//.test(request.url())) requests.push(request.url()); });
  const workspaces = await (await page.request.get(base + '/api/workspaces')).json();
  const workspace = workspaces.workspaces[0];
  const saved = async id => (await (await page.request.get(`${base}/api/workspaces/${workspace.id}/sessions/${id}`)).json()).messages;
  const input = tab => tab.getByRole('textbox', { name: '输入任务，按 Enter 发送...' });
  const draftSession = workspace.sessions.find(session => session.title === 'admission-ui-draft');
  check(draftSession, 'Draft session missing');
  await page.getByRole('button', { name: 'admission-ui-draft', exact: true }).click();
  const draft = '  请整理会议记录：中文 / English 🚀\n负责人还未确认。  ';
  await input(page).fill(draft);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '本次未发送' }).waitFor();
  check((await page.getByRole('alert').filter({ hasText: '本次未发送' }).innerText()).includes('2 个任务'), 'Missing capacity explanation');
  check(await input(page).inputValue() === draft, 'Rejected draft formatting changed');
  check(await page.locator('main article').count() === 0, 'Rejection created a fake answer');
  check((await saved(draftSession.id)).length === 0, 'Rejected message was persisted');
  await page.getByRole('button', { name: /^admission-ui-active-A/ }).click();
  await page.getByRole('button', { name: 'admission-ui-draft', exact: true }).click();
  check(await input(page).inputValue() === draft, 'Session switch lost the draft');

  for (const text of ['界'.repeat(342), 'x'.repeat(2 * 1024 * 1024)]) {
    await input(page).fill(text);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '超过' }).waitFor();
    check(await input(page).inputValue() === text, 'Oversize rejection lost input');
    check(await page.locator('main article').count() === 0, 'Oversized message created a fake report');
  }
  await input(page).fill(draft);
  for (const session of workspace.sessions.filter(session => session.title.startsWith('admission-ui-active-'))) {
    const run = (await saved(session.id)).find(message => message.run?.status === 'running')?.run;
    check(run, 'Capacity fixture expired before browser validation');
    check((await page.request.post(`${base}/api/runs/${run.id}/cancel`, { data: {} })).ok(), 'Fixture cancellation failed');
    for (let attempt = 0; ; attempt++) {
      const status = await (await page.request.get(`${base}/api/runs/${run.id}`)).json();
      if (status.status === 'finished') break;
      check(attempt < 100, 'Fixture did not stop');
      await page.waitForTimeout(50);
    }
  }

  const title = `admission-tabs-${Date.now()}`;
  const created = await page.request.post(`${base}/api/workspaces/${workspace.id}/sessions`, { data: { title } });
  check(created.status() === 201, 'Could not create tab fixture');
  const session = await created.json();
  await page.reload();
  const other = await page.context().newPage();
  try {
    await other.setViewportSize({ width: 1440, height: 1000 });
    await other.goto(page.url());
    await page.getByRole('button', { name: title, exact: true }).click();
    await other.getByRole('button', { name: title, exact: true }).click();
    await input(page).fill(`${title} admission-hold: only the supplied notes.`);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await page.getByRole('button', { name: '停止任务', exact: true }).waitFor();
    await input(other).fill(draft);
    await other.getByRole('button', { name: '发送任务', exact: true }).click();
    const alert = other.getByRole('alert').filter({ hasText: '此会话已有任务' });
    await alert.waitFor();
    check(await input(other).inputValue() === draft, 'Second tab lost its rejected draft');
    check(await other.locator('main article').count() === 0, 'Second tab shows an invented failure answer');
    check((await saved(session.id)).length === 2, 'Duplicate tab created another task');
    check(await page.getByRole('button', { name: '停止任务', exact: true }).isEnabled(), 'Duplicate rejection stopped the original task');
    for (const width of [1440, 390, 320]) {
      await other.setViewportSize({ width, height: 1000 });
      const bounds = await alert.boundingBox();
      check(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'Error leaves viewport');
      check(await alert.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Error text overflows');
      check(await input(other).evaluate(element => element.scrollHeight <= element.clientHeight + 1), 'Short multiline draft is clipped');
      await other.screenshot({ path: `output/playwright/admission-rejected-${width}.png`, animations: 'disabled' });
    }
    await other.getByRole('button', { name: '重试读取', exact: true }).click();
    await other.getByRole('button', { name: '停止任务', exact: true }).click();
    await page.getByRole('button', { name: '发送任务', exact: true }).waitFor();
    await other.getByRole('button', { name: '发送任务', exact: true }).waitFor();
    check(await input(other).inputValue() === draft, 'Reading and cancelling the original task lost the draft');
    await other.getByRole('button', { name: '发送任务', exact: true }).click();
    await other.locator('main article').last().getByText('模型服务认证失败', { exact: false }).waitFor();
    await other.getByRole('button', { name: '发送任务', exact: true }).waitFor();
    check((await saved(session.id)).length === 4, 'Explicit retry did not create exactly one new task');
    const statuses = await other.evaluate(() => window.__admissionResponses.map(response => response.status));
    check(statuses.join(',') === '409,200', 'Unexpected automatic retry or rejected HTTP status');
  } finally { await other.close(); }
  check(errors.length === 0, errors.join('; '));
  check(requests.length === 0, 'Attempted to contact the user backend');
  return { fixtureOnly: true, capacity: true, inputLimits: true, nativeSse: true, crossTabDuplicate: true,
    explicitRetry: true, widths: [1440, 390, 320], paidCalls: 0, userWrites: 0 };
}
