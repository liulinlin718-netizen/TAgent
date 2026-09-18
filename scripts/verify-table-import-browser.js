// Run in a fresh playwright-cli browser with tableFixture/tableStatus query parameters.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const { base, statusUrl } = await page.evaluate(() => ({ base: new URL(location.href).searchParams.get('tableFixture'), statusUrl: new URL(location.href).searchParams.get('tableStatus') }));
  check(base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base) && !/:(3000|3001)$/.test(base), 'Use an isolated backend');
  check(statusUrl && /^http:\/\/127\.0\.0\.1:\d+\/fixture-status$/.test(statusUrl) && !/:(3000|3001)\//.test(statusUrl), 'Use an isolated model');
  const before = await (await page.request.get(statusUrl)).json();
  const workspaceBefore = await (await page.request.get(base + '/api/workspaces')).json();
  const errors = [], userRequests = [], taskPosts = [], importPosts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^http:\/\/(localhost|127\.0\.0\.1):3001\/api\//.test(request.url())) userRequests.push(request.url());
    if (request.method() === 'POST' && request.url().endsWith('/api/agent/orchestrate')) taskPosts.push(request.postDataJSON());
    if (request.method() === 'POST' && request.url().includes('/api/data/import/preview')) importPosts.push(request.url());
  });
  await page.addInitScript(fixture => {
    const native = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      return url.pathname.startsWith('/api/') ? native(fixture + url.pathname + url.search, { ...init, credentials: 'omit' }) : native(input, init);
    };
  }, base);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`http://127.0.0.1:3000/?tableFixture=${encodeURIComponent(base)}&tableStatus=${encodeURIComponent(statusUrl)}`);
  const composer = page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' });
  const previousDraft = `导入验收${before.calls}：保留旧草稿；仅分析提供的数据，不联网。`;
  await composer.fill(previousDraft);
  await page.getByRole('button', { name: '准备数据分析', exact: true }).click();
  const dialog = page.getByRole('dialog'), importer = dialog.getByRole('region', { name: '表格文件导入', exact: true });
  const materials = dialog.getByRole('textbox', { name: '数据、单位与统计口径', exact: true });
  const originalMaterial = '原有材料：收入单位为万元；按月份汇总，并比较2月对1月的变化率。';
  await materials.fill(originalMaterial);
  await dialog.getByRole('textbox', { name: '任务主题', exact: true }).fill('table-case-csv：月收入分析');
  const fileUrl = await page.evaluate(url => new URL('/table-import.xlsx', url).href, statusUrl);
  const bytes = await (await page.request.get(fileUrl)).body();
  const file = { name: '月收入-中文.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes };
  const chooseFile = payload => importer.getByLabel('选择表格文件', { exact: true }).setInputFiles(payload);
  const preview = async () => {
    const received = page.waitForResponse(response => response.url().includes(base + '/api/data/import/preview'));
    await importer.getByRole('button', { name: '读取预览', exact: true }).click();
    return (await received).json();
  };
  await chooseFile(file);
  check(importPosts.length === 0 && taskPosts.length === 0, 'Choosing a file must not upload or run');
  await importer.getByRole('button', { name: '移除文件', exact: true }).click();
  check(await materials.inputValue() === originalMaterial, 'Removing a file changed previous materials');
  const gbk = bytes.subarray(0, 7).map((_, index) => [0xc1, 0xd0, 0x0a, 0xd6, 0xd0, 0xce, 0xc4][index]);
  await chooseFile({ name: '错误编码.csv', mimeType: 'text/csv', buffer: gbk });
  await preview();
  await importer.getByRole('alert').waitFor();
  check((await importer.getByRole('alert').innerText()).includes('无法完整读取'), 'Invalid encoding must be a clear error');
  check(await importer.getByRole('combobox', { name: '工作表', exact: true }).count() === 0, 'Invalid file must not create partial preview');
  check(await materials.inputValue() === originalMaterial, 'Read failure changed previous materials');
  await importer.getByRole('combobox', { name: '文件编码', exact: true }).selectOption('gb18030');
  await preview(); await importer.getByRole('combobox', { name: '工作表', exact: true }).waitFor();
  check((await importer.getByRole('region', { name: '文件数据预览' }).innerText()).includes('中文'), 'Explicit GBK recovery failed');
  await chooseFile(file);
  const data = await preview();
  check(data.requiresConfirmation === true && data.willWrite === false && data.willExecute === false, 'Preview safety flags changed');
  await importer.getByRole('combobox', { name: '工作表', exact: true }).selectOption({ label: '月收入' });
  const confirm = importer.getByRole('button', { name: '确认添加到材料', exact: true });
  const acknowledgement = importer.getByRole('checkbox', { name: '我已核对范围、单位及已保存的公式结果', exact: true });
  check(await confirm.isDisabled(), 'Unchecked import must be disabled');
  await acknowledgement.check();
  await importer.getByRole('spinbutton', { name: '末行', exact: true }).fill('3');
  check(!await acknowledgement.isChecked() && await confirm.isDisabled(), 'Changing the range must invalidate confirmation');
  await importer.getByRole('spinbutton', { name: '末行', exact: true }).fill('4');
  await importer.getByRole('spinbutton', { name: '首列', exact: true }).fill('3');
  check(await confirm.count() === 0, 'Invalid range must not be accepted');
  await importer.getByRole('spinbutton', { name: '首列', exact: true }).fill('1');
  const readable = async locator => {
    await locator.scrollIntoViewIfNeeded();
    check(await locator.evaluate(element => {
      const box = element.getBoundingClientRect(); let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
      }
      return box.width > 0 && box.height > 0 && box.left >= left - 2 && box.right <= right + 2 && box.top >= top - 2 && box.bottom <= bottom + 2;
    }), 'Important import control is clipped');
  };
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await readable(importer.getByRole('combobox', { name: '工作表', exact: true }));
    await readable(importer.getByRole('region', { name: '文件数据预览', exact: true }));
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page overflows horizontally');
    await page.screenshot({ path: `output/playwright/table-import-${width}.png`, animations: 'disabled' });
    await readable(acknowledgement); await readable(confirm);
  }
  await acknowledgement.check(); await confirm.click();
  const prepared = await materials.inputValue();
  check(prepared.startsWith(originalMaterial + '\n\n'), 'Import overwrote previous materials');
  check(prepared.includes(data.file.sha256) && prepared.includes('A1:B4') && prepared.includes('月份,收入\n1月,0.1\n1月,0.2\n2月,0.6'), 'Imported scope, fingerprint or values changed');
  check(!prepared.includes('请选月收入工作表'), 'Unselected worksheet entered task materials');
  check(await importer.getByRole('combobox', { name: '工作表', exact: true }).count() === 0, 'Confirmed file preview should clear');
  // Hold a real response until after removal; the late request must not repopulate preview/materials.
  let release, arrived, completed;
  const held = new Promise(done => { release = done; }), started = new Promise(done => { arrived = done; }), delivered = new Promise(done => { completed = done; });
  const pattern = base + '/api/data/import/preview**';
  await page.route(pattern, async route => {
    const response = await route.fetch(); arrived(); await held;
    await route.fulfill({ response }).catch(() => {}); completed();
  }, { times: 1 });
  await chooseFile(file);
  await importer.getByRole('button', { name: '读取预览', exact: true }).click(); await started;
  await importer.getByRole('button', { name: '取消读取', exact: true }).click();
  await importer.getByRole('button', { name: '移除文件', exact: true }).click();
  release(); await delivered; await page.unroute(pattern);
  check(await materials.inputValue() === prepared && await importer.getByRole('combobox', { name: '工作表', exact: true }).count() === 0, 'Cancelled response changed material or reopened preview');
  await dialog.getByRole('button', { name: '预览任务', exact: true }).click();
  check(await dialog.getByRole('radio', { name: '保留原草稿，在末尾追加', exact: true }).isChecked(), 'Old draft must be preserved by default');
  await dialog.getByRole('button', { name: '填入草稿', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const message = await composer.inputValue();
  check(message.startsWith(previousDraft) && message.includes(prepared), 'Prepared task lost either draft or material');
  check(taskPosts.length === 0 && (await (await page.request.get(statusUrl)).json()).calls === before.calls, 'Preparing data started a model task');
  check(JSON.stringify(await (await page.request.get(base + '/api/workspaces')).json()) === JSON.stringify(workspaceBefore), 'Preview wrote workspace/session data');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const sent = page.waitForResponse(response => response.url() === base + '/api/agent/orchestrate');
  await composer.press('Enter');
  const stream = await (await sent).text();
  const events = stream.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const lines = block.split(/\r?\n/); return { type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(), data: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')) };
  });
  const terminal = events.filter(event => event.type === 'complete');
  check(terminal.length === 1 && terminal[0].data.persisted === true, 'Run did not finish and save once');
  const traces = events.filter(event => event.type === 'workflow_event').map(event => event.data);
  const receipts = traces.filter(event => event.data?.tableAnalysis).map(event => event.data.tableAnalysis);
  check(receipts.length === 2 && receipts[1].groups[0].metrics[0].value === '0.3' && receipts[1].comparison.percentChange === '100', 'Actual calculation does not match selected file data');
  const digest = await page.evaluate(async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, '0')).join(''), message);
  check(receipts[1].provenance.sourceSha256 === digest, 'Calculation did not bind actual prepared message');
  const result = terminal[0].data, workspaceId = workspaceBefore.workspaces[0].id;
  const session = await (await page.request.get(`${base}/api/workspaces/${workspaceId}/sessions/${result.sessionId}`)).json();
  check(session.messages[0].content === message && session.messages.at(-1).run.status !== 'running', 'Saved session lost imported data or terminal state');
  const panel = page.getByTestId('table-calculations').last(), aggregate = panel.locator('[data-calculation-action="aggregate"]');
  await panel.waitFor(); await panel.locator(':scope > summary').click(); await aggregate.locator(':scope > summary').click();
  await aggregate.getByRole('button', { name: '核对原文', exact: true }).click();
  await aggregate.getByLabel('匹配的原始表格', { exact: true }).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await aggregate.getByRole('button', { name: /下载\s*Excel/ }).click();
  const download = await downloadPromise; await download.saveAs('output/playwright/table-import-roundtrip.xlsx');
  check(await download.failure() === null, 'Excel download failed');
  await readable(aggregate.getByTestId('table-metric-value').first());
  await page.screenshot({ path: 'output/playwright/table-import-result.png', animations: 'disabled' });
  await page.reload();
  await page.getByRole('button', { name: session.title.replace(/\s+/g, ' ').trim() }).first().click();
  await panel.waitFor();
  const after = await (await page.request.get(statusUrl)).json();
  check(after.calls === before.calls + 8 && after.errors.length === 0 && taskPosts.length === 1, 'Unexpected model calls or fixture errors');
  check(errors.length === 0 && userRequests.length === 0, 'Browser error or request to user backend');
  console.log(JSON.stringify({ status: 'passed', importRequests: importPosts.length, localModelCalls: after.calls - before.calls, externalModelCalls: 0, selection: '月收入!A1:B4', persisted: true, download: 'output/playwright/table-import-roundtrip.xlsx', widths: [1440, 390, 320] }));
}
