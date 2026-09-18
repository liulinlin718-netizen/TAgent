// Use a fresh CLI browser redirected to verify-office-runtime.mjs --serve, then take a snapshot.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const base = await page.evaluate(() => {
    const value = new URL(location.href).searchParams.get('officeFixture');
    if (!value) return null;
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && !['3000', '3001'].includes(url.port) ? url.origin : null;
  });
  check(base, 'An isolated office fixture is required');
  const errors = [], mutations = [], userRequests = [], downloads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^http:\/\/(localhost|127\.0\.0\.1):3001\/api\//.test(request.url())) userRequests.push(request.url());
    if (request.url().startsWith(base + '/api/') && request.method() !== 'GET') mutations.push(request.url());
  });
  page.on('download', value => downloads.push(value));
  const before = await (await page.request.get(base + '/api/workspaces')).text();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  const select = async mode => {
    const openNavigation = page.getByRole('button', { name: '展开导航', exact: true });
    if (await openNavigation.isVisible()) await openNavigation.click();
    await page.getByRole('button', { name: new RegExp(`^office-case-${mode}：`) }).click();
    await page.getByTestId('report-export').last().waitFor();
  };
  const save = async name => {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载 Word', exact: true }).last().click();
    const downloaded = await pending;
    check(downloaded.suggestedFilename().endsWith('.docx'), 'Not a Word download');
    await downloaded.saveAs(`output/playwright/word-${name}.docx`);
    check(await downloaded.failure() === null, 'Browser download failed');
    await page.getByText('已交给浏览器下载', { exact: true }).waitFor();
  };
  for (const mode of ['export', 'failed', 'malformed']) {
    await select(mode);
    if (mode === 'export') {
      check((await page.locator('article tbody td').allTextContents()).includes('甲|乙'), 'Escaped table content was lost on screen');
      check(await page.locator('article ol[start="3"] > li > ul > li > ul input[checked]').count() === 1, 'Nested tasks were flattened on screen');
      check(await page.getByRole('heading', { name: '来源注释', exact: true }).count() === 1, 'Footnote content is missing');
      await page.getByRole('heading', { name: '三 后续行动', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'output/playwright/word-markdown-structure.png', animations: 'disabled' });
    }
    check(await page.getByRole('button', { name: '下载 Word', exact: true }).count() === 1, 'User message must not have a Word export');
    await save(mode);
  }
  await page.reload();
  await select('export');
  check(await page.getByRole('button', { name: '下载 Word', exact: true }).isEnabled(), 'History export unavailable after reload');
  // A local file-generation error must leave manual retry available without a model call.
  await page.evaluate(() => {
    const original = URL.createObjectURL;
    URL.createObjectURL = function (...args) { URL.createObjectURL = original; throw new Error('本机下载创建失败（验收）'); };
  });
  await page.getByRole('button', { name: '下载 Word', exact: true }).click();
  await page.getByText('本机下载创建失败（验收）', { exact: true }).waitFor();
  await save('retry');
  // Hold the actual digest, change conversations, then ensure no stale download is delivered.
  await page.evaluate(() => {
    const original = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      crypto.subtle.digest = original;
      const result = await original(...args);
      await new Promise(resolve => { window.__releaseWordDigest = resolve; });
      return result;
    };
  });
  const count = downloads.length;
  await page.getByRole('button', { name: '下载 Word', exact: true }).click();
  await page.waitForFunction(() => typeof window.__releaseWordDigest === 'function');
  await select('pass');
  await page.evaluate(() => window.__releaseWordDigest());
  check(await page.getByRole('button', { name: '下载 Word', exact: true }).isEnabled(), 'New conversation inherited old pending state');
  await select('export');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
    const collapse = page.getByRole('button', { name: '收起工作流看板', exact: true });
    if (await collapse.isVisible()) await collapse.click();
    const button = page.getByRole('button', { name: '下载 Word', exact: true });
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    check(box && box.x >= 0 && box.x + box.width <= width, 'Download button clipped');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal page overflow');
    await page.screenshot({ path: `output/playwright/word-download-${width}.png`, animations: 'disabled' });
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: 'output/playwright/word-download-dark.png', animations: 'disabled' });
  check(downloads.length === count, 'A cancelled export downloaded after changing conversations');
  await save('mobile');
  check((await (await page.request.get(base + '/api/workspaces')).text()) === before, 'Export mutated persisted conversations');
  check(mutations.length === 0, 'Export called a mutating or model API');
  check(errors.length === 0, `Page errors: ${errors.join('; ')}`);
  check(userRequests.length === 0, 'Browser touched user backend');
  return { downloads: downloads.length, history: true, retry: true, cancelledOnSwitch: true, widths: [1440, 390, 320], userRequests: 0, mutations: 0 };
}
