// Run after previewing the real GitHub source in an isolated Skills page.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('skillFixture'));
  check(base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base) && !/:(3000|3001)$/.test(base), 'Isolated backend required');
  const requests = [], errors = [];
  page.on('request', request => { if (/^http:\/\/(localhost|127\.0\.0\.1):3001\//.test(request.url())) requests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  const list = async () => (await (await page.request.get(base + '/api/skills')).json()).skills;
  const before = await list();
  check(!before.some(skill => skill.name === 'last30days-cn'), 'Preview has not persisted a remote Skill');
  check(await page.getByLabel('名称', { exact: true }).inputValue() === 'last30days-cn', 'Real metadata must be used');
  const source = page.locator('summary').filter({ hasText: '来源文件 (105)' });
  await source.click();
  check(await page.getByText('scripts/last30days.py', { exact: false }).count() > 0, 'Script resource path must be retained');
  await source.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'output/playwright/skill-import-desktop.png' });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await source.scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile import must not overflow');
    await page.screenshot({ path: `output/playwright/skill-import-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '确认保存导入', exact: true }).click();
  await page.getByRole('heading', { name: 'Skill Package 草稿', exact: true }).waitFor({ state: 'hidden' });
  const saved = (await list()).find(skill => skill.name === 'last30days-cn');
  check(saved?.package?.files?.length === 105, 'All source entries persist, including omitted status');
  check(saved.package.files.filter(file => file.status === 'included').length === 104, '104 real files are retained');
  check(saved.package.source.complete === false, 'Large omitted attachment must not be marked complete');
  await page.reload();
  await page.getByRole('heading', { name: 'last30days-cn', exact: true }).waitFor();
  const after = (await list()).find(skill => skill.id === saved.id);
  check(JSON.stringify(after) === JSON.stringify(saved), 'Refresh must preserve the saved package');

  // Exercise unavailable-provider feedback through a transport failure, not a fabricated draft.
  await page.route('**/api/discovery/search', route => route.abort('failed'));
  await page.getByPlaceholder('输入关键词，例如 last30days agent research').fill('fixture search');
  await page.getByRole('button', { name: '搜索候选', exact: true }).click();
  await page.getByText('搜索失败：', { exact: false }).waitFor();
  check(await page.getByRole('button', { name: '搜索候选', exact: true }).isEnabled(), 'Failed search must clear busy state');
  check(await page.getByRole('heading', { name: 'Skill Package 草稿', exact: true }).count() === 0, 'Search failure cannot create a draft');
  await page.getByLabel('Skill 导入链接').fill('http://127.0.0.1/private');
  await page.getByRole('button', { name: '导入预览', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '未导入：' }).waitFor();
  check(await page.getByRole('button', { name: '导入预览', exact: true }).isEnabled(), 'Failed import must clear busy state');
  check((await list()).length === before.length + 1, 'Errors must not persist placeholders');
  check(requests.length === 0 && errors.length === 0, 'No user API access or page errors');
  return { status: 'passed', realRemotePreview: true, files: 105, included: 104, explicitSave: true, refreshPreserved: true, failureNoDraft: true, widths: [1440, 390, 320], userDataTouched: false };
}
