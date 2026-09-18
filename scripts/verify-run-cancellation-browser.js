// Open /?runFixture=<base returned by verify-run-cancellation.mjs --serve> in a dedicated CLI browser.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('runFixture'));
  check(base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base) && !/:(3000|3001)$/.test(base), 'Only an isolated backend is allowed');
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
  await page.reload();
  const input = page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' });
  await input.waitFor();
  await page.waitForFunction(async base => (await (await fetch(base + '/api/workspaces')).json()).workspaces.length > 0, base);
  const results = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width <= 1100 && await page.getByRole('dialog').isVisible()) {
      await page.getByRole('button', { name: '收起工作流看板', exact: true }).click();
    }
    const request = page.waitForResponse(response => response.url() === base + '/api/agent/orchestrate');
    await input.fill('ui-cancel-case: stop this local fixture task');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    const response = await request;
    check(response.status() === 200, 'Run stream must open');
    const stop = page.getByRole('button', { name: '停止任务', exact: true });
    await stop.waitFor();
    check(await stop.isEnabled(), 'Stop must be available after run creation');
    const rect = await stop.boundingBox();
    check(rect && rect.x >= 0 && rect.y + rect.height <= viewport.height && rect.x + rect.width <= viewport.width, 'Stop button must fit viewport');
    await page.waitForFunction(() => {
      const list = document.querySelector('main > div[class*="messages"]');
      return list && list.scrollHeight - list.clientHeight - list.scrollTop < 5;
    });
    await page.screenshot({ path: `output/playwright/task-running-${viewport.width}.png`, animations: 'disabled' });
    const cancelResponse = page.waitForResponse(response => /\/api\/runs\/[^/]+\/cancel$/.test(response.url()));
    await stop.click();
    const cancelReply = await cancelResponse;
    check(cancelReply.status() === 202, 'Backend must acknowledge stopping, not fake immediate completion');
    const cancelled = { runId: cancelReply.url().split('/').at(-2) };
    await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
    const terminal = await page.evaluate(async ({ base, id }) => (await fetch(`${base}/api/runs/${id}`)).json(), { base, id: cancelled.runId });
    check(terminal.status === 'finished' && terminal.termination === 'cancelled' && terminal.persisted === true, 'Cancellation must be persisted');
    const saved = await page.evaluate(async ({ base, run }) => (await fetch(`${base}/api/workspaces/${run.workspaceId}/sessions/${run.sessionId}`)).json(), { base, run: terminal });
    check(saved.messages.at(-1).traces.filter(event => event.type === 'complete').length === 1, 'One persisted terminal event');
    check(!(await page.locator('body').innerText()).includes('未收到完整结果'), 'UI must receive the terminal event, not just close the connection');
    check(await page.getByRole('button', { name: '停止任务', exact: true }).count() === 0, 'Stop button must not remain after completion');
    check(await page.locator('body').innerText().then(text => text.includes('任务已取消')), 'Show readable cancellation outcome');
    await page.waitForFunction(() => {
      const list = document.querySelector('main > div[class*="messages"]');
      return list && list.scrollHeight - list.clientHeight - list.scrollTop < 5;
    });
    await page.screenshot({ path: `output/playwright/task-cancelled-${viewport.width}.png`, animations: 'disabled' });
    results.push({ viewport, runId: terminal.runId, cancelled: true, persisted: true });
  }
  await page.route(base + '/api/agent/orchestrate', route => route.fulfill({ status: 200,
    contentType: 'text/event-stream; charset=utf-8', body: 'event: text_delta\ndata: {"text":"已收到的部分材料。"}\n\n' }));
  await input.fill('断流验收');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.getByText('未收到完整结果', { exact: true }).waitFor();
  check(await input.isEnabled(), 'Unexpected EOF must release the composer');
  check((await page.locator('body').innerText()).includes('已收到的部分材料。'), 'Unexpected EOF must retain partial content');
  await page.unroute(base + '/api/agent/orchestrate');
  check(userWrites === 0, 'Never send verifier tasks to user backend');
  check(errors.length === 0, errors.join('\n'));
  return { passed: true, results, unexpectedEofHandled: true, userWrites, pageErrors: errors };
}
