// Manual Playwright CLI check: open a completed long task before running this file.
// npx --package @playwright/cli playwright-cli -s=<session> run-code --filename=scripts/verify-workflow-browser.js
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await page.setViewportSize({ width: 1440, height: 1000 });
  const drawer = page.getByRole('complementary', { name: '工作流看板' });
  if (!await drawer.isVisible()) await page.getByRole('button', { name: '展开工作流看板' }).click();
  await page.getByRole('tab', { name: '实时流转' }).click();
  const initial = await drawer.boundingBox();
  const initialHandle = await drawer.locator('[class*="resizeHandle"]').boundingBox();
  await page.mouse.move(initialHandle.x + initialHandle.width / 2, initialHandle.y + 260);
  await page.mouse.down();
  await page.mouse.move(initialHandle.x + initialHandle.width / 2 + initial.width - 430, initialHandle.y + 260, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => Math.abs(document.querySelector('aside[aria-label="工作流看板"]').getBoundingClientRect().width - 430) < 2);
  const cards = drawer.locator('article');
  const eventCount = await cards.count();
  check(eventCount > 36, 'Select a completed long run to exercise event retention');
  check(await drawer.getByRole('heading', { name: '任务拆解', exact: true }).count() === 1, 'Decomposition was dropped');
  check(await drawer.locator('[class*="groupIconActive"]').count() === 0, 'Completed groups still appear active');
  const calls = await cards.locator('[class*="kindLabel"]').allTextContents();
  const callCount = calls.filter(label => label === '工具调用').length;
  const scrollingGroups = await drawer.locator('[class*="flowGroupBody"]').evaluateAll(elements =>
    elements.filter(element => element.scrollHeight > element.clientHeight).length);
  check(scrollingGroups > 0, 'Long groups must scroll internally');

  await page.getByRole('tab', { name: '事件日志' }).click();
  check(await drawer.locator('[class*="eventRow"]').count() === eventCount, 'Realtime/log events disagree');

  await page.getByRole('tab', { name: '静态架构' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length > 0 &&
    [...document.querySelectorAll('.react-flow__node')].every(node => Number(getComputedStyle(node).opacity) > 0));
  check(await drawer.getByText(`${callCount} 次工具调用`, { exact: true }).count() === 1, 'Tool results counted as calls');
  const geometry = await drawer.evaluate(element => {
    const nodes = [...element.querySelectorAll('.react-flow__node')].map(node => ({ id: node.dataset.id, ...node.getBoundingClientRect().toJSON() }));
    const overlap = [];
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y) overlap.push([a.id, b.id]);
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
    return { nodes, overlap, crossings, edges: edges.length, visibleEdges: edges.filter(edge => edge.getTotalLength() > 0 && getComputedStyle(edge).stroke !== 'none').length };
  });
  check(new Set(geometry.nodes.map(node => node.id)).size === geometry.nodes.length, 'Duplicate graph node IDs');
  check(geometry.nodes.filter(node => node.id === 'orchestrator').length === 1, 'Orchestrator root is duplicated');
  check(!geometry.nodes.some(node => node.id === 'agent:orchestrator'), 'Root rendered as a child');
  check(geometry.overlap.length === 0, `Overlapping nodes: ${JSON.stringify(geometry.overlap)}`);
  check(geometry.crossings.length === 0, `Edges cross unrelated cards: ${JSON.stringify(geometry.crossings)}`);
  check(geometry.edges > 0 && geometry.edges === geometry.visibleEdges, 'Relations are not visible by default');
  await page.screenshot({ path: 'output/playwright/workflow-architecture-20260911.png', timeout: 30000, animations: 'disabled' });

  const before = await drawer.boundingBox();
  const handle = await drawer.locator('[class*="resizeHandle"]').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 260);
  await page.mouse.down();
  await page.mouse.move(handle.x - 170, handle.y + 260, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(width => document.querySelector('aside[aria-label="工作流看板"]').getBoundingClientRect().width > width + 150, before.width);
  const after = await drawer.boundingBox();
  const main = await page.getByRole('main').boundingBox();
  check(after.width > before.width + 150, 'Drawer did not resize');
  check(main.x + main.width <= after.x + 1, 'Drawer overlaps the main conversation');
  await page.screenshot({ path: 'output/playwright/workflow-resized-20260911.png', timeout: 30000, animations: 'disabled' });

  await page.getByRole('button', { name: '收起工作流看板' }).click();
  await page.waitForFunction(() => document.querySelector('main').getBoundingClientRect().right > 1439);
  await page.setViewportSize({ width: 390, height: 844 });
  const input = await page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' }).boundingBox();
  const mobile = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  check(input.y >= 0 && input.y + input.height <= 844, 'Mobile composer is outside viewport');
  check(mobile.content <= mobile.viewport, 'Page has horizontal overflow');
  check(!await drawer.isVisible(), 'Closed mobile drawer is still visible');
  await page.screenshot({ path: 'output/playwright/workflow-mobile-20260911.png', timeout: 30000, animations: 'disabled' });
  return { eventCount, callCount, nodes: geometry.nodes.length, edges: geometry.edges, overlaps: geometry.overlap, crossings: geometry.crossings, beforeWidth: before.width, afterWidth: after.width, mobile };
}
