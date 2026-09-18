import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { checkEnvironment } from './check.mjs';
import { createRequire } from 'node:module';
import { fixtureOfficeReview } from './fixtures/office-review.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = await mkdtemp(join(tmpdir(), 'tagent-tables-'));
const serveMode = process.argv.includes('--serve');
const controlPath = `/stop-${randomUUID()}`;
let finishServing;
const serving = new Promise(done => { finishServing = done; });
const longGroup = index => `区域${index + 1}-${'LongDepartmentName'.repeat(9)}`;
const cases = {
  csv: { format: 'csv', data: '月份,收入\n1月,0.1\n1月,0.2\n2月,0.6' },
  tsv: { format: 'tsv', data: '月份\t收入\n1月\t0.1\n1月\t0.2\n2月\t0.6' },
  markdown: { format: 'markdown', data: '|月份|收入|\n|---|---:|\n|1月|0.1|\n|1月|0.2|\n|2月|0.6|' },
  invalid: { format: 'csv', data: '月份,收入\n1月,0.1\n1月,=2+2\n2月,0.6' },
  large: { format: 'csv', data: '分组,收入\n' + Array.from({ length: 25 }, (_, index) => `${longGroup(index)},${index + 1}`).join('\n') },
};
let child, logs = '', calls = 0;
const errors = [];
const sessions = [];
const sha = text => createHash('sha256').update(text).digest('hex');
const messageFor = name => `table-case-${name}：只分析下列原表，收入单位为万元，不联网；${name === 'large' ? '按分组汇总并比较最后一组对第一组的变化。' : '按月份汇总并比较2月对1月的变化。'}\n${cases[name].data}`;
const outputFor = name => name === 'invalid' ? '1月含公式文本，不是数值；未计算该月收入及变化率。请核对原表第3条物理行后的异常记录，不执行公式。'
  : name === 'large' ? '## 分组收入\n\n原表共25组。第一组收入1万元，最后一组25万元，变化量24万元，变化率2400%。分组标签仅代表原表类别，不推断时间趋势。'
  : '## 月收入分析\n\n|月份|收入（万元）|\n|---|---:|\n|1月|0.3|\n|2月|0.6|\n\n2月比1月增加0.3万元，增幅100%。根据用户提供的完整表格计算，共3条数据，无缺失值；未提供成本或原因，不据此推断利润或因果。';

const { default: writeExcelFile } = createRequire(join(root, 'packages/tagent-web/package.json'))('write-excel-file/universal');
const importWorkbook = await writeExcelFile([
  { sheet: '说明', data: [[{ value: '请选月收入工作表', type: String }]] },
  { sheet: '月收入', data: cases.csv.data.split('\n').map((line, row) => line.split(',').map((value, column) =>
    ({ value: row > 0 && column === 1 ? Number(value) : value, type: row > 0 && column === 1 ? Number : String }))) },
]).toBlob();

