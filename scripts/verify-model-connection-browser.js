// Fresh CLI browser: /management/model?modelFixture=<base>&resetUrl=<URL>&repairUrl=<URL>&statsUrl=<URL>
async page => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const fixture = await page.evaluate(() => {
    const params = new URL(location.href).searchParams;
    const values = Object.fromEntries(['modelFixture', 'resetUrl', 'repairUrl', 'statsUrl'].map(key => [key, params.get(key)]));
    for (const value of Object.values(values)) {
      const url = new URL(value);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || ['3000', '3001'].includes(url.port)) throw new Error('Isolated loopback fixture required');
    }
    return values;
  });
  const errors = [], userWrites = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().startsWith('http://127.0.0.1:3001/api/') && request.method() !== 'GET') userWrites.push(request.url());
  });
  await page.addInitScript(base => {
    const native = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      return (url.origin === 'http://127.0.0.1:3001' || url.origin === location.origin) && url.pathname.startsWith('/api/')
        ? native(base + url.pathname + url.search, { ...init, credentials: 'omit' }) : native(input, init);
    };
  }, fixture.modelFixture);
  const calls = async () => (await (await page.request.get(fixture.statsUrl)).json()).calls;
  async function capture(path, target) {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox(), main = await page.getByRole('main').boundingBox();
    check(box && main && box.x >= main.x && box.x + box.width <= main.x + main.width + 1
      && box.y >= main.y && box.y + box.height <= main.y + main.height + 1, `Clipped target in ${path}`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal overflow in ${path}`);
    await page.screenshot({ path: `output/playwright/${path}.png`, animations: 'disabled' });
  }
  async function ready() {
    await page.getByRole('heading', { name: '当前部署配置', exact: true }).waitFor();
    await page.getByText('尚未运行连接测试。', { exact: true }).waitFor();
  }
  async function submit(captureConsent = false) {
    const before = await calls();
    await page.getByRole('button', { name: '连接测试预览', exact: true }).click();
    await page.getByRole('heading', { name: '测试内容与费用确认', exact: true }).waitFor();
    check(await calls() === before, 'Preview invoked a model');
    const button = page.getByRole('button', { name: '确认并测试', exact: true });
    check(await button.isDisabled(), 'Consent must not be preselected');
    if (captureConsent) {
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await capture(`model-connection-consent-${width}`, button);
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.getByRole('checkbox', { name: '我同意发送上述固定测试内容，并承担本次模型请求可能产生的费用。' }).check();
    await button.click();
    return before;
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const initial = await calls();
  await page.reload(); await ready();
  check(await calls() === initial, 'Opening the page invoked a model');
  const before = await submit(true);
  await page.getByText('已收到完整短回复', { exact: true }).waitFor();
  check(await calls() === before + 1, 'More than one model request');
  await capture('model-connection-desktop', page.getByText('已收到完整短回复', { exact: true }));
  await page.reload(); await page.getByText('已收到完整短回复', { exact: true }).waitFor();
  check(await calls() === before + 1, 'Refreshing re-ran the model');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await capture(`model-connection-${width}`, page.getByText('此次短请求成功，不保证后续任务、工具调用或联网调研可用。', { exact: true }));
  }
  const reset = await page.request.post(fixture.resetUrl, { data: { scenario: 'authentication' } }); check(reset.ok(), 'Fixture reset failed');
  await page.reload(); await ready(); await submit();
  await page.getByText(/模型服务认证失败/).waitFor();
  check(await page.getByRole('heading', { name: '模型连接', exact: true }).count() === 1, 'Provider 401 logged out the application');
  check(!(await page.locator('body').innerText()).includes('private-fixture-credential-body'), 'Private provider body exposed');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await capture('model-connection-auth-dark', page.getByText(/模型服务认证失败/));
  check(await page.locator('nav a[aria-current="page"] span').evaluate(element => getComputedStyle(element).color) === 'rgb(250, 250, 250)', 'Dark navigation did not settle to a readable color');
  check((await page.request.post(fixture.resetUrl, { data: { scenario: 'stalled' } })).ok(), 'Fixture reset failed');
  await page.reload(); await ready(); await submit();
  await page.getByRole('button', { name: '停止测试', exact: true }).click();
  await page.getByText('测试已停止', { exact: true }).waitFor();
  await page.getByText('尚未收到完整用量，费用待核对，不能当作零费用。', { exact: true }).waitFor();
  await capture('model-connection-cancel', page.getByText('尚未收到完整用量，费用待核对，不能当作零费用。', { exact: true }));
  check((await page.request.post(fixture.resetUrl, { data: { scenario: 'final-storage' } })).ok(), 'Fixture reset failed');
  await page.reload(); await ready(); const beforeSave = await submit();
  const unsaved = page.getByText('结果尚未保存，请保留此页面；重试保存不会再次调用模型。', { exact: true });
  await unsaved.waitFor();
  check(await page.getByRole('button', { name: '连接测试预览', exact: true }).isDisabled(), 'Unsaved result allowed another paid check');
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await page.getByText(/仍无法保存测试结果/).waitFor();
  check(await unsaved.count() === 1 && await calls() === beforeSave + 1, 'Failed save lost the result or repeated the model');
  await capture('model-connection-unsaved-320', page.getByRole('button', { name: '重试保存', exact: true }));
  check((await page.request.post(fixture.repairUrl)).ok(), 'Storage repair failed');
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await unsaved.waitFor({ state: 'detached' });
  await page.reload(); await page.getByText('已收到完整短回复', { exact: true }).waitFor();
  check(await calls() === beforeSave + 1, 'Save repair or refresh repeated the model');

  check((await page.request.post(fixture.resetUrl, { data: { scenario: 'success' } })).ok(), 'Fixture reset failed');
  await page.reload(); await ready();
  const testUrl = fixture.modelFixture + '/api/model-connection/test';
  await page.route(testUrl, async route => {
    const received = await route.fetch(); check(received.status() === 202, 'Lost-response fixture must first accept the request');
    await received.dispose(); await route.abort('failed');
  });
  const beforeLost = await submit();
  await page.getByText(/未能确认请求结果/).waitFor();
  check(await page.getByRole('button', { name: '连接测试预览', exact: true }).isDisabled(), 'Uncertain response allowed repeat submission');
  check(await page.getByRole('button', { name: '确认并测试', exact: true }).count() === 0, 'Old confirmation remained available');
  await page.unroute(testUrl);
  await capture('model-connection-response-lost-320', page.getByText(/未能确认请求结果/));
  await page.getByRole('button', { name: '刷新模型状态', exact: true }).click();
  await page.getByText('已收到完整短回复', { exact: true }).waitFor();
  check(await calls() === beforeLost + 1, 'Refreshing an uncertain response repeated the model');
  await page.getByRole('link', { name: '返回工作区', exact: true }).click();
  await page.getByRole('status', { name: '尚未开始任务', exact: true }).waitFor();
  check(await page.getByRole('status', { name: 'Agent status: busy', exact: true }).count() === 0, 'Empty workspace incorrectly reports an active agent');
  const connectionLink = page.getByRole('link', { name: '模型连接', exact: true });
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await capture(`model-connection-home-${width}`, connectionLink);
  }
  await connectionLink.click(); await page.getByRole('heading', { name: '模型连接', exact: true }).waitFor();
  check(await calls() === beforeLost + 1, 'Navigation invoked a model');
  check(errors.length === 0 && userWrites.length === 0, JSON.stringify({ errors, userWrites }));
  return { passed: true, fixtureOnly: true, scenarios: ['success', 'authentication', 'cancellation', 'storage-failure', 'lost-response'], manualConsent: true,
    readOnlyPreview: true, refreshNoReplay: true, widths: [1440, 390, 320], userWrites: 0, paidCalls: 0 };
}
