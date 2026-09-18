import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptanceOptions, createAcceptanceProvider, reserveAcceptanceCost } from './model-acceptance.js';
import { assertUnusedOfficeReview } from './office-acceptance.js';

// One remaining call from an explicitly authorized fixed-material project batch. Never run in CI.
const limits = acceptanceOptions(process.argv.slice(2));
assert.equal(limits.maxCalls, 1, 'This acceptance only allows one review request.');
assert.ok(limits.positional.length === 1 || limits.positional.length === 2, 'Pass the original project acceptance artifact.');
const root = fileURLToPath(new URL('../', import.meta.url));
const originalArtifact = resolve(root, limits.positional[0]);
const original = await readFile(originalArtifact, 'utf8');
const captured = JSON.parse(original);
assert.equal(captured.role, 'project', 'Only the authorized synthetic project case is supported.');
assert.ok(captured.task === '仅根据以下给定材料完成办公任务，不联网、不创建文件、不发送消息。\n给出任务排期表和风险/验收标准。A需求确认2个工作日；B设计3日依赖A；C开发4日依赖B；D测试2日依赖C。第1工作日开始，无并行条件，不指定日历日期；研发负责人待定。标出总工期和责任缺口，不虚构人员。', 'Task must match the explicitly approved synthetic material.');
assert.equal(typeof captured.result?.output, 'string');
assert.ok(captured.result.output.length > 0 && captured.result.output.length <= 60000);
assert.ok(Array.isArray(captured.events) && captured.events.every((event: { type: string }) => event.type !== 'onAgentToolCall'), 'Do not externalize tool or private-file evidence.');
const prior = captured.acceptance;
assert.equal(prior?.activeCalls, 0); assert.equal(prior?.unsettledRequests, 0);
assert.ok(Number.isInteger(prior.maxCalls) && prior.maxCalls <= 8 && Number.isInteger(prior.calls) && prior.calls >= 0 && prior.maxCalls - prior.calls >= 1, 'No original call allowance remains.');
assert.ok(Number.isFinite(prior.recordedCost) && prior.recordedCost >= 0 && Number.isFinite(prior.reservedCost) && prior.reservedCost >= 0
  && Number.isFinite(prior.maxRecordedCost) && prior.maxRecordedCost > 0 && prior.maxRecordedCost <= .08);
assert.ok(limits.maxRecordedCost <= prior.maxRecordedCost - prior.recordedCost - prior.reservedCost, 'Review exceeds the original batch budget.');
const sha256 = createHash('sha256').update(original).digest('hex');
const firstClaim = resolve(root, 'output', `office-review-${sha256}.json`);
let resumedFrom: { artifact: string; sha256: string } | undefined;
if (limits.positional[1]) {
  const rejectedArtifact = resolve(root, limits.positional[1]);
  assert.ok(rejectedArtifact === firstClaim, 'Only the original zero-dispatch review may be resumed once.');
  const rejected = await readFile(rejectedArtifact, 'utf8');
  assertUnusedOfficeReview(JSON.parse(rejected), { sha256, originalArtifact });
  resumedFrom = { artifact: rejectedArtifact, sha256: createHash('sha256').update(rejected).digest('hex') };
}
const artifact = resumedFrom ? resolve(root, 'output', `office-review-${sha256}-confirmed-final.json`) : firstClaim;

const { CostTracker, OpenAIProvider } = await import('../packages/tagent-ai/dist/index.js');
const { verifyOfficeDelivery } = await import('../packages/tagent-core/src/office-delivery.js');
const { loadServerEnvironment, resolveModelConfig } = await import('../packages/tagent-server/src/config.js');
loadServerEnvironment(root);
const config = resolveModelConfig();
assert.equal(config.name, 'deepseek'); assert.equal(config.model, 'deepseek-flash');
assert.ok(config.baseURL === 'https://api.deepseek.com', 'Destination must match the explicitly authorized official endpoint.');
const acceptance = createAcceptanceProvider(new OpenAIProvider({ name: config.name, apiKey: config.apiKey,
  baseURL: config.baseURL, timeout: config.timeoutMs, maxRetries: 0 }), limits, reserveAcceptanceCost);
const record = { mode: 'single_pass_office_review', originalArtifact, sha256, maxCalls: 1, maxRecordedCost: limits.maxRecordedCost,
  ...(resumedFrom ? { resumedFrom } : {}),
  originalBatchCalls: prior.calls, originalBatchCost: prior.recordedCost, model: config.model,
  note: 'New model review of the same synthetic task/output; not a new generation, revision or UI/SSE run. Original record unchanged.' };
// A persisted exclusive claim prevents this script from resetting the last-call allowance on a rerun.
const claim = await open(artifact, 'wx');
try { await claim.writeFile(JSON.stringify({ ...record, state: 'started' }, null, 2), 'utf8'); await claim.sync(); }
finally { await claim.close(); }
console.log(JSON.stringify({ artifact, ...record }));
try {
  const result = await verifyOfficeDelivery({ provider: acceptance.provider, model: config.model, task: captured.task,
    output: captured.result.output, materials: [{ id: 'input', label: '用户提供的任务与材料', text: captured.task }],
    qualityChecks: [], maxRevisions: 0, costTracker: new CostTracker(), maxCost: limits.maxRecordedCost, signal: AbortSignal.timeout(90000) });
  assert.equal(createHash('sha256').update(await readFile(originalArtifact, 'utf8')).digest('hex'), sha256, 'Original acceptance record changed.');
  const snapshot = acceptance.snapshot();
  const state = snapshot.calls === 0 && snapshot.admissionFailure ? 'not_dispatched' : 'finished';
  await writeFile(artifact, JSON.stringify({ ...record, state, acceptance: snapshot, result }, null, 2), 'utf8');
  console.log(JSON.stringify({ artifact, state, status: result.review.status, coverage: result.review.coverage, ...snapshot, originalWrites: 0 }));
  if (result.review.status !== 'passed') process.exitCode = 1;
} catch (error) {
  await writeFile(artifact, JSON.stringify({ ...record, state: 'failed', acceptance: acceptance.snapshot(),
    error: error instanceof Error ? error.message : 'Review failed' }, null, 2), 'utf8');
  throw error;
}
