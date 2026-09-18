// Open /?runFixture=<base>&modelFixture=<modelBase> from verify-run-cancellation.mjs --serve.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const fixture = await page.evaluate(() => Object.fromEntries(new URL(location.href).searchParams));
  const base = fixture.runFixture;
  check([base, fixture.modelFixture].every(url => /^http:\/\/127\.0\.0\.1:\d+$/.test(url) && !/:(3000|3001)$/.test(url)), 'Isolated ports only');
  let userWrites = 0;
  const errors = [];
  page.on('request', request => { if (/127\.0\.0\.1:3001\/api\//.test(request.url()) && request.method() !== 'GET') userWrites++; });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(fixtureBase => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.origin === 'http://127.0.0.1:3001' && url.pathname.startsWith('/api/')) {
        return nativeFetch(fixtureBase + url.pathname + url.search, { ...init, credentials: 'omit' });
      }
      return nativeFetch(input, init);
    };
  }, base);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  const input = page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' });
  await input.waitFor();
  const marker = Date.now().toString().slice(-6);
  const aTitle = `cancel-synthesis 会话A${marker}`, bTitle = `办公笔记 会话B${marker}`;
  const before = await (await page.request.get(fixture.modelFixture + '/stats')).json();
  await input.fill(aTitle);
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
  check(await input.inputValue() === aTitle, 'IME confirmation must not submit the draft');
  check((await (await page.request.get(fixture.modelFixture + '/stats')).json()).calls === before.calls, 'IME must not start a model call');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.getByRole('button', { name: '停止任务', exact: true }).waitFor();
  for (let i = 0; ; i++) {
    const stats = await (await page.request.get(fixture.modelFixture + '/stats')).json();
    if (stats.waiting > before.waiting) break;
    check(i < 100, 'A did not reach final synthesis'); await page.waitForTimeout(100);
  }
  const findSession = async title => {
    const data = await (await page.request.get(base + '/api/workspaces')).json();
    for (const ws of data.workspaces) {
      const session = ws.sessions.find(item => item.title === title);
      if (session) return { ws: ws.id, session };
    }
    throw new Error('Session not found: ' + title);
  };
  const a = await findSession(aTitle), aRunId = a.session.messages.at(-1).run.id;
  await page.getByTitle('新建对话 (①)', { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
  await input.fill(bTitle);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.getByRole('heading', { name: '任务未能完整完成' }).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
  const b = await findSession(bTitle), bRunId = b.session.messages.at(-1).run.id;
  const statusA = await (await page.request.get(`${base}/api/runs/${aRunId}`)).json();
  const statusB = await (await page.request.get(`${base}/api/runs/${bRunId}`)).json();
  check(statusA.status === 'running' && statusB.status === 'finished' && statusB.persisted, 'A must remain active while B completes');
  check(!(await page.locator('main').innerText()).includes(aTitle), 'A must not leak into B messages');
  await input.fill('保留在 B 的草稿');
  await page.getByText(aTitle, { exact: true }).click();
  await page.getByRole('button', { name: '停止任务', exact: true }).waitFor();
  check(await input.inputValue() === '', 'Drafts must not cross sessions');
  check(!(await page.locator('main').innerText()).includes(bTitle), 'B must not leak into A messages');
  await page.getByRole('link', { name: '📦 Skills 技能库', exact: true }).click();
  await page.waitForURL('**/management/skills');
  check((await (await page.request.get(`${base}/api/runs/${aRunId}`)).json()).status === 'running', 'Management navigation must not cancel A');
  check((await (await page.request.get(fixture.modelFixture + '/stats')).json()).aborted === before.aborted, 'Owned stream must survive route navigation');
  await page.goBack();
  await input.waitFor();
  await page.getByRole('button', { name: '停止任务', exact: true }).waitFor();
  const cancellation = page.waitForResponse(response => response.url().endsWith(`/api/runs/${aRunId}/cancel`));
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  check((await cancellation).status() === 202, 'Stop must target A');
  await page.getByText(bTitle, { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
  check(await input.inputValue() === '保留在 B 的草稿', 'B draft lost');
  check(!(await page.locator('main').innerText()).includes('任务已取消'), 'A cancellation must not appear in B');
  await page.waitForFunction(async ({ base, id }) => (await (await fetch(`${base}/api/runs/${id}`)).json()).status === 'finished', { base, id: aRunId });
  const open = page.getByRole('button', { name: '展开工作流看板', exact: true });
  if (await open.count()) await open.click();
  check(await page.locator(`aside[data-run-id="${bRunId}"]`).count() === 1, 'Drawer must follow B, not most recently completed A');

  // Delay a genuine historical response while the user switches away again.
  const aPath = `${base}/api/workspaces/${a.ws}/sessions/${a.session.id}`;
  let release;
  const delayed = new Promise(done => { release = done; });
  let held = false;
  await page.route(aPath, async route => { const response = await route.fetch(); held = true; await delayed; await route.fulfill({ response }); });
  await page.getByText(aTitle, { exact: true }).click();
  for (let i = 0; !held; i++) { check(i < 100, 'History request not observed'); await page.waitForTimeout(50); }
  await page.getByText(bTitle, { exact: true }).click();
  const lateResponse = page.waitForResponse(aPath);
  release(); await lateResponse; await page.unroute(aPath);
  check((await page.locator('main header').innerText()).includes(bTitle), 'Late A response changed selected view');
  check(!(await page.locator('main').innerText()).includes(aTitle), 'Late A response overwrote B');
  await page.getByText(aTitle, { exact: true }).click();
  await page.getByRole('heading', { name: '任务已停止' }).waitFor();
  const activity = page.locator('main details').filter({ hasText: '执行记录' });
  check(await activity.count() === 1, 'One compact execution summary per answer');
  check(await page.getByRole('list', { name: '任务执行记录' }).count() === 0, 'Closed history must not render a long event list');
  check(!(await page.locator('main').innerText()).includes('agent_stage'), 'No raw event type names in conversation');
  await activity.locator('summary').click();
  const list = page.getByRole('list', { name: '任务执行记录' });
  await list.waitFor();
  check(await list.evaluate(element => element.clientHeight <= 241 && element.scrollHeight > element.clientHeight), 'Expanded event list must scroll internally');
  await activity.locator('summary').click();
  const results = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width < 1100 && await page.getByRole('dialog').isVisible()) {
      await page.getByRole('button', { name: '收起工作流看板', exact: true }).click();
    }
    await activity.scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page overflow');
    const rect = await input.boundingBox();
    check(rect && rect.y + rect.height <= viewport.height && rect.x + rect.width <= viewport.width, 'Composer outside viewport');
    await page.screenshot({ path: `output/playwright/conversation-isolation-${viewport.width}.png`, animations: 'disabled' });
    results.push({ viewport, noOverlap: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByTitle('新建对话 (①)', { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
  const cTitle = `ui-cancel-case 退出验收${marker}`;
  const beforeExpiry = await (await page.request.get(fixture.modelFixture + '/stats')).json();
  await input.fill(cTitle); await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.getByRole('button', { name: '停止任务', exact: true }).waitFor();
  for (let i = 0; ; i++) {
    const stats = await (await page.request.get(fixture.modelFixture + '/stats')).json();
    if (stats.waiting > beforeExpiry.waiting) break;
    check(i < 100, 'C did not start'); await page.waitForTimeout(100);
  }
  const c = await findSession(cTitle), cRunId = c.session.messages.at(-1).run.id;
  // A real API client 401 response must dispose its provider, clear private UI and abort owned streams.
  await page.route(base + '/api/workspaces', route => route.fulfill({ status: 401,
    contentType: 'application/json', body: JSON.stringify({ error: 'Fixture session expired' }) }));
  await page.getByRole('link', { name: '📦 Skills 技能库', exact: true }).click();
  await page.waitForURL('**/management/skills');
  await page.goBack();
  await page.getByRole('heading', { name: '登录工作区', exact: true }).waitFor();
  check(!(await page.locator('body').innerText()).includes(cTitle), 'Expired login must clear private conversation UI');
  await page.waitForFunction(async ({ base, id }) => (await (await fetch(`${base}/api/runs/${id}`)).json()).status === 'finished', { base, id: cRunId });
  check((await (await page.request.get(`${base}/api/runs/${cRunId}`)).json()).termination === 'disconnected', 'Expiry must abort the owned task stream');
  await page.unroute(base + '/api/workspaces');
  check(userWrites === 0, 'Do not write user backend');
  check(errors.length === 0, errors.join('\n'));
  return { passed: true, aRunId, bRunId, concurrentSessions: true, routeRetained: true, lateHistoryIgnored: true,
    scopedCancellation: true, draftsPreserved: true, compactHistory: true, imeSafe: true, expiryClearsAndStops: true,
    results, userWrites, pageErrors: errors };
}
