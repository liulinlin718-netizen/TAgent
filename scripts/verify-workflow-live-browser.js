// Use a fresh CLI browser at /?workflowFixture=<base from --serve --task-agents --burst>.
async page => {
  const check = (value, reason) => { if (!value) throw new Error(reason); };
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const base = await page.evaluate(() => {
    const value = new URL(location.href).searchParams.get('workflowFixture');
    if (!value) throw new Error('Missing isolated workflow fixture URL');
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || ['3000', '3001'].includes(url.port)) throw new Error('Not an isolated loopback fixture');
    return url.origin;
  });
  const errors = [], userWrites = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().startsWith('http://127.0.0.1:3001/api/') && request.method() !== 'GET') userWrites.push(request.url());
  });
  await page.addInitScript(base => {
    const native = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      return (url.origin === 'http://127.0.0.1:3001' || url.origin === location.origin) && url.pathname.startsWith('/api/')
        ? native(base + url.pathname + url.search, { ...init, credentials: 'omit' }) : native(input, init);
    };
  }, base);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  const input = page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' });
  await input.waitFor();
  const responsePromise = page.waitForResponse(response => response.url() === `${base}/api/agent/orchestrate`);
  await input.fill(`连续事件验收 ${Date.now()}：校对说明 alpha beta gamma。`);
  await input.press('Enter');
  const response = await responsePromise;
  const responseText = response.text();
  const drawer = page.getByRole('complementary', { name: '工作流看板' });
  await drawer.getByRole('tab', { name: '静态架构' }).click();
  await page.evaluate(() => {
    const state = { samples: [], frames: [], last: 0, frame: 0, observer: null };
    window.__workflowLive = state;
    const capture = () => {
      const drawer = document.querySelector('aside[aria-label="工作流看板"]');
      const label = drawer?.querySelector('[class*="architectureSummary"] > b')?.textContent || '';
      const count = Number(label.match(/\d+/)?.[0] || 0);
      state.samples.push({ count, agents: drawer?.querySelectorAll('[class*="graphAgentCard"]').length || 0,
        running: !!document.querySelector('button[aria-label="停止任务"]') });
    };
    state.observer = new MutationObserver(capture);
    state.observer.observe(document.querySelector('aside[aria-label="工作流看板"]'), { subtree: true, childList: true, characterData: true });
    const tick = now => { if (state.last) state.frames.push(now - state.last); state.last = now; state.frame = requestAnimationFrame(tick); };
    capture(); state.frame = requestAnimationFrame(tick);
  });
  const raw = await responseText;
  const events = raw.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const lines = block.split(/\r?\n/);
    return { type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(),
      data: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')) };
  });
  await page.getByRole('button', { name: '发送任务' }).waitFor();
  await page.getByRole('heading', { name: '工作流验收样例', exact: true }).waitFor();
  const captured = await page.evaluate(() => {
    const state = window.__workflowLive;
    cancelAnimationFrame(state.frame); state.observer.disconnect(); delete window.__workflowLive;
    return { samples: state.samples, frames: state.frames };
  });
  const complete = events.filter(event => event.type === 'complete');
  check(complete.length === 1 && complete[0].data.success, 'Missing unique successful final result');
  const trace = events.filter(event => event.type === 'workflow_event').map(event => event.data);
  check(trace.filter(event => event.type === 'agent_tool_call').length === 80, 'Burst fixture did not execute 80 allowed tool requests');
  check(trace.filter(event => event.type === 'agent_tool_result').length === 80, 'Burst tool results were lost');
  const progress = [...new Set(captured.samples.filter(sample => sample.running).map(sample => sample.count))];
  check(progress.length >= 3 && progress.some(count => count > 0 && count < 80), `Architecture did not update during the task: ${progress}`);
  check(await drawer.locator('[class*="architectureSummary"] > b').textContent() === '80 次工具调用', 'Final graph count is stale');
  check(await drawer.locator('[class*="graphAgentCard"]').count() === 2, 'Execution instance lost or duplicated');
  const saved = await (await page.request.get(`${base}/api/workspaces/${complete[0].data.workspaceId}/sessions/${complete[0].data.sessionId}`)).json();
  const result = saved.messages.find(message => message.run?.id === complete[0].data.runId);
  check(result?.content === complete[0].data.output, 'Saved final report differs from SSE');
  check(JSON.stringify(canonical(result.traces)) === JSON.stringify(canonical(trace)), 'Persisted and streamed trace differ');
  await drawer.getByRole('tab', { name: '事件日志' }).click();
  await drawer.getByRole('searchbox', { name: '搜索当前任务事件' }).fill('agent_tool_result');
  check(await drawer.getByLabel('匹配事件数').textContent() === `80 / ${trace.length} 条事件`, 'Log lost tool results');
  await page.screenshot({ path: 'output/playwright/workflow-live-final.png', animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = page.getByRole('dialog', { name: '工作流看板' });
  await mobile.waitFor();
  await mobile.getByRole('searchbox', { name: '搜索当前任务事件' }).fill('agent_tool_result');
  check(await mobile.getByLabel('匹配事件数').textContent() === `80 / ${trace.length} 条事件`, 'Mobile log lost burst results');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile burst workflow overflows');
  await page.screenshot({ path: 'output/playwright/workflow-live-mobile.png', animations: 'disabled' });
  check(errors.length === 0 && userWrites.length === 0, JSON.stringify({ errors, userWrites }));
  const sorted = captured.frames.toSorted((a, b) => a - b);
  return { nativeSSE: true, fixtureOnly: true, events: trace.length, toolRequests: 80, progress,
    frames: sorted.length, meanFrameMs: captured.frames.reduce((a, b) => a + b, 0) / sorted.length,
    p95FrameMs: sorted[Math.floor(sorted.length * .95)], finalAndSavedAgree: true, mobileLog: true, userWrites: 0 };
}
