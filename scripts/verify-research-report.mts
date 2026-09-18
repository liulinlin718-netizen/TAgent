import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrchestratorResult } from '../packages/tagent-core/src/orchestrator.js';
import { acceptanceOptions, createAcceptanceProvider, reserveAcceptanceCost } from './model-acceptance.js';

// Manual, paid model replay of a captured source snapshot. Not a new search or an E2E acceptance.
const root = fileURLToPath(new URL('../', import.meta.url));
const limits = acceptanceOptions(process.argv.slice(2));
const [input] = limits.positional;
if (!input || limits.positional.length !== 1) throw new Error('Supply exactly one captured live-task artifact after the explicit acceptance flags.');
const { AnthropicProvider, OpenAIProvider, CostTracker } = await import('../packages/tagent-ai/dist/index.js');
const { generateResearchReport } = await import('../packages/tagent-core/src/research-report.js');
const { loadServerEnvironment, resolveModelConfig } = await import('../packages/tagent-server/src/config.js');
const originalArtifact = resolve(root, input);
const captured = JSON.parse(await readFile(originalArtifact, 'utf8')) as {
  message?: string; events?: Array<{ type: string; data: OrchestratorResult }>;
  query?: string; sources?: NonNullable<OrchestratorResult['research']>['sources'];
  assessment?: NonNullable<OrchestratorResult['research']>['assessment'];
};
const complete = captured.events?.filter(event => event.type === 'complete') || [];
const final = complete[0]?.data;
const task = captured.message || captured.query;
const research = captured.events
  ? (complete.length === 1 ? final?.research : undefined)
  : (Array.isArray(captured.sources) && captured.assessment ? { sources: captured.sources, assessment: captured.assessment } : undefined);
if (!task?.trim() || !research) throw new Error('Supply a captured task with one terminal result, or a live-research source snapshot; neither starts a new search.');
loadServerEnvironment(root);
const config = resolveModelConfig();
const options = { apiKey: config.apiKey, baseURL: config.baseURL, name: config.name, timeout: config.timeoutMs, maxRetries: 0 };
const acceptance = createAcceptanceProvider(config.name === 'anthropic' ? new AnthropicProvider(options) : new OpenAIProvider(options), limits, reserveAcceptanceCost);
const provider = acceptance.provider;
const costTracker = new CostTracker();
const started = Date.now();
const artifact = resolve(root, `output/report-replay-${started}.json`);
await mkdir(resolve(root, 'output'), { recursive: true });
let result: Awaited<ReturnType<typeof generateResearchReport>> | undefined;
let failure: string | undefined;
try {
  result = await generateResearchReport({ provider, model: config.model, task,
    sources: research.sources, assessment: research.assessment, costTracker, maxCost: Math.min(0.25, limits.maxRecordedCost),
    summaries: final?.subResults.map(item => item.summary).join('\n\n') || '',
    onVerify: () => console.log('Draft returned; reviewing cited passages.') });
  console.log(JSON.stringify({ mode: 'report_replay', success: result.success, cost: costTracker.totalCost,
    elapsedMs: Date.now() - started, review: result.review, artifact }));
  if (!result.success) process.exitCode = 1;
} catch (error) {
  failure = error instanceof Error ? error.message : 'Report replay failed';
  console.error(failure);
  process.exitCode = 1;
} finally {
  await writeFile(artifact, JSON.stringify({ mode: 'report_replay', originalArtifact, task,
    provider: config.name, model: config.model, elapsedMs: Date.now() - started, cost: costTracker.totalCost, acceptance: acceptance.snapshot(),
    sources: research.sources, assessment: research.assessment, result, failure }, null, 2), 'utf8');
}
