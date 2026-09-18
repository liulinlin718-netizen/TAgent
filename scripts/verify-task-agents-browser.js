// Run after scripts/fixtures/task-agent-browser.js in the isolated CLI browser.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('taskFixture'));
  check(base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base) && !/:(3000|3001)$/.test(base), 'Isolated backend required');
  const errors = [], userRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^http:\/\/(localhost|127\.0\.0\.1):3001\/api\//.test(request.url())) userRequests.push(request.url()); });
  const list = async () => (await (await page.request.get(base + '/api/agents')).json()).agents;
  const agents = await list();
  const source = agents.find(agent => agent.type === 'task_spawned' && agent.spawnMeta.status === 'completed' && agent.spawnMeta.depth === 1);
  check(source, 'Completed task from the real isolated runtime is required');
  const residentCount = agents.filter(agent => agent.type === 'resident').length;
  await page.getByRole('button', { name: /^常驻 Agent/ }).click();
  check(await page.locator('.recharts-radar').count() >= 6, 'Resident radar scores remain available');
  await page.getByRole('button', { name: /^任务子 Agent/ }).click();
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: source.name, exact: true }) }).first();
  check((await card.innerText()).includes('执行完成'), 'Execution status must come from the runtime');
  check((await card.innerText()).includes(source.spawnMeta.sessionId), 'Source session must remain visible');
  await card.getByText('执行记录与输出', { exact: true }).click();
  check((await card.locator('pre').innerText()) === source.spawnMeta.result.output, 'Full persisted output must be inspectable');
  check((await card.innerText()).includes('尚未独立核对'), 'Execution success must not imply independent quality verification');
  const side = page.getByRole('complementary', { name: 'Skills 快速绑定库' });
  const sideBox = await side.boundingBox(), cardBox = await card.boundingBox();
  check(sideBox.x >= cardBox.x + cardBox.width, 'Skills sidebar must not overlap a task card');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'output/playwright/task-agents-desktop.png' });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await card.locator('summary').scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Task output must fit mobile width');
    await page.screenshot({ path: `output/playwright/task-agents-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await card.getByRole('button', { name: '保存到大厅', exact: true }).click();
  await page.getByRole('heading', { name: '新建 Agent Card', exact: true }).waitFor();
  check((await list()).filter(agent => agent.type === 'resident').length === residentCount, 'Preview must not create a resident');
  const name = `子 Agent 运行沉淀-${Date.now()}`;
  await page.getByLabel('名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '保存 Agent', exact: true }).click();
  await page.getByRole('heading', { name: '新建 Agent Card', exact: true }).waitFor({ state: 'hidden' });
  const saved = (await list()).find(agent => agent.name === name);
  check(saved?.type === 'resident' && saved.id !== source.id, 'Explicit confirmation creates a separate resident');
  check(JSON.stringify(saved.constraints) === JSON.stringify(source.constraints), 'Promotion must preserve the inherited permissions and budget');
  await page.reload();
  await page.getByRole('heading', { name, exact: true }).waitFor();
  await page.getByRole('button', { name: /^任务子 Agent/ }).click();
  check(await card.getByRole('button', { name: '已沉淀', exact: true }).isDisabled(), 'Source retains the promotion link after refresh');
  await card.getByText('执行记录与输出', { exact: true }).click();
  check((await card.locator('pre').innerText()) === source.spawnMeta.result.output, 'Promotion must not change the historical output');
  check(errors.length === 0, errors.join('\n')); check(userRequests.length === 0, 'User backend must not be accessed');
  return { status: 'passed', sourceId: source.id, savedId: saved.id, previewNoSave: true, historyPreserved: true,
    fullOutput: true, residentRadar: true, skillsNoOverlap: true, widths: [1440, 390, 320], userRequests: 0 };
}
