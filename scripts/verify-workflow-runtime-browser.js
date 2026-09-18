// Open /?workflowFixture=<base returned by verify-workflow-runtime.mjs --serve> in a dedicated CLI browser.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const taskAgents = await page.evaluate(() => new URL(location.href).searchParams.get('taskAgents') === '1');
  const base = await page.evaluate(() => {
    const fixture = new URL(location.href).searchParams.get('workflowFixture');
    if (!fixture) return null;
    const url = new URL(fixture);
    return { protocol: url.protocol, hostname: url.hostname, port: url.port, origin: url.origin };
  });
  check(!!base, 'Start the isolated runtime fixture and provide its base URL in workflowFixture');
  check(base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.port && !['3000', '3001'].includes(base.port), 'Only an isolated loopback fixture is allowed');
  const actualWrites = [];
  const pageOrigin = await page.evaluate(() => location.origin);
  const onRequest = request => { if ((request.url().startsWith('http://127.0.0.1:3001/api/') || request.url().startsWith(`${pageOrigin}/api/`)) && request.method() !== 'GET') actualWrites.push(request.url()); };
  page.on('request', onRequest);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  // Route only the API destination. Native fetch and its SSE body remain genuinely streaming.
  await page.addInitScript(fixtureBase => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if ((url.origin === 'http://127.0.0.1:3001' || url.origin === location.origin) && url.pathname.startsWith('/api/')) return nativeFetch(fixtureBase + url.pathname + url.search, { ...init, credentials: 'omit' });
      return nativeFetch(input, init);
    };
  }, base.origin);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.reload();
  const input = page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' });
  await input.waitFor();
  await page.evaluate(() => {
    window.__workflowObservation = [];
    window.__workflowObserver = new MutationObserver(() => {
      const drawer = document.querySelector('aside[aria-label="工作流看板"]');
      const running = document.querySelector('textarea')?.disabled;
      const count = drawer?.querySelectorAll('article').length || 0;
      if (running && count) window.__workflowObservation.push({ runId: drawer.dataset.runId, count });
    });
    window.__workflowObserver.observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  const pending = page.waitForResponse(response => response.url() === `${base.origin}/api/agent/orchestrate`);
  await input.fill(`工作流验收 ${Date.now()}：校对说明 alpha beta gamma。`);
  await input.press('Enter');
  const response = await pending;
  await page.waitForFunction(() => new Set(window.__workflowObservation.map(item => item.count)).size > 1);
  check(await input.isDisabled(), 'The close-during-run check needs an active task');
  await page.getByRole('button', { name: '收起工作流看板' }).click();
  const text = await response.text();
  const streamed = text.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const lines = block.split(/\r?\n/);
    return { type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(), data: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')) };
  });
  const complete = streamed.filter(event => event.type === 'complete');
  check(complete.length === 1 && complete[0].data.success, 'Fixture run did not reach exactly one successful terminal result');
  const trace = streamed.filter(event => event.type === 'workflow_event').map(event => event.data);
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
  check(!await page.getByRole('complementary', { name: '工作流看板' }).isVisible(), 'Later events reopened a manually closed drawer');
  await page.getByRole('button', { name: '展开工作流看板' }).click();
  const observation = await page.evaluate(() => { window.__workflowObserver.disconnect(); return window.__workflowObservation; });
  const counts = new Set(observation.filter(item => item.runId === trace[0].runId).map(item => item.count));
  check(counts.size > 1 && [...counts].some(count => count < trace.length), 'UI did not render incremental events while the actual SSE stream was running');
  const drawer = page.getByRole('complementary', { name: '工作流看板' });
  await page.getByRole('tab', { name: '实时流转' }).click();
  check(await drawer.locator('article').count() === trace.length, 'Realtime view does not match the SSE trace');
  for (const taskId of ['review-a', 'review-b']) {
    check(await drawer.locator(`article[data-task-id="${taskId}"]`).count() === trace.filter(event => event.taskId === taskId).length, `Realtime ownership mismatch: ${taskId}`);
  }
  await page.getByRole('tab', { name: '事件日志' }).click();
  check(await drawer.locator('[class*="eventRow"]').count() === trace.length, 'Log view disagrees with realtime trace');
  for (const taskId of ['review-a', 'review-b']) {
    check(await drawer.locator(`[class*="eventRow"][data-task-id="${taskId}"]`).count() === trace.filter(event => event.taskId === taskId).length, `Log ownership mismatch: ${taskId}`);
  }
  await page.getByRole('tab', { name: '静态架构' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length >= 7 && [...document.querySelectorAll('.react-flow__node')].every(node => Number(getComputedStyle(node).opacity) > 0));
  const viewport = () => page.locator('.react-flow__viewport').evaluate(element => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
  check(Math.abs((await viewport()).zoom - 1) < 0.01, 'Architecture must start at a readable scale');
  await page.screenshot({ path: 'output/playwright/workflow-readable-default.png', animations: 'disabled' });
  const cards = drawer.locator('[class*="graphAgentCard"]');
  check(await cards.count() === 2, 'Same resident must render two execution cards');
  const owners = await cards.evaluateAll(elements => elements.map(element => ({ taskId: element.dataset.taskId, agentId: element.dataset.agentId })));
  check(new Set(owners.map(item => item.agentId)).size === (taskAgents ? 2 : 1) && new Set(owners.map(item => item.taskId)).size === 2, 'Agent/task identities are conflated');
  for (const card of await cards.all()) {
    const nodeId = await card.evaluate(element => element.closest('.react-flow__node').dataset.id);
    await page.getByRole('combobox', { name: '定位架构节点' }).selectOption(nodeId);
    check(Math.abs((await viewport()).zoom - 1) < 0.01, 'Node navigation must restore readable scale');
    const readable = await card.evaluate(element => {
      const canvas = element.closest('[class*="flowCanvas"]').getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      const heading = element.querySelector('strong');
      return bounds.left >= canvas.left && bounds.right <= canvas.right &&
        Number.parseFloat(getComputedStyle(heading).fontSize) >= 13;
    });
    check(readable, 'Focused agent card is cropped or illegible');
    await card.locator('summary').click();
    check((await card.innerText()).includes('Skills 绑定'), 'Saved capability record is not available');
    await card.locator('summary').click();
  }
  const focusedViewport = await viewport();
  await page.getByRole('tab', { name: '事件日志' }).click();
  await page.getByRole('tab', { name: '静态架构' }).click();
  await page.waitForFunction(expected => {
    const element = document.querySelector('.react-flow__viewport');
    if (!element) return false;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return Math.abs(matrix.e - expected.x) < 1 && Math.abs(matrix.f - expected.y) < 1 && Math.abs(matrix.a - expected.zoom) < 0.01;
  }, focusedViewport);
  await page.getByRole('button', { name: '查看架构全景' }).click();
  await page.waitForFunction(() => Number.parseInt(document.querySelector('output[aria-label="架构缩放比例"]').textContent) < 100);
  check((await viewport()).zoom < 1, 'Explicit overview should fit the full long graph');
  const geometry = await drawer.evaluate(element => {
    const nodes = [...element.querySelectorAll('.react-flow__node')].map(node => ({ id: node.dataset.id, ...node.getBoundingClientRect().toJSON() }));
    const overlaps = [];
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y) overlaps.push([a.id, b.id]);
    }
    const edges = [...element.querySelectorAll('path[class*="workflowRelationPath"]')];
    const crossings = [];
    const inside = (point, node, margin = 1) => point.x > node.x + margin && point.x < node.right - margin && point.y > node.y + margin && point.y < node.bottom - margin;
    for (const edge of edges) {
      const length = edge.getTotalLength();
      const matrix = edge.getScreenCTM();
      const point = distance => edge.getPointAtLength(distance).matrixTransform(matrix);
      const endpoints = nodes.filter(node => inside(point(0), node, -2) || inside(point(length), node, -2));
      for (let distance = 3; distance < length; distance += 3) {
        const crossed = nodes.find(node => !endpoints.includes(node) && inside(point(distance), node));
        if (crossed) { crossings.push({ edge: edge.id, node: crossed.id }); break; }
      }
    }
    return { overlaps, crossings, edges: edges.length, visible: edges.filter(edge => edge.getTotalLength() > 0 && getComputedStyle(edge).stroke !== 'none').length,
      parents: [...element.querySelectorAll('g > title')].filter(title => title.textContent === '父子分工').length,
      dependencies: element.querySelectorAll('[class*="dependencyRelation"]').length };
  });
  check(!geometry.overlaps.length, `Overlapping cards: ${JSON.stringify(geometry.overlaps)}`);
  check(!geometry.crossings.length, `Edges cross unrelated cards: ${JSON.stringify(geometry.crossings)}`);
  check(geometry.edges > 0 && geometry.edges === geometry.visible && (taskAgents ? geometry.parents === 1 && geometry.dependencies === 0 : geometry.dependencies === 1), 'Default relations or task dependency are missing');
  const beforeEdit = await cards.allTextContents();
  const saved = await (await page.request.get(`${base.origin}/api/workspaces/${complete[0].data.workspaceId}/sessions/${complete[0].data.sessionId}`)).json();
  check(JSON.stringify(canonical(saved.messages.at(-1).traces)) === JSON.stringify(canonical(trace)),
    `Persisted workflow differs from SSE: stored=${saved.messages.at(-1).traces?.length}, streamed=${trace.length}, firstStored=${JSON.stringify(saved.messages.at(-1).traces?.[0])}, firstStreamed=${JSON.stringify(trace[0])}`);
  if (!taskAgents) await page.request.post(`${base.origin}/api/agents/${owners[0].agentId}/override`, { data: { skills: ['browser-later-edit'], mcpServers: [] } });
  const handle = await drawer.locator('[class*="resizeHandle"]').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 230);
  await page.mouse.down(); await page.mouse.move(handle.x - 160, handle.y + 230, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('aside[aria-label="工作流看板"]').getBoundingClientRect().width > 580);
  const bounds = await drawer.boundingBox();
  const main = await page.getByRole('main').boundingBox();
  check(main.x + main.width <= bounds.x + 1, 'Drawer overlays the conversation');
  const resize = page.getByRole('separator', { name: '调整工作流宽度' });
  await resize.focus(); await resize.press('Home');
  check(await resize.getAttribute('aria-valuenow') === '340', 'Keyboard resize minimum failed');
  await resize.press('End');
  check(await resize.getAttribute('aria-valuenow') === '680', 'Keyboard resize maximum failed');
  await page.screenshot({ path: 'output/playwright/workflow-task-instances-desktop.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1120, height: 900 });
  await page.waitForFunction(() => document.querySelector('main').getBoundingClientRect().width >= 359);
  check((await page.getByRole('main').boundingBox()).width >= 359, 'Wide drawer squeezes the conversation below its minimum');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.reload();
  await input.waitFor();
  await page.getByRole('button', { name: saved.title, exact: false }).click();
  await page.getByRole('button', { name: '展开工作流看板' }).click();
  await page.getByRole('tab', { name: '静态架构' }).click();
  await cards.first().waitFor();
  check(JSON.stringify(await cards.allTextContents()) === JSON.stringify(beforeEdit), 'Reload reflects edited hall settings rather than saved run capabilities');
  await page.getByRole('button', { name: '收起工作流看板' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开导航' }).waitFor();
  const mobileMain = await page.getByRole('main').boundingBox();
  check(mobileMain.y === 0 && mobileMain.height >= 840, 'Closed mobile navigation still consumes conversation height');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page overflows');
  const inputBounds = await input.boundingBox();
  check(inputBounds && inputBounds.y >= 0 && inputBounds.y + inputBounds.height <= 844, 'Composer is outside mobile viewport');
  await page.screenshot({ path: 'output/playwright/workflow-task-instances-mobile.png', animations: 'disabled' });
  await page.getByRole('button', { name: '打开导航' }).click();
  const navigation = page.getByRole('dialog', { name: '工作区导航' });
  await navigation.waitFor();
  check(await navigation.evaluate(element => {
    const header = document.querySelector('main > header');
    return Number(getComputedStyle(element).zIndex) > Number(getComputedStyle(header).zIndex) &&
      getComputedStyle(element).backgroundColor.startsWith('rgb(');
  }), 'Navigation is transparent or behind the conversation header');
  for (let step = 0; step < 30; step++) {
    await page.keyboard.press('Tab');
    check(await navigation.evaluate(element => element.contains(document.activeElement)), 'Mobile navigation leaks keyboard focus');
  }
  await page.keyboard.press('Escape');
  check(await page.getByRole('button', { name: '打开导航' }).evaluate(element => element === document.activeElement), 'Navigation did not restore trigger focus');
  await page.getByRole('button', { name: '打开导航' }).click();
  await navigation.getByRole('button', { name: saved.title, exact: false }).click();
  await navigation.waitFor({ state: 'hidden' });
  const mobileLayouts = [];
  for (const size of [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    await page.getByRole('button', { name: '展开工作流看板' }).click();
    const dialog = page.getByRole('dialog', { name: '工作流看板' });
    await dialog.waitFor();
    await dialog.getByRole('tab', { name: '静态架构' }).click();
    await dialog.getByRole('combobox', { name: '定位架构节点' }).selectOption('orchestrator');
    const layout = await dialog.evaluate(element => {
      const canvas = element.querySelector('[class*="flowCanvas"]').getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      const toolbar = element.querySelector('[class*="graphToolbar"]');
      const surface = element.querySelector('[class*="drawer"]');
      const header = document.querySelector('main > header');
      return { width: bounds.width, height: bounds.height, canvasHeight: canvas.height,
        overflow: document.documentElement.scrollWidth > innerWidth || toolbar.scrollWidth > toolbar.clientWidth,
        opaque: getComputedStyle(surface).backgroundColor.startsWith('rgb('),
        aboveConversation: Number(getComputedStyle(element).zIndex) > Number(getComputedStyle(header).zIndex),
        canvasBottom: canvas.bottom };
    });
    check(!layout.overflow && layout.canvasHeight >= 150 && layout.canvasBottom <= size.height, `Mobile workflow is unusable: ${JSON.stringify(layout)}`);
    check(layout.opaque && layout.aboveConversation, 'Mobile workflow is transparent or behind the conversation');
    for (let step = 0; step < 16; step++) {
      await page.keyboard.press('Tab');
      check(await dialog.evaluate(element => element.contains(document.activeElement)), 'Workflow dialog leaks keyboard focus');
    }
    await page.screenshot({ path: `output/playwright/workflow-dialog-${size.width}x${size.height}.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '展开工作流看板');
    check(await page.getByRole('button', { name: '展开工作流看板' }).evaluate(element => element === document.activeElement), 'Workflow did not restore trigger focus');
    mobileLayouts.push({ viewport: size, ...layout });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: '打开导航' }).waitFor();
  check(!await page.getByRole('dialog', { name: '工作区导航' }).isVisible(), 'Mobile refresh opened navigation by default');
  await page.getByRole('button', { name: '打开导航' }).click();
  await navigation.getByRole('button', { name: saved.title, exact: false }).click();
  await page.getByRole('button', { name: '打开导航' }).click();
  await navigation.getByRole('button', { name: '暗色模式', exact: false }).click();
  await page.screenshot({ path: 'output/playwright/navigation-mobile-dark.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '展开工作流看板' }).click();
  await page.getByRole('dialog', { name: '工作流看板' }).getByRole('tab', { name: '静态架构' }).click();
  await page.getByRole('combobox', { name: '定位架构节点' }).selectOption('orchestrator');
  await page.screenshot({ path: 'output/playwright/workflow-dialog-dark.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  check(actualWrites.length === 0, 'An acceptance task was sent to the user backend');
  check(errors.length === 0, `Page errors: ${errors.join('\n')}`);
  return { fixtureModel: true, nativeSSE: true, incrementalCounts: [...counts], events: trace.length, instances: owners,
    geometry, savedEqualsSSE: true, reloadSnapshotStable: true, readableScale: true, viewportRetained: true,
    mobileLayouts, focusContained: true, userWrites: actualWrites.length };
}
