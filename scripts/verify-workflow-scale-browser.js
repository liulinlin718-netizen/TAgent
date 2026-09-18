// Run in a dedicated browser against a production web build. All API requests are intercepted.
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const sampleFrames = () => page.evaluate(async () => {
    const frames = []; let last, start;
    await new Promise(resolve => {
      const frame = now => { start ??= now; if (last !== undefined) frames.push(now - last); last = now;
        if (now - start < 2000) requestAnimationFrame(frame); else resolve(); };
      requestAnimationFrame(frame);
    });
    const sorted = frames.toSorted((a, b) => a - b);
    const meanMs = frames.reduce((a, b) => a + b, 0) / frames.length;
    const p95Ms = sorted[Math.floor(sorted.length * .95)];
    return { frames: frames.length, meanMs, p95Ms, near60Fps: meanMs <= 17.5 && p95Ms <= 20 };
  });
  const baseline = await page.evaluate(() => new URL(location.href).searchParams.has('baseline'));
  const motionPixels = () => page.locator('canvas[class*="workflowMotionCanvas"]').evaluate(canvas => {
    // Read a copy so repeated assertions do not switch the application's canvas to CPU rendering.
    const copy = document.createElement('canvas');
    copy.width = canvas.width; copy.height = canvas.height;
    const context = copy.getContext('2d', { willReadFrequently: true });
    context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let count = 0, checksum = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index]) count++;
      checksum = (checksum + pixels[index] * index) % 2147483647;
    }
    return { count, checksum, correctResolution: canvas.width === Math.round(canvas.clientWidth * devicePixelRatio)
      && canvas.height === Math.round(canvas.clientHeight * devicePixelRatio) };
  });
  const waitForMotion = async visible => {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (((await motionPixels()).count > 0) === visible) return;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    throw new Error(`Motion did not become ${visible ? 'visible' : 'empty'}`);
  };
  const trace = [];
  const wsId = 'ws-scale', sessionId = 'sess-scale', runId = 'run-scale';
  const timestamp = '2026-09-13T00:00:00.000Z';
  const tasks = Array.from({ length: 72 }, (_, index) => ({ id: `task-${index}`, agentRole: 'document', objective: `核对第 ${index + 1} 组办公材料`, dependsOn: index ? [`task-${index - 1}`] : [] }));
  function event(type, task, data = {}, extra = {}) {
    const agentId = task ? `office-${Number(task.id.split('-')[1]) % 3}` : 'orchestrator';
    trace.push({ type, eventId: `event-${trace.length}`, runId, sessionId, timestamp: Date.parse(timestamp) + trace.length * 1000,
      agentId, taskId: task?.id, summary: `${type} ${task?.objective || '任务总览'}`, status: type.endsWith('complete') || type.endsWith('result') ? 'complete' : 'running',
      data: { ...data, agentId }, ...extra });
  }
  event('task_decomposition', null, { tasks });
  for (const task of tasks) {
    const agentId = `office-${Number(task.id.split('-')[1]) % 3}`;
    event('agent_spawn', task, { objective: task.objective, agentName: '材料核对助手' }, { parentAgentId: 'orchestrator', agentSnapshot: {
      version: 1, capturedAt: Date.parse(timestamp), id: agentId, name: '材料核对助手', description: '核对材料并生成交接说明', role: 'document', type: 'resident', icon: 'D', parentAgentId: null,
      capabilities: { skills: ['office-review'], tools: ['read_url', 'read_skill_file'], mcpServers: [] },
      constraints: { allowedTools: ['read_url', 'read_skill_file'], allowedDomains: [], maxCostPerTask: 0.2, maxFissionDepth: 2, approvalMode: 'suggest' },
      card: { responsibilities: ['核对材料'], boundaries: ['只读'], qualityChecks: ['标记未知信息'], outputStandards: ['来源与交接说明'] },
    } });
    for (let index = 0; index < 20; index++) {
      const tool = index % 2 ? 'read_url' : 'read_skill_file';
      event('agent_tool_call', task, { tool }, { toolName: tool });
      event('agent_tool_result', task, { tool, resultLength: 400 }, { toolName: tool, resultLength: 400 });
    }
    event('governance', task, { result: 'passed', message: '已核对权限' }, { status: 'passed' });
    event('agent_complete', task, { success: true, outputSummary: `${task.objective}，已返回需人工确认的材料清单。` }, { cost: 0.01 });
  }
  event('synthesis_start', null);
  event('complete', null, { success: true });
  const session = { id: sessionId, workspaceId: wsId, title: '大任务工作流验收', creationType: 'new', parentSessionId: null, createdAt: timestamp, updatedAt: timestamp, totalCost: 0.72,
    messages: [{ id: 'u-scale', role: 'user', content: '核对72组材料并整理交接说明。', timestamp },
      { id: 'a-scale', role: 'assistant', content: '# 工作流压力样例\n\n仅验证长任务展示，不代表真实办公质量。', timestamp, traces: trace }] };
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  const route = async route => {
    const request = route.request(), url = request.url(); requests.push({ method: request.method(), url });
    if (request.method() !== 'GET') return route.fulfill({ status: 405, json: { error: 'Read-only fixture' } });
    const json = url.endsWith('/api/auth/session') ? { required: false, authenticated: true }
      : url.endsWith('/api/workspaces') ? { workspaces: [{ id: wsId, name: '工作流验收空间', sessions: [{ ...session, messages: [] }] }] }
      : url.endsWith(`/api/workspaces/${wsId}/sessions/${sessionId}`) ? session
      : url.endsWith('/api/agents') ? { agents: [] } : url.endsWith('/api/skills') ? { skills: [] }
      : { status: 'ok' };
    await route.fulfill({ json });
  };
  await page.route('**/api/**', route);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole('button', { name: session.title, exact: false }).click();
  await page.getByRole('heading', { name: '工作流压力样例' }).waitFor();
  const closedElements = await page.locator('aside[aria-label="工作流看板"] *').count();
  await page.getByRole('button', { name: '展开工作流看板' }).click();
  const drawer = page.getByRole('complementary', { name: '工作流看板' });
  await drawer.getByRole('tab', { name: '实时流转' }).click();
  const realtimeElements = await drawer.locator('*').count();
  const realtimeCards = await drawer.locator('article').count();
  if (!baseline) {
    check(closedElements === 0, `Closed drawer retained ${closedElements} elements`);
    check(realtimeCards < 250, `Long groups mounted ${realtimeCards} cards`);
    const tools = drawer.getByRole('list', { name: '工具调用事件', exact: true });
    await tools.focus();
    await tools.press('End');
    await tools.locator('article[data-task-id="task-71"]').last().waitFor();
    await tools.press('Home');
    await tools.locator('article[data-task-id="task-0"]').first().waitFor();
  }
  const start = Date.now();
  await drawer.getByRole('tab', { name: '静态架构' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 219 && !document.querySelector('select[aria-label="定位架构节点"]')?.disabled);
  const architectureMs = Date.now() - start;
  const graphElements = await drawer.locator('*').count();
  const nodes = await drawer.locator('.react-flow__node').count();
  const edges = await drawer.locator('path[class*="workflowRelationPath"]').count();
  check(nodes === 219 && edges === 432, `Graph data lost: ${nodes} nodes, ${edges} edges`);
  if (!baseline) {
    const paint = await drawer.evaluate(element => ({
      completePaths: [...element.querySelectorAll('path[class*="workflowRelationPath"]')].every(path => /^M\s*[-\d]/.test(path.getAttribute('data-full-path') || '')),
      baseAnimated: [...element.querySelectorAll('path[class*="workflowRelationPath"], path[class*="workflowRelationHalo"]')].some(path => getComputedStyle(path).animationName !== 'none'),
      longestMotion: Math.max(...[...element.querySelectorAll('path[class*="workflowRelationPath"]')].map(path => path.getTotalLength())),
      viewportPerimeter: 2 * (element.querySelector('[class*="flowCanvas"]').clientWidth + element.querySelector('[class*="flowCanvas"]').clientHeight),
    }));
    check(paint.completePaths && !paint.baseAnimated, `Relations or motion regressed: ${JSON.stringify(paint)}`);
    check(paint.longestMotion < paint.viewportPerimeter * 2, `Offscreen summary/tool path is still animating: ${paint.longestMotion}`);
    const first = await motionPixels();
    await page.evaluate(() => new Promise(resolve => { let frames = 0; const tick = () => ++frames === 6 ? resolve() : requestAnimationFrame(tick); requestAnimationFrame(tick); }));
    const second = await motionPixels();
    check(first.count > 0 && second.count > 0 && first.checksum !== second.checksum && second.correctResolution,
      `Canvas motion is blank, frozen or incorrectly sized: ${JSON.stringify({ first, second })}`);
    check(await page.evaluate(() => !document.getAnimations().some(animation => animation.effect?.target?.closest?.('[class*="flowCanvas"]'))),
      'SVG animation is still running behind the batched motion layer');
    check(await drawer.locator('marker.react-flow__arrowhead').evaluateAll(markers => markers.length > 0
      && markers.every(marker => marker.getAttribute('markerUnits') === 'userSpaceOnUse')), 'Arrows do not scale with the graph');
  }
  const frameSample = await sampleFrames();
  let panFrames;
  if (!baseline) {
    const canvas = drawer.locator('[class*="flowCanvas"]');
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + bounds.width - 20, bounds.y + 100);
    await page.evaluate(() => {
      const sample = { frames: [], active: true, last: undefined, frame: 0 };
      window.__workflowPanSample = sample;
      const tick = now => { if (!sample.active) return; if (sample.last !== undefined) sample.frames.push(now - sample.last);
        sample.last = now; sample.frame = requestAnimationFrame(tick); };
      sample.frame = requestAnimationFrame(tick);
    });
    const beforePan = await drawer.locator('.react-flow__viewport').getAttribute('style');
    for (let step = 0; step < 12; step++) {
      await page.mouse.wheel(0, 80);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    panFrames = await page.evaluate(() => {
      const sample = window.__workflowPanSample;
      sample.active = false; cancelAnimationFrame(sample.frame); delete window.__workflowPanSample;
      const sorted = sample.frames.toSorted((a, b) => a - b);
      const meanMs = sample.frames.reduce((a, b) => a + b, 0) / sample.frames.length;
      const p95Ms = sorted[Math.floor(sorted.length * .95)];
      return { frames: sample.frames.length, meanMs, p95Ms, near60Fps: meanMs <= 17.5 && p95Ms <= 20 };
    });
    check(beforePan !== await drawer.locator('.react-flow__viewport').getAttribute('style'), 'Native wheel did not pan the graph');
    check(await drawer.locator('[class*="sharedEdgeLayer"] path[class*="workflowRelationPath"]').count() === 432, 'Shared layer omitted relationships after panning');
  }
  const target = `agent:${JSON.stringify([runId, 'office-2', 'task-71'])}`;
  const navigationStart = Date.now();
  await drawer.getByRole('combobox', { name: '定位架构节点' }).selectOption(target);
  const lastCard = drawer.locator('[class*="graphAgentCard"][data-task-id="task-71"]');
  await lastCard.waitFor();
  await page.waitForFunction(() => {
    const element = document.querySelector('[class*="graphAgentCard"][data-task-id="task-71"]');
    if (!element) return false;
    const card = element.getBoundingClientRect(), canvas = element.closest('[class*="flowCanvas"]').getBoundingClientRect();
    return card.left >= canvas.left && card.right <= canvas.right && card.top >= canvas.top && card.bottom <= canvas.bottom;
  });
  check(await lastCard.evaluate(element => {
    const card = element.getBoundingClientRect(), canvas = element.closest('[class*="flowCanvas"]').getBoundingClientRect();
    return card.left >= canvas.left && card.right <= canvas.right && card.top >= canvas.top && card.bottom <= canvas.bottom;
  }), 'Last agent card is not reachable at readable scale');
  const navigationMs = Date.now() - navigationStart;
  await page.screenshot({ path: `output/playwright/workflow-scale-${baseline ? 'before' : 'after'}.png`, animations: 'disabled' });
  const endFrames = await sampleFrames();
  let overviewFrames;
  if (!baseline) {
    await drawer.getByRole('button', { name: '查看架构全景' }).click();
    await page.waitForFunction(() => {
      const canvas = document.querySelector('[class*="flowCanvas"]').getBoundingClientRect();
      return [...document.querySelectorAll('.react-flow__node')].every(node => {
        const bounds = node.getBoundingClientRect();
        return bounds.left >= canvas.left && bounds.right <= canvas.right && bounds.top >= canvas.top && bounds.bottom <= canvas.bottom;
      });
    });
    check(await drawer.locator('path[class*="workflowRelationPath"]').evaluateAll(paths => paths.every(path => path.getTotalLength() > 0)), 'Overview omitted a relationship');
    overviewFrames = await sampleFrames();
    check((await motionPixels()).count > 0, 'Overview motion is blank');
    check(await drawer.locator('path[class*="workflowRelationPath"]').first().evaluate(path => parseFloat(getComputedStyle(path).strokeWidth) < 1),
      'Overview retained oversized strokes');
    await page.screenshot({ path: 'output/playwright/workflow-scale-overview.png', animations: 'disabled' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await waitForMotion(false);
    check(await drawer.locator('path[class*="workflowRelationPath"]').count() === 432, 'Reduced motion removed static relationships');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await waitForMotion(true);
  }
  await drawer.getByRole('tab', { name: '事件日志' }).click();
  const logElements = await drawer.locator('*').count();
  const logRows = await drawer.locator('[class*="eventRow"]').count();
  if (!baseline) {
    check(logRows > 0 && logRows < 40, `Log mounted ${logRows} rows`);
    const list = drawer.getByRole('list', { name: '任务事件日志' });
    await list.focus();
    await list.press('End');
    await list.getByText('complete 任务总览', { exact: true }).waitFor();
    const lastPosition = await list.evaluate(element => element.scrollTop);
    await drawer.getByRole('button', { name: '收起工作流看板' }).click();
    check(await page.locator('aside[aria-label="工作流看板"] *').count() === 0, 'Closed log stayed mounted');
    await page.getByRole('button', { name: '展开工作流看板' }).click();
    await list.getByText('complete 任务总览', { exact: true }).waitFor();
    check(await list.evaluate(element => element.scrollTop) > lastPosition * .9, 'Log scroll position was lost');
    await drawer.getByRole('searchbox', { name: '搜索当前任务事件' }).fill('task-71');
    check(await drawer.getByLabel('匹配事件数').textContent() === '43 / 3099 条事件', 'Search omitted offscreen events');
    check(await drawer.locator('[class*="eventRow"]').count() === 43, 'Search did not expose all matching events');
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = page.getByRole('dialog');
    await mobile.getByRole('tab', { name: '事件日志' }).click();
    await mobile.getByRole('searchbox', { name: '搜索当前任务事件' }).fill('no-matching-task');
    await mobile.getByText('没有匹配的事件', { exact: true }).waitFor();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile workflow overflows');
    await page.screenshot({ path: 'output/playwright/workflow-scale-mobile.png', animations: 'disabled' });
  }
  check(errors.length === 0, errors.join('\n'));
  check(!requests.some(request => request.method !== 'GET'), 'Fixture attempted a write');
  return { baseline, production: true, fixtureOnly: true, totalEvents: trace.length, closedElements, realtimeElements, realtimeCards, graphElements,
    nodes, edges, architectureMs, navigationMs, frameSample, panFrames, endFrames, overviewFrames, logElements, logRows, userWrites: 0 };
}
