// Dedicated CLI browser with API fetch redirected to verify-request-limits.mjs --serve before navigation.
async page => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('rateFixture'));
  check(/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '') && !/:(3000|3001)$/.test(base), 'Isolated fixture required');
  const userRequests = [], posts = [], errors = [];
  page.on('request', request => {
    if (request.url().startsWith('http://127.0.0.1:3001/api/')) userRequests.push(request.url());
    if (request.url().startsWith(base + '/api/') && request.method() === 'POST') posts.push(request.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  const before = await page.evaluate(async base => (await fetch(base + '/api/workspaces')).json(), base);
  const input = page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '继续对话：中文限流草稿', exact: true }).click();
  await input.waitFor();
  const primed = await page.evaluate(async base => {
    const statuses = [];
    for (const path of ['/api/discovery/search', '/api/skills/search', '/api/unknown-one', '/api/unknown-two']) {
      statuses.push((await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tagent-request': '1' }, body: '{}' })).status);
    }
    return statuses;
  }, base);
  check(JSON.stringify(primed) === '[400,400,404,404]', 'Fixture quota was not fresh');
  const draft = '中文草稿 🚀 / Docker?\n保持原样，不自动重试。';
  await input.fill(draft); await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const existingError = page.getByText(/^本次未发送：.*秒后手动重试/);
  await existingError.waitFor();
  check(await input.inputValue() === draft, 'Existing-session draft was lost');
  check(await page.locator('[class*="messageAvatar"]').count() === 0, 'Rejected task left an invented chat message');
  async function capture(name, locator) {
    await locator.scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal overflow: ${name}`);
    const box = await locator.boundingBox(), size = page.viewportSize();
    check(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, `Clipped error: ${name}`);
    await page.screenshot({ path: `output/playwright/request-limits-${name}.png`, animations: 'disabled' });
  }
  await capture('existing-desktop', existingError);
  await page.getByRole('button', { name: '请求限制隔离验收', exact: true }).click();
  await input.fill('新对话草稿，不能丢失'); await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const newError = page.getByText(/^本次任务未发送：.*秒后手动重试/);
  await newError.waitFor();
  check(await input.inputValue() === '新对话草稿，不能丢失', 'New-session draft was lost');
  check(await page.locator('[class*="messageAvatar"]').count() === 0, 'Session creation failure invented a reply');
  check(posts.filter(url => url.endsWith('/api/agent/orchestrate')).length === 1, 'Session rejection started another task or auto-retried');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 640 });
    await capture(`new-${width}`, newError);
    const box = await input.boundingBox(), size = page.viewportSize();
    check(box && box.x >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, 'Composer clipped');
  }
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); });
  await capture('new-dark', newError);
  const after = await page.evaluate(async base => (await fetch(base + '/api/workspaces')).json(), base);
  check(JSON.stringify(before) === JSON.stringify(after), 'Rejected actions changed stored workspaces');
  check(userRequests.length === 0 && errors.length === 0, `Unexpected user API request or page error: ${JSON.stringify({ userRequests, errors })}`);
  console.log(JSON.stringify({ passed: true, existingSession: true, newSession: true, draftRetained: true,
    autoRetries: 0, taskAttempts: 1, serverWrites: 0, userRequests: 0, viewports: [1440, 390, 320] }));
}
