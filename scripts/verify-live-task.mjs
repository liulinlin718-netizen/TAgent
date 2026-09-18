import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Require deliberate execution before creating artifacts or submitting a paid task.
if (process.argv.filter(value => value === '--live').length !== 1) {
  throw new Error('Pass --live once to authorize a real task, model costs, network requests and session writes.');
}
const base = process.env.TAGENT_API_URL || 'http://127.0.0.1:3001';
const message = process.argv.slice(2).filter(value => value !== '--live').join(' ') || '近 30 天 AI Agent 最新进展';
const started = Date.now();
const events = [];
let session;
const artifact = new URL(`../output/live-task-${started}.json`, import.meta.url);
await mkdir(new URL('../output/', import.meta.url), { recursive: true });

function consume(block) {
  const lines = block.split(/\r?\n/);
  const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
  if (!type) return;
  const data = JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
  if (type === 'text_delta') return;
  events.push({ type, data });
  if (type === 'session') session = data;
  if (type === 'workflow_event') console.log(JSON.stringify({ elapsedMs: Date.now() - started, type: data.type, agentId: data.agentId, summary: data.summary }));
  if (type === 'session') console.log(JSON.stringify({ session }));
}

try {
  const response = await fetch(`${base}/api/agent/orchestrate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(1200000),
  });
  assert.equal(response.status, 200, `HTTP ${response.status}`);
  assert.ok(response.body);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      consume(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  const complete = events.filter(event => event.type === 'complete');
  assert.equal(complete.length, 1, 'Exactly one final completion is required');
  const result = complete[0].data;
  assert.ok(result.output?.trim(), 'Final output must not be empty');
  const workflow = events.filter(event => event.type === 'workflow_event').map(event => event.data);
  assert.equal(workflow.filter(event => event.type === 'complete').length, 1);
  assert.equal(new Set(workflow.map(event => event.runId)).size, 1);
  const savedResponse = await fetch(`${base}/api/workspaces/${result.workspaceId}/sessions/${result.sessionId}`, { signal: AbortSignal.timeout(10000) });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.messages.at(-1).content, result.output, 'Stored and streamed final output must match');
  assert.equal(saved.messages.at(-1).cost, result.totalCost, 'Stored and streamed costs must match');
  assert.deepEqual(saved.messages.at(-1).research, result.research, 'Source evidence and report review must survive reload');
  console.log(JSON.stringify({ elapsedMs: Date.now() - started, success: result.success, cost: result.totalCost,
    assessment: result.research?.assessment, outputLength: result.output.length, workflowEvents: workflow.length,
    artifact: fileURLToPath(artifact), contentReview: 'pending' }));
  assert.equal(result.success, true, 'Task returned a degraded or insufficient-evidence report, not an accepted deliverable');
  if (result.research) {
    assert.equal(result.research.assessment.status, 'sufficient_evidence');
    assert.equal(result.research.review?.passed, true, 'Report conclusions must pass evidence and task checks, not just page counts');
    assert.ok(result.research.review.checks.length > 0);
    assert.deepEqual(workflow.find(event => event.type === 'complete').data.researchReview, result.research.review);
    assert.ok(workflow.some(event => event.type === 'agent_tool_call' && event.toolName === 'web_research'));
  }
} catch (error) {
  console.error(error.message);
  if (!events.some(event => event.type === 'complete')) console.error('No terminal result observed. Inspect this session before retrying; a client timeout does not cancel the server task.', session);
  process.exitCode = 1;
} finally {
  await writeFile(artifact, JSON.stringify({ message, startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, session, events }, null, 2), 'utf8');
}