// Real OpenAI SDK -> localhost HTTP fixture -> real tools. No external model/search calls.
const model = createServer(async (request, response) => {
  if (serveMode && request.method === 'POST' && request.url === controlPath) { response.end('Stopping'); finishServing(); return; }
  if (serveMode && request.method === 'GET' && request.url === '/fixture-status') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ calls, errors })); return;
  }
  if (serveMode && request.method === 'GET' && request.url === '/table-import.xlsx') {
    response.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }).end(Buffer.from(await importWorkbook.arrayBuffer())); return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), system = input.messages[0].content;
    const name = input.messages.map(message => message.content || '').join('\n').match(/table-case-(csv|tsv|markdown|invalid|large)/)?.[1];
    assert.ok(name); calls++;
    let content = '', tool;
    if (system.includes('你是任务编排器')) content = JSON.stringify([{ id: 'table', agentRole: 'data', objective: `table-case-${name}：计算原表，不得采用此虚假替代数据：收入999999。` }]);
    else if (system.includes('你是办公交付核对器')) {
      const payload = JSON.parse(input.messages[1].content);
      assert.ok(payload.materials.some(material => material.text.includes('selectionSha256')), 'Actual calculation receipt reaches review');
      content = fixtureOfficeReview(input.messages);
    } else if (input.tools?.some(tool => tool.function.name === 'analyze_table')) {
      const results = input.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      const startLine = results[1]?.lines?.find(line => line.text === cases[name].data.split('\n')[0])?.line ?? 2;
      const selection = { sourceId: 'current', startLine, endLine: startLine + cases[name].data.split('\n').length - 1, format: cases[name].format };
      if (!results.length) tool = { name: 'read_data_source', args: {} };
      else if (results.length === 1) {
        if (results[0].sources[0].lines === messageFor(name).split('\n').length) assert.equal(results[0].sources[0].sha256, sha(messageFor(name)));
        tool = { name: 'read_data_source', args: { sourceId: 'current' } };
      } else if (results.length === 2) {
        assert.ok(results[1].lines.some(line => line.text === cases[name].data.split('\n')[0]));
        tool = { name: 'analyze_table', args: { ...selection, action: 'inspect' } };
      } else if (results.length === 3) {
        assert.equal(results[2].provenance.rows, name === 'large' ? 25 : 3);
        tool = { name: 'analyze_table', args: { ...selection, action: 'aggregate', groupBy: [name === 'large' ? '分组' : '月份'], metrics: [{ column: '收入', operation: 'sum' }],
          compare: { baseline: [name === 'large' ? longGroup(0) : '1月'], current: [name === 'large' ? longGroup(24) : '2月'], metric: 0 } } };
      } else {
        assert.equal(results.length, 4);
        assert.equal(results[3].groups[0].metrics[0].value, name === 'invalid' ? null : name === 'large' ? '1' : '0.3');
        assert.equal(results[3].comparison.percentChange, name === 'invalid' ? null : name === 'large' ? '2400' : '100');
        content = outputFor(name);
      }
    } else content = outputFor(name);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion', model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content, ...(tool ? { tool_calls: [{ id: randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) },
        finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
  } catch (error) { errors.push(error.message); response.writeHead(500).end(JSON.stringify({ error: { message: error.message } })); }
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(done => reservation.close(done));
const base = `http://127.0.0.1:${port}`;
async function start() {
  child = spawn(process.execPath, [join(root, 'packages/tagent-server/dist/index.js')], { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...checkEnvironment(process.env, workspace), PORT: String(port), NODE_ENV: 'test', TAGENT_HOST: '127.0.0.1',
      OPENAI_API_KEY: 'local-table-fixture', OPENAI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, TAGENT_LLM_PROVIDER: 'openai', TAGENT_LLM_MODEL: 'deepseek-chat',
      TAGENT_WEB_ORIGINS: 'http://127.0.0.1:3000' } });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-5000); }); child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Fixture backend exited: ${logs}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* bounded startup probe */ }
    await delay(100);
  }
  throw new Error(`Fixture startup timed out: ${logs}`);
}
async function stop() { if (child && child.exitCode === null) { const ended = once(child, 'close'); child.kill(); await ended; } }
async function json(path) { const response = await fetch(base + path); assert.ok(response.ok); return response.json(); }
try {
  await start();
  const workspaceId = (await json('/api/workspaces')).workspaces[0].id;
  const workspacesBeforeImport = await json('/api/workspaces');
  const fileBytes = Buffer.from(await importWorkbook.arrayBuffer());
  const unconfirmed = await fetch(base + '/api/data/import/preview?name=table.xlsx', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: fileBytes,
  });
  assert.equal(unconfirmed.status, 403); assert.equal((await unconfirmed.json()).code, 'CSRF_DENIED');
  const previewResponse = await fetch(base + '/api/data/import/preview?name=table.xlsx', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Tagent-Request': '1' }, body: fileBytes,
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.requiresConfirmation, true); assert.equal(preview.willWrite, false); assert.equal(preview.willExecute, false);
  assert.equal(preview.file.sha256, sha(fileBytes));
  assert.deepEqual(preview.sheets.map(sheet => sheet.name), ['说明', '月收入']);
  assert.deepEqual(preview.sheets[1].rows, cases.csv.data.split('\n').map(line => line.split(',')));
  assert.deepEqual(await json('/api/workspaces'), workspacesBeforeImport, 'File preview must not write workspace data');
  assert.equal(calls, 0, 'File preview must not call the model');
  for (const name of Object.keys(cases)) {
    const response = await fetch(base + (name === 'csv' ? '/api/agent/run' : '/api/agent/orchestrate'), { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, message: messageFor(name) }), signal: AbortSignal.timeout(45000) });
    assert.equal(response.status, 200);
    const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map(block => {
      const lines = block.split(/\r?\n/); return { type: lines.find(line => line.startsWith('event:'))?.slice(6).trim(),
        data: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')) };
    });
    assert.deepEqual(errors, []);
    const complete = events.filter(event => event.type === 'complete'); assert.equal(complete.length, 1);
    const result = complete[0].data;
    assert.equal(result.output, outputFor(name)); assert.equal(result.persisted, true);
    const traces = events.filter(event => event.type === 'workflow_event').map(event => event.data);
    const receipts = traces.filter(event => event.data?.tableAnalysis).map(event => event.data.tableAnalysis);
    assert.equal(receipts.length, 2, 'Inspect and aggregate receipts are preserved once each');
    assert.equal(receipts[1].provenance.sourceSha256, sha(messageFor(name)));
    assert.equal(receipts[1].provenance.selectionSha256, sha(cases[name].data));
    assert.equal(receipts[1].groups[0].metrics[0].status, name === 'invalid' ? 'invalid_values' : 'computed');
    assert.ok(traces.filter(event => event.type === 'agent_tool_call').every(event => ['read_data_source', 'analyze_table'].includes(event.toolName)));
    const session = await json(`/api/workspaces/${workspaceId}/sessions/${result.sessionId}`);
    assert.equal(session.messages.at(-1).content, result.output); assert.deepEqual(session.messages.at(-1).traces, traces);
    assert.notEqual(session.messages.at(-1).run.status, 'running');
    sessions.push({ workspaceId, id: result.sessionId, messages: session.messages });
  }
  const beforeRestart = calls; await stop(); await start();
  for (const session of sessions) assert.deepEqual((await json(`/api/workspaces/${session.workspaceId}/sessions/${session.id}`)).messages, session.messages);
  assert.equal(calls, beforeRestart, 'Restart must not recompute or repeat model calls');
  console.log(JSON.stringify({ status: 'passed', cases: sessions.length, fileImportPreview: true, localModelCalls: calls, realToolExecution: true, nativeSSE: true, persistedReceipts: true, restart: true, externalModelCalls: 0 }));
  if (serveMode) {
    console.log(JSON.stringify({ base, workspaceId, sessions: sessions.map((session, index) => ({ id: session.id, name: Object.keys(cases)[index] })),
      stopUrl: `http://127.0.0.1:${model.address().port}${controlPath}`, statusUrl: `http://127.0.0.1:${model.address().port}/fixture-status` }));
    await serving;
  }
} finally {
  await stop(); await new Promise(done => model.close(done));
  const rel = relative(tmpdir(), workspace); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(workspace, { recursive: true, force: true });
}
