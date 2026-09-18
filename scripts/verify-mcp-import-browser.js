// UI acceptance uses explicit inline configuration through the real backend parser.
// Public GitHub/npm/Registry metadata acceptance is scripts/verify-mcp-import.mts.
// Run after fixtures/mcp-management-browser.js in a fresh isolated CLI browser.
async (page) => {
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('mcpFixture'));
  if (!base || /:(3000|3001)$/.test(base)) throw new Error('Isolated backend required');
  const before = await (await page.request.get(`${base}/api/mcp`)).json();
  if (before.servers.length) throw new Error('Start with an empty isolated MCP registry');
  const fixtureSource = 'https://fixture.example/mcp-config.json';
  const fixtureText = JSON.stringify({ mcpServers: {
    'Filesystem fixture': { command: 'npx', args: ['-y', '@fixture/filesystem', '/path/to/allowed/directory'] },
    'Remote fixture': { type: 'http', url: 'https://mcp.example/mcp' },
  } });
  await page.route('**/api/mcp/import/preview', route => {
    const input = route.request().postDataJSON();
    return input.source === fixtureSource ? route.continue({ postData: JSON.stringify({ text: fixtureText, choiceId: input.choiceId }) }) : route.continue();
  });
  await page.getByPlaceholder('搜索 MCP，例如 filesystem、github、browser').fill('filesystem');
  await page.getByRole('button', { name: '搜索候选', exact: true }).click();
  await page.getByRole('button', { name: '搜索候选', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.trim() === '搜索候选' && !button.disabled), undefined, { timeout: 70000 });
  if (await page.getByRole('heading', { name: 'MCP Server 草稿' }).count()) throw new Error('Search created a draft');
  const sources = await page.getByRole('article').count();
  if (!sources) throw new Error('No discovery results');
  await page.getByPlaceholder('输入 GitHub URL、普通 URL 或 npm 包名').fill(fixtureSource);
  await page.getByRole('button', { name: '导入预览', exact: true }).last().click();
  await page.getByRole('region', { name: '选择 MCP 配置' }).waitFor({ timeout: 45000 });
  const options = page.getByRole('region', { name: '选择 MCP 配置' }).getByRole('article');
  const npx = options.filter({ hasText: '"npx"' }).first();
  if (!await npx.count()) throw new Error('Cannot distinguish npx from Docker configurations');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('region', { name: '选择 MCP 配置' }).screenshot({ path: 'output/playwright/mcp-import-choices.png' });
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/mcp/import/preview'));
  await npx.getByRole('button', { name: '预览配置' }).click();
  const preview = await (await responsePromise).json();
  if (!preview.candidate || preview.willExecute !== false || preview.willWrite !== false || !preview.requiresConfirmation) throw new Error('Invalid import safety contract');
  await page.getByRole('heading', { name: 'MCP Server 草稿' }).waitFor();
  if (JSON.stringify(await (await page.request.get(`${base}/api/mcp`)).json()) !== JSON.stringify(before)) throw new Error('Preview wrote configuration');
  const saveBlocked = page.waitForResponse(response => response.url() === `${base}/api/mcp` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '确认保存配置' }).click();
  if ((await saveBlocked).status() !== 400) throw new Error('Missing inputs were not blocked');
  for (const requirement of preview.candidate.requirements || []) {
    if (requirement.required && requirement.location === 'arg') await page.getByRole('textbox', { name: `参数 ${Number(requirement.key) + 1}`, exact: true }).fill('C:/Office Fixture/Allowed');
  }
  await page.getByText('导入来源', { exact: false }).click();
  const editor = page.locator('section').filter({ has: page.getByRole('heading', { name: 'MCP Server 草稿' }) });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error(`Overflow at ${width}`);
    await editor.screenshot({ path: `output/playwright/mcp-import-editor-${width}.png` });
    await editor.evaluate(element => { const main = element.closest('main'); if (main) main.scrollTop += element.getBoundingClientRect().top - main.getBoundingClientRect().top - 16; });
    await page.screenshot({ path: `output/playwright/mcp-import-start-${width}.png` });
    await page.getByRole('button', { name: '确认保存配置' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `output/playwright/mcp-import-save-${width}.png` });
  }
  const savedResponse = page.waitForResponse(response => response.url() === `${base}/api/mcp` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '确认保存配置' }).click();
  const saved = await (await savedResponse).json();
  if (!saved.id || saved.executionApproved !== false || saved.source?.kind !== 'inline' || !saved.source?.contentHash) throw new Error('Save lost provenance or auto-approved execution');
  await page.getByText(`已保存 MCP Server：${saved.name}`, { exact: false }).waitFor();
  await page.getByRole('heading', { name: 'MCP Server 草稿' }).waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByRole('button', { name: '配置', exact: true }).click();
  if ((await page.getByRole('textbox', { name: '参数 3', exact: true }).inputValue()) !== 'C:/Office Fixture/Allowed') throw new Error('Argument did not survive refresh');
  await page.getByRole('button', { name: '关闭编辑器' }).click();
  const testResponse = page.waitForResponse(response => response.url() === `${base}/api/mcp/${saved.id}/test`);
  await page.getByRole('button', { name: '测试', exact: true }).click();
  const test = await (await testResponse).json();
  if (test.status !== 'preview_only' || test.willExecute !== false || test.willWrite !== false) throw new Error('stdio test unexpectedly executed or wrote');
  await page.getByText('stdio 测试仅预览配置', { exact: false }).waitFor();
  const removed = await page.request.delete(`${base}/api/mcp/${saved.id}`, { headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' } });
  if (!removed.ok()) throw new Error('Fixture cleanup failed');
  await page.unroute('**/api/mcp/import/preview');
  return { sources, choices: preview.choices.length, importMode: 'inline-fixture', imported: saved.id, missingInputsBlocked: true, reloadVerified: true, autoExecution: false, userDataTouched: false };
}
