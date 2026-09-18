import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OfficeReviewValidationError, parseOfficeReview, type OfficeMaterial } from '../packages/tagent-core/src/office-delivery.js';

// Offline diagnostic only: preserve the paid run and never reconstruct evidence from model citations.
const inputs = process.argv.slice(2);
assert.ok(inputs.length > 0 && inputs.length <= 6, 'Pass 1-6 captured office acceptance JSON files. No model requests are made.');
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const replays = [];
for (const input of inputs) {
  const originalArtifact = resolve(root, input);
  const original = await readFile(originalArtifact, 'utf8');
  const captured = JSON.parse(original);
  const previous = captured.result?.deliveryReview;
  assert.equal(typeof captured.task, 'string');
  assert.equal(typeof captured.result?.output, 'string');
  assert.equal(previous?.receipt?.status, 'received');
  assert.equal(previous.receipt.rawOutputTruncated, false, 'Cannot replay a truncated review');
  assert.equal(typeof previous.receipt.rawOutput, 'string');
  const materials: OfficeMaterial[] = [{ id: 'input', label: '用户提供的任务与材料', text: captured.task }];
  const traces = new Map<string, Array<{ tool: string; toolResult: string }>>();
  for (const event of captured.events.filter((item: { type: string }) => item.type === 'onAgentToolResult')) {
    const [agent, tool, length, context, receipt] = event.args;
    assert.match(agent, /^[a-zA-Z0-9_-]+$/);
    assert.match(context?.taskId, /^[a-zA-Z0-9_-]+$/);
    const key = `${agent}-${context.taskId}`;
    if (!traces.has(key)) {
      const lines = (await readFile(resolve(dirname(originalArtifact), 'traces', `${key}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      traces.set(key, lines.filter(line => line.agentId === agent && line.span?.type === 'tool_result').map(line => line.span));
    }
    const span = traces.get(key)!.shift();
    assert.equal(span?.tool, tool, 'Tool completion order mismatch');
    assert.equal(typeof span?.toolResult, 'string');
    const text = receipt ? JSON.stringify(receipt) : span!.toolResult;
    assert.equal(text.length, length, 'Missing full tool evidence; truncated traces cannot prove review citations');
    assert.equal(text.slice(0, 500), span!.toolResult, 'Receipt differs from the original tool trace');
    materials.push({ id: `tool-${materials.length}`, label: `实际工具返回：${tool}`, text });
  }
  let current;
  try { current = parseOfficeReview(previous.receipt.rawOutput, captured.task, captured.result.output, materials, captured.model, previous.blockSchema ?? 'paragraph-v1'); }
  catch (error) {
    if (!(error instanceof OfficeReviewValidationError)) throw error;
    current = error.review;
  }
  const changes = current.checks.filter(check => {
    const old = previous.checks.find((item: { id: string }) => item.id === check.id);
    return !old || old.status !== check.status || old.reason !== check.reason;
  });
  assert.equal(hash(await readFile(originalArtifact, 'utf8')), hash(original), 'Original acceptance record changed');
  replays.push({ originalArtifact, sha256: hash(original), role: captured.role,
    originalRunSuccess: captured.result.success, originalReviewStatus: previous.status,
    currentParserStatus: current.status, changes, review: current });
  console.log(JSON.stringify({ role: captured.role, originalReviewStatus: previous.status, currentParserStatus: current.status, changes }));
}
const artifact = resolve(root, 'output', `office-parser-replay-${Date.now()}.json`);
await writeFile(artifact, JSON.stringify({ mode: 'offline_parser_replay', modelCalls: 0, networkRequests: 0,
  note: 'Same recorded model judgments, original output and local tool receipts; not a new task or an independent content-quality approval.', replays }, null, 2), 'utf8');
console.log(JSON.stringify({ artifact, modelCalls: 0, networkRequests: 0, originalWrites: 0 }));
