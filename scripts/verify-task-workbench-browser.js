// Dedicated CLI browser at /?runFixture=<base from verify-office-runtime.mjs --serve>.
async page => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('runFixture'));
  check(/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '') && !/:(3000|3001)$/.test(base), 'Isolated office fixture required');
  const errors = [], posts = [], userWrites = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'GET' && request.url().startsWith('http://127.0.0.1:3001/api/')) userWrites.push(request.url());
    if (request.method() === 'POST' && request.url().startsWith(base + '/api/')) posts.push({ url: request.url(), body: request.postDataJSON() });
  });
  await page.addInitScript(fixture => {
    const native = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      return (url.origin === location.origin || url.origin === 'http://127.0.0.1:3001') && url.pathname.startsWith('/api/')
        ? native(fixture + url.pathname + url.search, { ...init, credentials: 'omit' }) : native(input, init);
    };
  }, base);
  const tasks = [
    ['调研报告', '已知信息或参考来源（选填）'], ['文档整理', '原文或工作记录'], ['数据分析', '数据、单位与统计口径'],
    ['项目计划', '目标、时间与可用资源'], ['沟通邮件', '沟通背景与必须传达的信息'], ['演示汇报', '汇报材料与已有结论'],
  ];
  const input = page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' });
  const material = 'office-case-pass：1月100万元，2月120万元，3月90万元。未提供成本或业务原因。';
  async function open(title) {
    const trigger = page.getByRole('button', { name: `准备${title}`, exact: true });
    await trigger.click(); const dialog = page.getByRole('dialog', { name: title, exact: true }); await dialog.waitFor(); return { dialog, trigger };
  }
  async function form(dialog, label, goal = '仅根据给定材料生成收入简报，不联网') {
    await dialog.getByLabel('任务主题', { exact: true }).fill(goal);
    await dialog.getByLabel(label, { exact: true }).fill(material);
    await dialog.getByRole('button', { name: '预览任务', exact: true }).click();
    await dialog.getByRole('heading', { name: '任务预览', exact: true }).waitFor();
    await dialog.getByRole('heading', { name: '任务预览', exact: true }).evaluate(element => {
      if (document.activeElement !== element) throw new Error('Preview heading did not receive focus');
    });
  }
  async function atWorkbenchTop() {
    const heading = page.getByRole('heading', { name: 'TAgent 办公任务', exact: true });
    await heading.waitFor();
    check(await heading.evaluate(element => {
      const viewport = element.closest('[class*=messages]');
      return viewport && viewport.scrollTop === 0 && element.getBoundingClientRect().top >= viewport.getBoundingClientRect().top;
    }), 'Empty conversation was scrolled to the bottom like a chat');
  }
  async function capture(name, locator) {
    await locator.scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow: ${name}`);
    const box = await locator.boundingBox(), viewport = page.viewportSize();
    check(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `Control clipped: ${name}`);
    await page.screenshot({ path: `output/playwright/task-workbench-${name}.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 320, height: 640 }); await page.reload();
  await atWorkbenchTop();
  await capture('home-short', page.getByRole('heading', { name: 'TAgent 办公任务', exact: true }));
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await atWorkbenchTop();
    await capture(`home-${width}`, page.getByRole('heading', { name: 'TAgent 办公任务', exact: true }));
  }
  check(!(await page.locator('body').innerText()).includes('Working Together.'), 'Marketing placeholder remains');
  await input.fill('  原草稿 😀，不要丢失。');
  for (const [title, label] of tasks) {
    const { dialog, trigger } = await open(title); await form(dialog, label, `准备${title}`);
    check(await dialog.getByRole('radio', { name: '保留原草稿，在末尾追加', exact: true }).isChecked(), 'Append must be the default');
    if (title === '调研报告') check((await dialog.locator('pre').first().innerText()).includes('近30天的最新信息'), 'Relative freshness scope missing');
    await dialog.getByRole('button', { name: '关闭任务准备', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    check(await input.inputValue() === '  原草稿 😀，不要丢失。', 'Cancelling modified the current draft');
    await trigger.evaluate(element => { if (document.activeElement !== element) throw new Error('Cancel did not restore trigger focus'); });
    check(posts.length === 0, 'Preparing or cancelling a task caused writes');
  }
  const missing = await open('文档整理');
  await missing.dialog.getByLabel('任务主题', { exact: true }).fill('文档');
  await missing.dialog.getByRole('button', { name: '预览任务', exact: true }).click();
  check(await missing.dialog.getByRole('heading', { name: '任务预览', exact: true }).count() === 0, 'Missing source material accepted');
  await page.keyboard.press('Escape'); await missing.dialog.waitFor({ state: 'hidden' });
  const append = await open('数据分析'); await form(append.dialog, tasks[2][1]);
  const prepared = await append.dialog.locator('pre').first().innerText();
  await append.dialog.getByRole('button', { name: '填入草稿', exact: true }).click(); await append.dialog.waitFor({ state: 'hidden' });
  check(await input.inputValue() === `  原草稿 😀，不要丢失。\n\n${prepared}`, 'Append lost original content');
  await input.evaluate(element => { if (document.activeElement !== element) throw new Error('Applying did not focus composer'); });
  check(posts.length === 0, 'Applying created a conversation or sent a task');
  const replace = await open('数据分析'); await form(replace.dialog, tasks[2][1]);
  await replace.dialog.getByRole('radio', { name: '替换原草稿', exact: true }).check();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await capture(`preview-${width}`, replace.dialog.getByRole('button', { name: '填入草稿', exact: true }));
  }
  await replace.dialog.getByRole('button', { name: '填入草稿', exact: true }).click(); await replace.dialog.waitFor({ state: 'hidden' });
  check(await input.inputValue() === prepared, 'Explicit replacement did not match the preview');
  check(posts.length === 0, 'Replacement caused a server write');
  await page.setViewportSize({ width: 320, height: 520 });
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('dialog', { name: '工作区导航', exact: true }).getByRole('button', { name: '研究助手：准备调研报告', exact: true }).click();
  const mobile = page.getByRole('dialog', { name: '调研报告', exact: true }); await mobile.waitFor();
  await page.getByRole('dialog', { name: '工作区导航', exact: true }).waitFor({ state: 'hidden' });
  await mobile.getByLabel('任务主题', { exact: true }).fill('近30天 AI Agent 最新进展');
  await capture('mobile-form', mobile.getByRole('button', { name: '预览任务', exact: true }));
  await form(mobile, tasks[0][1], '近30天 AI Agent 最新进展');
  await capture('mobile-preview-short', mobile.getByRole('button', { name: '填入草稿', exact: true }));
  await mobile.getByRole('button', { name: '返回修改', exact: true }).click();
  check(await mobile.getByRole('textbox', { name: '已知信息或参考来源（选填）', exact: true }).inputValue() === material, 'Returning to form lost material');
  await mobile.getByLabel('任务主题', { exact: true }).evaluate(element => {
    if (document.activeElement !== element) throw new Error('Returning to form lost focus');
  });
  await page.keyboard.press('Escape'); await mobile.waitFor({ state: 'hidden' });
  check(await input.inputValue() === prepared, 'Mobile cancellation lost prepared task');
  check(posts.length === 0, 'Mobile selection caused writes');

  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('dialog', { name: '工作区导航', exact: true }).getByRole('button', { name: /暗色模式/ }).click();
  await page.keyboard.press('Escape');
  const dark = await open('数据分析'); await form(dark.dialog, tasks[2][1]);
  await capture('preview-dark-short', dark.dialog.getByRole('button', { name: '填入草稿', exact: true }));
  await page.keyboard.press('Escape'); await dark.dialog.waitFor({ state: 'hidden' });
  check(await input.inputValue() === prepared && posts.length === 0, 'Theme or dark preview changed the draft or sent requests');
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('dialog', { name: '工作区导航', exact: true }).getByRole('button', { name: /亮色模式/ }).click();
  await page.keyboard.press('Escape');

  const resultPromise = page.waitForResponse(response => response.url() === base + '/api/agent/orchestrate' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const response = await resultPromise; check(response.ok(), 'Prepared task was rejected');
  const eventText = await response.text();
  const events = eventText.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const lines = block.split(/\r?\n/); return { type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(),
      data: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')) };
  });
  const final = events.find(event => event.type === 'complete')?.data;
  check(final?.persisted && final.deliveryReview?.status === 'passed' && final.output.includes('合计310万元'), 'Office task did not finish with a saved checked report');
  check(events.filter(event => event.type === 'complete').length === 1, 'Duplicate final event');
  check(posts.filter(item => item.url.endsWith('/api/agent/orchestrate')).length === 1, 'Not exactly one explicitly sent task');
  check(posts.find(item => item.url.endsWith('/api/agent/orchestrate')).body.message === prepared, 'Actual request differs from preview');
  await page.getByText(/材料中的月收入为100、120、90万元，合计310万元/).first().waitFor();
  const saved = await (await page.request.get(`${base}/api/workspaces/${final.workspaceId}/sessions/${final.sessionId}`)).json();
  check(saved.messages[0].content === prepared && saved.messages.at(-1).content === final.output, 'Saved input or output changed');
  const beforeReload = posts.length;
  await page.reload(); await atWorkbenchTop();
  const recent = page.getByRole('button', { name: `继续对话：${saved.title}`, exact: true }).first(); await recent.waitFor();
  const selectedResponse = page.waitForResponse(result => result.url() === `${base}/api/workspaces/${final.workspaceId}/sessions/${final.sessionId}`);
  await recent.click(); check((await selectedResponse).ok(), 'Recent navigation did not select the just-saved session');
  await page.getByText(/材料中的月收入为100、120、90万元，合计310万元/).first().waitFor();
  check(posts.length === beforeReload, 'Recent navigation or refresh re-sent a task');
  check(errors.length === 0 && userWrites.length === 0, JSON.stringify({ errors, userWrites }));
  return { passed: true, tasks: 6, explicitSend: 1, nativeSSE: true, savedReport: true, draftPreserved: true,
    widths: [1440, 390, 320], paidCalls: 0, userWrites: 0 };
}
