import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fixtureOfficeCase, fixtureOfficeReview } from './fixtures/office-review.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tagent-office-'));
const serveMode = process.argv.includes('--serve');
const reviewProfileMode = process.argv.includes('--review-profile');
const controlPath = `/stop-${randomUUID()}`;
let finishServing, child, logs = '', calls = 0;
const serving = new Promise(done => { finishServing = done; });
const finalOutput = (number, expanded = false) => `## 收入简报\n\n材料中的月收入为100、120、90万元，合计${number}万元。\n\n未提供成本或业务原因，不能据此解释收入变化。`
  + (expanded ? Array.from({ length: 16 }, (_, index) => `\n\n检查段落${index + 4}：待核对口径与原始账单，不据此解释因果。`).join('') : '');
const groundingCases = {
  'serial-repair': { task: '按工作日排期，无并行条件，研发负责人待定。',
    draft: '是否允许并行安排（当前按不允许处理）？研发负责人待定。',
    revision: '按用户条件串行排期；研发负责人待定，具体工期尚未提供。' },
  'serial-failed': { task: '按工作日排期，无并行条件，研发负责人待定。',
    draft: '是否允许并行安排（当前按不允许处理）？研发负责人待定。',
    revision: '是否允许并行安排？研发负责人待定。' },
  'subset-repair': { task: '核对原文关系，不联网。来源B：启用210家门店，其中30家暂停。',
    draft: '不能确认30家是否计入210家。',
    revision: '来源B原文说明30家暂停属于210家，不应重复相加。未进行外部独立核验。' },
  'serial-condition': { task: '仅根据材料整理排期建议，不联网。任务严格串行。',
    draft: '若要缩短工期，可评估设计与开发并行推进。',
    revision: '当前保持严格串行；若另行批准改变依赖约束，再另做并行方案。' },
  'date-comparison': { task: '仅核对给定数字，不联网。来源A覆盖240家门店，但未说明统计日期。来源B记载启用210家。',
    draft: '没有时点，任何数字比对都无意义。',
    revision: '两个给定数字相差30家；来源A日期未知，不能据此判断同一时点的业务变化或选定某来源为真。' },
};
const absoluteCases = {
  'absolute-pass': { task: '仅比较给定数字，不联网。来源A：240家。来源B：210家。',
    draft: '240 与 210 的差额为30家。' },
  'absolute-repair': { task: '仅比较给定数字，不联网。来源A：240家。来源B：210家。',
    draft: '240 与 210 的差额为40家。', revision: '240 与 210 的差额为30家。' },
};
const rowCase = {
  task: '仅整理给定材料，不联网：前置交付延后会影响后续任务；人员配置材料未提供。',
  draft: '| 风险 | 影响 |\n| --- | --- |\n| 前置交付延后 | 后续任务相应顺延 |\n| 人员配置未提供 | 项目无人负责 |',
  revision: '| 风险 | 影响 |\n| --- | --- |\n| 前置交付延后 | 后续任务相应顺延 |\n| 人员配置未提供 | 不能据此判断项目无人负责 |',
};
const plannedCases = ['pass', 'repair', 'rows-repair'];
const exportOutput = '# 季度收入与行动报告\n\n' + finalOutput(310)
  + '\n\n## 二 账单核对\n\n| 月份 | 金额（万元） | 状态 |\n| :--- | ---: | :---: |\n| 1月 | 100 | 待复核 |\n| 2月 | 120 | 待复核 |\n| 3月 | 90 | 甲\\|乙 |'
  + '\n\n## 三 后续行动\n\n3. 核对原始账单\n   - 检查统计口径\n     - [x] 收入相加\n     - [ ] 业务原因待确认\n4. 负责人确认后再对外发送\n\n> 这些数据来自测试材料，不代表实际经营业绩。'
  + '\n\n示例来源：[公开说明](https://example.com/report?date=2026-09-14&view=full)。[^口径]\n\n[^口径]: 人民币万元，未提供成本，不能推断利润。'
  + '\n\n```text\n原始列名: 月份, 收入\n计算: 100 + 120 + 90 = 310\n```';
