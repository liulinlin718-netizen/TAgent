// Continue the isolated management browser fixture; this only lists public MCP tools.
async page => {
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('mcpFixture'));
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || /:(3000|3001)$/.test(base)) throw new Error('Isolated fixture required');
  const editor = page.locator('[class*="editorPanel"]').filter({ has: page.getByRole('heading', { name: '编辑 MCP Server', exact: true }) });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await editor.screenshot({ path: `output/playwright/mcp-editor-${width}.png` });
  }
  await page.getByRole('button', { name: '关闭编辑器', exact: true }).click();
  await page.getByRole('button', { name: '添加 Server', exact: true }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('DeepWiki 公开连接验收');
  await page.getByRole('combobox', { name: '类型', exact: true }).selectOption('http');
  await page.getByRole('textbox', { name: 'URL', exact: true }).fill('https://mcp.deepwiki.com/mcp');
  const create = page.waitForResponse(response => response.url() === base + '/api/mcp' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存 Server', exact: true }).click();
  const saved = await (await create).json();
  if (!saved.id) throw new Error('Public fixture config not saved');
  const card = page.locator('[class*="serverCard"]').filter({ has: page.getByRole('heading', { name: 'DeepWiki 公开连接验收', exact: true }) });
  const response = page.waitForResponse(response => response.url().endsWith(`/${saved.id}/test`), { timeout: 40000 });
  await card.getByRole('button', { name: '测试', exact: true }).click();
  const result = await (await response).json();
  if (!result.ok || !result.tools.some(tool => tool.name === 'read_wiki_structure')) throw new Error(JSON.stringify(result));
  await page.getByText('read_wiki_structure', { exact: true }).waitFor();
  await page.getByText('read_wiki_structure', { exact: true }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('[class*="testResult"]').screenshot({ path: `output/playwright/mcp-connected-${width}.png` });
  }
  return { status: 'passed', tools: result.tools.map(tool => tool.name), toolCalls: 0, userDataTouched: false };
}
