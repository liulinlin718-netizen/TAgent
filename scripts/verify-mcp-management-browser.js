// Use the isolated MCP fixture bootstrap, then open Add Server before running.
async (page) => {
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('mcpFixture'));
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || /:(3000|3001)$/.test(base)) throw new Error('Isolated fixture required');
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('浏览器 MCP 验收');
  await page.getByRole('textbox', { name: '命令', exact: true }).fill('fixture-no-execution');
  for (const [index, value] of ['C:/Office Files/report.txt', '--token', 'browser-secret-arg'].entries()) {
    await page.getByRole('button', { name: '添加参数', exact: true }).click();
    await page.getByRole('textbox', { name: `参数 ${index + 1}`, exact: true }).fill(value);
  }
  await page.getByRole('button', { name: '添加环境变量', exact: true }).click();
  await page.getByRole('textbox', { name: '环境变量名称 1' }).fill('OFFICE_KEY');
  await page.getByLabel('环境变量值 1').fill('browser-secret-env');
  const createResponse = page.waitForResponse(response => response.url() === base + '/api/mcp' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存 Server', exact: true }).click();
  const created = await (await createResponse).json();
  check(created.id && !JSON.stringify(created).includes('browser-secret'), 'Create response leaked credentials or failed');
  check(created.args[0] === 'C:/Office Files/report.txt' && created.executionApproved === false, 'Argument boundary or approval changed');
  await page.getByRole('heading', { name: '浏览器 MCP 验收', exact: true }).waitFor();
  await page.reload();
  let card = page.locator('[class*="serverCard"]').filter({ has: page.getByRole('heading', { name: '浏览器 MCP 验收', exact: true }) });
  await card.getByRole('button', { name: '测试', exact: true }).click();
  await page.getByText(/stdio 测试仅预览配置/).waitFor();
  await card.getByRole('button', { name: '执行授权', exact: true }).click();
  const approval = page.waitForResponse(response => response.url().endsWith('/approval') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '确认授权任务调用' }).click();
  check((await (await approval).json()).executionApproved === true, 'Explicit approval not saved');
  await card.getByRole('button', { name: '配置', exact: true }).click();
  check(await page.getByRole('textbox', { name: '参数 1', exact: true }).inputValue() === 'C:/Office Files/report.txt', 'Argument lost on edit');
  check(await page.getByLabel('环境变量值 1').inputValue() === '', 'Stored env exposed in input');
  check(await page.getByRole('textbox', { name: '参数 3', exact: true }).inputValue() === '[saved-secret]', 'Secret argument exposed');
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('浏览器 MCP 已编辑');
  const update = page.waitForResponse(response => response.url().endsWith('/' + created.id) && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存 Server', exact: true }).click();
  check((await (await update).json()).executionApproved === false, 'Editing did not revoke execution approval');
  await page.getByRole('heading', { name: '浏览器 MCP 已编辑', exact: true }).waitFor();
  await page.route('**/api/discovery/search', route => route.abort());
  await page.getByPlaceholder('搜索 MCP，例如 filesystem、github、browser').fill('filesystem');
  await page.getByRole('button', { name: '搜索候选', exact: true }).click();
  await page.getByText('联网搜索请求失败，请检查后端和网络后重试。', { exact: true }).waitFor();
  check(await page.getByRole('button', { name: '搜索候选', exact: true }).isEnabled(), 'Search stayed busy after failure');
  check(await page.getByRole('heading', { name: 'MCP Server 草稿', exact: true }).count() === 0, 'Search opened editor');
  await page.unroute('**/api/discovery/search');
  card = page.locator('[class*="serverCard"]').filter({ has: page.getByRole('heading', { name: '浏览器 MCP 已编辑', exact: true }) });
  await card.getByRole('button', { name: '配置', exact: true }).click();
  const sizes = [];
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole('heading', { name: '编辑 MCP Server' }).scrollIntoViewIfNeeded();
    const bounds = await page.evaluate(() => ({ view: innerWidth, scroll: document.documentElement.scrollWidth }));
    check(bounds.scroll <= bounds.view + 1, `Horizontal overflow at ${width}`);
    await page.screenshot({ path: `output/playwright/mcp-management-${width}.png`, fullPage: true });
    sizes.push(bounds);
  }
  return { saved: created.id, secretsRedacted: true, separateApproval: true, argumentSpacesPreserved: true, searchFailureRecovered: true, sizes, userDataTouched: false };
}