// Both endpoints and all credentials below are local fixtures. No external API call.
const modelServer = createServer(async (request, response) => {
  if (serveMode && request.method === 'POST' && request.url === controlPath) { response.end('Stopping'); finishServing(); return; }
  if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404).end(); return; }
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), system = input.messages[0].content;
    const mode = fixtureOfficeCase(input.messages);
    assert.ok(mode, 'Known isolated test case');
    const partialRepair = ['partial-repair', 'partial-still-invalid'].includes(mode);
    let content;
    calls++;
    if (reviewProfileMode) {
      const reviewing = system.includes('你是办公交付核对器') || system.includes('你是办公交付修订器');
      assert.equal(input.model, reviewing ? 'deepseek-v4-pro' : 'deepseek-chat');
      if (reviewing) { assert.equal(input.thinking?.type, 'enabled'); assert.equal(input.reasoning_effort, 'low'); }
      else assert.notEqual(input.thinking?.type, 'enabled');
    }
    if (system.includes('你是任务编排器')) content = plannedCases.includes(mode)
      ? JSON.stringify([{ id: 'office-direct', agentRole: 'document', objective: '根据用户给定材料完成整份办公交付物，不联网。' }]) : '[]';
    else if (system.includes('你是办公交付核对器')) {
      assert.ok(!input.tools?.length, 'Review must not call tools');
      if (mode === 'malformed' || mode === 'cut-review') content = '{invalid-review-json';
      else {
        const payload = JSON.parse(input.messages[1].content);
        assert.equal(payload.blockSchema, 'table-rows-v1');
        const checked = JSON.parse(fixtureOfficeReview(input.messages));
        assert.deepEqual(payload.responseTemplate.blocks.map(block => block.index), payload.blocks.map(block => block.index));
        assert.ok(payload.responseTemplate.areas.every(area => area.status === null));
        if (mode === 'rows-repair') {
          assert.equal(payload.blocks.length, 3);
          assert.equal(payload.blocks[2].context.tableHeader, '| 风险 | 影响 |');
          const failed = payload.blocks[2].text.endsWith('| 项目无人负责 |');
          checked.blocks.forEach((block, index) => { block.verdict = failed && index === 2 ? 'unsupported' : 'grounded'; block.evidence = [{ materialId: 'input', quote: payload.task }]; });
          if (failed) checked.areas.find(area => area.area === 'material_consistency').status = 'failed';
        } else if (groundingCases[mode]) {
          checked.blocks.forEach(block => { block.verdict = 'grounded'; block.evidence = [{ materialId: 'input', quote: payload.task }]; });
          assert.equal(payload.deterministicChecks.length, mode === 'serial-failed' || payload.blocks[0].text === groundingCases[mode].draft ? 1 : 0);
        } else if (absoluteCases[mode]) {
          checked.blocks.forEach(block => { block.verdict = 'grounded'; block.evidence = [{ materialId: 'input', quote: payload.task }]; });
          const line = payload.blocks.find(block => block.text.includes('差额')).text;
          checked.calculations = [{ operation: 'absolute_difference', result: Number(line.match(/差额为(\d+)/)[1]), decimals: 0, outputQuote: line,
            operands: [240, 210].map(value => ({ value, materialId: 'input', quote: payload.task })) }];
        } else {
          checked.blocks.forEach(block => { block.verdict = 'grounded'; block.evidence = [{ materialId: 'input', quote: '1月100万元，2月120万元，3月90万元。未提供成本或业务原因。' }]; });
          const line = payload.blocks.find(block => block.text.includes('合计')).text;
          const result = Number(line.match(/合计(\d+)/)[1]);
          checked.calculations = [{ operation: 'sum', result, decimals: 0, outputQuote: line,
            operands: [100, 120, 90].map(value => ({ value, materialId: 'input', quote: '1月100万元，2月120万元，3月90万元。' })) }];
          if (mode === 'partial' || (partialRepair && (result === 320 || mode === 'partial-still-invalid'))) {
            assert.equal(payload.blocks.length, 19); checked.blocks[6].verdict = 'unexpected-verdict';
            checked.untrustedRaw = '<img src="not-a-real-resource" onerror="window.__receiptExecuted=true">';
          }
        }
        content = JSON.stringify(checked);
      }
    } else if (system.includes('你是办公交付修订器')) {
      assert.ok(!input.tools?.length, 'Revision must not call tools');
      if (groundingCases[mode]) {
        const feedback = JSON.parse(input.messages[1].content).feedback;
        assert.ok(feedback.some(item => item.outputQuote && item.evidence?.some(source => source.materialId === 'input')));
      }
      if (partialRepair) {
        const feedback = JSON.parse(input.messages[1].content).feedback;
        assert.ok(feedback.some(item => item.label === '算术复算' && /合计320/.test(item.outputQuote) && item.evidence.length));
      }
      if (absoluteCases[mode]) {
        const feedback = JSON.parse(input.messages[1].content).feedback;
        assert.ok(feedback.some(item => item.label === '算术复算' && /差额为40/.test(item.outputQuote) && item.evidence.length));
      }
      if (mode === 'rows-repair') {
        const feedback = JSON.parse(input.messages[1].content).feedback;
        assert.ok(feedback.some(item => item.label === '表格 1 · 第 2 行' && item.outputQuote === '| 人员配置未提供 | 项目无人负责 |'));
      }
      content = mode === 'rows-repair' ? rowCase.revision : groundingCases[mode]?.revision ?? absoluteCases[mode]?.revision ?? (mode === 'cut-revision' ? 'PARTIAL_REVISION：尚未写完的修订正文。' : finalOutput(mode === 'failed' ? 320 : 310, partialRepair));
    } else content = mode === 'rows-repair' ? rowCase.draft : groundingCases[mode]?.draft ?? absoluteCases[mode]?.draft ?? (mode === 'export' ? exportOutput : finalOutput(partialRepair || ['repair', 'failed', 'cut-revision'].includes(mode) ? 320 : 310, mode === 'partial' || partialRepair));
    await delay(100);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion', model: input.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason:
        (system.includes('你是办公交付修订器') && mode === 'cut-revision')
        || (system.includes('你是办公交付核对器') && mode === 'cut-review') ? 'length' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }));
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: { message: error.message } })); }
});
modelServer.listen(0, '127.0.0.1'); await once(modelServer, 'listening');
const modelPort = modelServer.address().port;
const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(done => reservation.close(done));
const base = `http://127.0.0.1:${port}`;
async function start() {
  child = spawn(process.execPath, [join(root, 'packages/tagent-server/dist/index.js')], { cwd: temporaryRoot, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TAGENT_WORKSPACE_ROOT: temporaryRoot, TAGENT_ENV_FILE: '',
      PORT: String(port), TAGENT_HOST: '127.0.0.1', NODE_ENV: 'test', DATABASE_URL: '', REDIS_URL: '',
      DEEPSEEK_API_KEY: reviewProfileMode ? 'local-office-only' : '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: reviewProfileMode ? '' : 'local-office-only',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      TAGENT_LLM_PROVIDER: reviewProfileMode ? 'deepseek' : 'openai', TAGENT_LLM_MODEL: 'deepseek-chat',
      TAGENT_OFFICE_REVIEW_MODEL: reviewProfileMode ? 'deepseek-v4-pro' : '', TAGENT_OFFICE_REVIEW_REASONING: reviewProfileMode ? 'low' : '',
      TAGENT_ACCESS_TOKEN: '', TAGENT_PUBLIC_ORIGIN: '', TAGENT_WEB_ORIGINS: 'http://127.0.0.1:3000' } });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-5000); }); child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Fixture backend exited: ${logs}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Startup probe. */ }
    await delay(100);
  }
  throw new Error(`Fixture startup timed out: ${logs}`);
}
async function stop() { if (child && child.exitCode === null) { const ended = once(child, 'close'); child.kill(); await ended; } }
async function json(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  assert.ok(response.ok, `HTTP ${response.status}: ${path}`); return response.json();
}
const cases = [];
try {
  await start();
  const workspaceId = (await json('/api/workspaces')).workspaces[0].id;
  if (reviewProfileMode) {
    const state = await json('/api/model-connection');
    assert.equal(state.model, 'deepseek-chat');
    assert.deepEqual(state.officeReview, { model: 'deepseek-v4-pro', reasoning: 'low' });
    assert.equal(calls, 0, 'Reading the office profile must not call a model');
  }
  const selectedCases = reviewProfileMode ? ['pass', 'repair']
    : ['pass', 'repair', 'failed', 'malformed', 'cut-review', 'partial', 'partial-repair', 'partial-still-invalid', 'cut-revision', 'export', ...Object.keys(groundingCases), ...Object.keys(absoluteCases), 'rows-repair'];
  for (const [index, mode] of selectedCases.entries()) {
    const beforeCalls = calls;
    const response = await fetch(base + (index === 0 ? '/api/agent/run' : '/api/agent/orchestrate'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, message: `office-case-${mode}：${(mode === 'rows-repair' ? rowCase.task : undefined) ?? groundingCases[mode]?.task ?? absoluteCases[mode]?.task ?? '仅根据给定材料生成收入简报，不联网。1月100万元，2月120万元，3月90万元。未提供成本或业务原因。'}` }), signal: AbortSignal.timeout(45000) });
    assert.equal(response.status, 200);
    const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map(block => {
      const lines = block.split(/\r?\n/);
      return { type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(), data: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')) };
    });
    const completes = events.filter(event => event.type === 'complete'); assert.equal(completes.length, 1);
    const final = completes[0].data, trace = events.filter(event => event.type === 'workflow_event').map(event => event.data);
    const partialRepair = ['partial-repair', 'partial-still-invalid'].includes(mode);
    const status = ['failed', 'cut-revision', 'serial-failed'].includes(mode) ? 'needs_revision' : ['malformed', 'cut-review', 'partial', 'partial-still-invalid'].includes(mode) ? 'unverified' : 'passed';
    assert.equal(final.deliveryReview.status, status); assert.equal(final.success, status === 'passed');
    assert.equal(final.deliveryReview.blockSchema, 'table-rows-v1');
    assert.equal(final.deliveryReview.model, reviewProfileMode ? 'deepseek-v4-pro' : 'deepseek-chat');
    assert.equal(final.deliveryReview.reasoning, reviewProfileMode ? 'low' : 'disabled');
    assert.equal(final.persisted, true); assert.ok(final.totalCost > 0);
    assert.equal(trace.filter(event => event.type === 'complete').length, 1);
    assert.ok(trace.some(event => event.data.stage === 'verify'));
    if (plannedCases.includes(mode)) {
      assert.equal(trace.filter(event => event.type === 'agent_spawn' && event.taskId === 'office-direct').length, 1);
      assert.equal(trace.filter(event => event.type === 'synthesis_start').length, 1);
      assert.ok(trace.some(event => event.agentId === 'orchestrator' && event.data.stage === 'synthesize' && event.summary.includes('完整交付正文')));
    }
    assert.equal(calls - beforeCalls, mode === 'repair' || mode === 'failed' || partialRepair || groundingCases[mode] || mode === 'absolute-repair' || mode === 'rows-repair' ? 5 : mode === 'cut-revision' ? 4 : 3);
    assert.ok(final.deliveryReview.receipt.rawOutput.length > 0);
    assert.equal(final.deliveryReview.receipt.unsettledRequests, 0);
    if (mode === 'cut-review') {
      assert.equal(final.deliveryReview.receipt.stopReason, 'max_tokens');
      assert.ok(final.deliveryReview.issues.some(issue => issue.includes('输出达到长度限制')));
      assert.deepEqual(final.deliveryReview.coverage, { expectedBlocks: 3, checkedBlocks: 0 });
      assert.equal(final.deliveryReview.revisionAttempt, undefined);
      assert.equal(final.output, finalOutput(310));
    }
    if (mode === 'partial') {
      assert.deepEqual(final.deliveryReview.coverage, { expectedBlocks: 19, checkedBlocks: 18 });
      assert.equal(final.deliveryReview.checks.find(check => check.id === 'block-6').status, 'unverified');
      assert.ok(final.deliveryReview.issues.some(issue => issue.includes('blocks[index=6].verdict')));
      assert.equal(final.deliveryReview.checks.filter(check => check.status === 'passed').length, 24);
    }
    if (mode === 'cut-revision') {
      assert.match(final.deliveryReview.revisionAttempt.rawOutput, /PARTIAL_REVISION/);
      assert.equal(final.deliveryReview.revisionAttempt.stopReason, 'max_tokens');
    }
    if (mode === 'repair' || mode === 'failed') { assert.match(final.deliveryReview.previous.output, /合计320/); assert.equal(final.deliveryReview.previous.review.status, 'needs_revision'); }
    if (partialRepair) {
      const previous = final.deliveryReview.previous;
      assert.equal(previous.output, finalOutput(320, true)); assert.equal(previous.review.status, 'unverified');
      assert.deepEqual(previous.review.coverage, { expectedBlocks: 19, checkedBlocks: 18 });
      assert.ok(previous.review.checks.some(check => check.id === 'calculation-0' && check.status === 'failed'));
      assert.equal(final.output, finalOutput(310, true));
      assert.deepEqual(final.deliveryReview.coverage, { expectedBlocks: 19, checkedBlocks: mode === 'partial-repair' ? 19 : 18 });
      assert.equal(final.deliveryReview.checks.find(check => check.id === 'calculation-0').status, 'passed');
    }
    if (mode === 'rows-repair') {
      assert.equal(final.output, rowCase.revision);
      assert.equal(final.deliveryReview.previous.output, rowCase.draft);
      assert.equal(final.deliveryReview.previous.review.blockSchema, 'table-rows-v1');
      assert.ok(final.deliveryReview.previous.review.checks.some(check => check.label === '表格 1 · 第 2 行' && check.status === 'failed' && check.outputQuote === '| 人员配置未提供 | 项目无人负责 |'));
      assert.deepEqual(final.deliveryReview.coverage, { expectedBlocks: 3, checkedBlocks: 3 });
    } else if (groundingCases[mode]) {
      assert.equal(final.output, groundingCases[mode].revision);
      assert.equal(final.deliveryReview.previous.output, groundingCases[mode].draft);
      assert.ok(final.deliveryReview.previous.review.checks.some(check => check.method === 'programmatic' && check.status === 'failed' && check.evidence.length));
      assert.equal(final.deliveryReview.checks.some(check => check.id.startsWith('grounding-') && check.status === 'failed'), mode === 'serial-failed');
    } else if (absoluteCases[mode]) {
      assert.equal(final.output, absoluteCases[mode].revision ?? absoluteCases[mode].draft);
      assert.equal(final.deliveryReview.checks.find(check => check.id === 'calculation-0').status, 'passed');
      if (mode === 'absolute-repair') {
        assert.equal(final.deliveryReview.previous.output, absoluteCases[mode].draft);
        assert.equal(final.deliveryReview.previous.review.checks.find(check => check.id === 'calculation-0').status, 'failed');
      } else assert.equal(final.deliveryReview.previous, undefined);
    } else assert.match(final.output, ['failed', 'cut-revision'].includes(mode) ? /合计320/ : /合计310/);
    const saved = await json(`/api/workspaces/${workspaceId}/sessions/${final.sessionId}`);
    const message = saved.messages.at(-1);
    assert.equal(message.content, final.output); assert.deepEqual(message.deliveryReview, final.deliveryReview);
    assert.deepEqual(message.traces, trace); assert.equal(message.run.status, 'finished');
    cases.push({ mode, sessionId: final.sessionId, message });
  }
  await stop(); await start();
  for (const item of cases) assert.deepEqual((await json(`/api/workspaces/${workspaceId}/sessions/${item.sessionId}`)).messages.at(-1), item.message);
  const callsBeforeControls = calls;
  const originalMetrics = await json('/api/runtime');
  assert.equal(originalMetrics.recordedRuns, cases.length);
  assert.equal(originalMetrics.activeRuns, 0);
  const snapshotSession = cases[1].sessionId;
  const snapshots = (await json(`/api/workspaces/${workspaceId}/sessions/${snapshotSession}/snapshots`)).snapshots;
  assert.ok(snapshots.length > 0, 'Ordinary task loops must persist execution snapshots');
  assert.ok(snapshots.every(item => item.messages === undefined));
  const snapshot = await json(`/api/snapshots/${snapshots[0].id}`);
  assert.ok(snapshot.messages.every(message => message.role !== 'system' && message.toolCalls === undefined));
  assert.equal((await fetch(base + `/api/snapshots/${snapshot.id}/fork`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
  const branch = await json(`/api/snapshots/${snapshot.id}/fork`, { confirmed: true });
  const repeatedBranch = await json(`/api/snapshots/${snapshot.id}/fork`, { confirmed: true });
  assert.equal(branch.session.id, repeatedBranch.session.id); assert.equal(branch.willExecute, false);
  assert.equal(branch.session.snapshotOrigin.id, snapshot.id);
  assert.ok(branch.session.messages.every(message => !message.run && !message.cost));
  assert.equal((await json('/api/runtime')).recordedRuns, originalMetrics.recordedRuns);
  const scheduleInput = { name: '接口验收待办', taskMessage: '仅准备合成材料，不自动发送。', workspaceId,
    nextRun: Date.now() + 120000, intervalMs: 60000, enabled: true, requestId: randomUUID(), confirmed: true };
  const job = await json('/api/cron', scheduleInput);
  assert.equal((await json('/api/cron', scheduleInput)).id, job.id);
  const paused = await json(`/api/cron/${job.id}`, { ...scheduleInput, enabled: false, revision: job.revision }, 'PUT');
  assert.equal(paused.enabled, false); assert.equal((await json('/api/cron')).willExecute, false);
  assert.equal(calls, callsBeforeControls, 'Snapshot and schedule controls must never call a model');
  await stop(); await start();
  assert.equal((await json('/api/cron')).jobs.find(item => item.id === job.id).enabled, false);
  assert.equal((await json(`/api/snapshots/${snapshot.id}/fork`, { confirmed: true })).session.id, branch.session.id);
  await json(`/api/cron/${job.id}`, undefined, 'DELETE');
  assert.ok(!(await json('/api/cron')).jobs.some(item => item.id === job.id));
  const research = (await json('/api/agents')).agents.find(agent => agent.id === 'research-agent');
  assert.ok(research);
  await json('/api/agents/research-agent', { constraints: { ...research.constraints, allowedTools: [] },
    configurationRevision: research.configurationRevision }, 'PUT');
  const explore = await fetch(base + '/api/agent/orchestrate', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, mode: 'explore', message: '近30天 AI Agent 最新进展' }), signal: AbortSignal.timeout(15000) });
  assert.equal(explore.status, 200);
  const exploreEvents = (await explore.text()).split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const lines = block.split(/\r?\n/);
    return { type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(),
      data: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')) };
  });
  const exploreFinal = exploreEvents.filter(event => event.type === 'complete');
  assert.equal(exploreFinal.length, 1); assert.equal(exploreFinal[0].data.success, false);
  assert.match(exploreFinal[0].data.output, /只读探索/); assert.equal(exploreFinal[0].data.persisted, true);
  assert.equal(exploreFinal[0].data.subResults.length, 1);
  assert.ok(exploreEvents.some(event => event.type === 'workflow_event' && event.data.type === 'governance'
    && event.data.data.result === 'blocked'));
  assert.equal(calls, callsBeforeControls, 'Read-only exploration must obey tool policy before search/model calls');
  await json('/api/agents/research-agent', { constraints: research.constraints }, 'PUT');
  console.log(JSON.stringify({ status: 'passed', fixtureOnly: true, cases: cases.length, localModelCalls: calls,
    reviewProfileMode, restart: true, runtimeMetrics: true, snapshotFork: true, scheduleControls: true, explorePolicy: true, userWrites: 0 }));
  if (serveMode) {
    console.log(JSON.stringify({ base, workspaceId, cases: cases.map(({ mode, sessionId }) => ({ mode, sessionId })), stopUrl: `http://127.0.0.1:${modelPort}${controlPath}` }));
    await serving;
  }
} finally {
  await stop(); await new Promise(done => modelServer.close(done));
  const rel = relative(tmpdir(), temporaryRoot); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(temporaryRoot, { recursive: true, force: true });
}
