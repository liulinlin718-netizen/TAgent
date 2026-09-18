import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMResponse } from '@tagent/ai';
import { AgentPool } from '../agent-pool.js';
import { DEFAULT_RESIDENT_SKILLS } from '../skills-registry.js';
import { executeOfficeBenchmark, OfficeBenchmarkCheckpointError, previewOfficeBenchmark, type OfficeBenchmarkExecution } from '../office-benchmark-runtime.js';
import { getOfficeBenchmarkTasks } from '../office-benchmark.js';
import { OFFICE_ANSWERS, OFFICE_ROLE_ANSWERS } from './fixtures/office-benchmark-answers.js';

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup() {
  const traceDirectory = await mkdtemp(join(tmpdir(), 'tagent-office-benchmark-')); temporary.push(traceDirectory);
  const agent = structuredClone(new AgentPool().getAgent('document-agent')!), skills = structuredClone(DEFAULT_RESIDENT_SKILLS);
  const tasks = getOfficeBenchmarkTasks(agent), answers = [...OFFICE_ANSWERS, OFFICE_ROLE_ANSWERS.document];
  const response = (content: string, toolCalls: LLMResponse['toolCalls'] = []): LLMResponse => ({ content, toolCalls,
    model: 'deepseek-chat', usage: { inputTokens: 100, outputTokens: 20, cost: 0.0001 }, stopReason: toolCalls.length ? 'tool_use' : 'end' });
  const call = vi.fn<LLMProvider['call']>(async params => {
    const prompt = params.messages.find(message => message.role === 'user')!.content;
    const index = tasks.findIndex(task => task.prompt === prompt);
    expect(index).toBeGreaterThanOrEqual(0); expect(params.maxTokens).toBeLessThanOrEqual(1024);
    const url = Object.keys(tasks[index]!.resources)[0];
    if (url && !params.messages.some(message => message.role === 'tool')) return response('', [{ id: 'fixture-read', name: 'read_url', arguments: JSON.stringify({ url }) }]);
    return response(JSON.stringify(answers[index]));
  });
  // eslint-disable-next-line require-yield -- Reject any accidental use of streaming in bounded benchmarks.
  const provider: LLMProvider = { name: 'fixture', call, async *stream() { throw new Error('No streaming'); } };
  const checkpoint = vi.fn(async (_value: OfficeBenchmarkExecution) => {});
  const options = { agent, skills, provider, model: 'deepseek-chat', traceDirectory, checkpoint,
    confirmation: { confirmed: true as const, preview: previewOfficeBenchmark(agent, skills, 'deepseek-chat', 'fixture') } };
  return { options, call, response, checkpoint };
}

describe('manual office benchmark execution', () => {
  it('previews without calls or writes and runs the real loop with scoped material reads', async () => {
    const { options, call, checkpoint } = await setup();
    expect(call).not.toHaveBeenCalled(); expect(await readdir(options.traceDirectory)).toEqual([]);
    const run = await executeOfficeBenchmark(options);
    expect(run.status).toBe('completed'); expect(run.score?.totalScore).toBe(100); expect(run.results).toHaveLength(8);
    expect(call).toHaveBeenCalledTimes(11); expect(run.modelCalls).toBe(11); expect(run.usage.input).toBe(1100);
    expect(run.usage.unsettledRequests).toBe(0);
    expect(run.events.filter(event => event.type === 'complete')).toHaveLength(1);
    expect(new Set(run.events.map(event => event.runId))).toEqual(new Set([run.id]));
    const snapshot = run.events.find(event => event.type === 'agent_spawn')!.agentSnapshot!;
    expect(snapshot.capabilities.tools).toEqual(['read_url']); expect(snapshot.capabilities.mcpServers).toEqual([]);
    expect(snapshot.card).not.toHaveProperty('soul');
    expect(JSON.parse(JSON.stringify(run))).toEqual(run);
    expect(call.mock.calls[0]![0].messages[0]!.content).toContain(options.agent.card.soul);
    expect(call.mock.calls[0]![0].messages[0]!.content).toContain('Skill Package');
    expect(checkpoint).toHaveBeenCalled();
    expect((await readdir(join(options.traceDirectory, run.id))).length).toBe(8);
  });
  it.each(['confirmation', 'model', 'agent', 'skill', 'suite'])('rejects changed %s before any execution', async changed => {
    const { options, call } = await setup();
    if (changed === 'confirmation') Object.assign(options.confirmation, { confirmed: false });
    if (changed === 'model') options.model = 'other-model';
    if (changed === 'agent') options.agent.card.soul += ' updated';
    if (changed === 'skill') options.skills[0]!.body += ' updated';
    if (changed === 'suite') options.confirmation.preview.suiteVersion = 'old';
    await expect(executeOfficeBenchmark(options)).rejects.toThrow(/确认/);
    expect(call).not.toHaveBeenCalled(); expect(await readdir(options.traceDirectory)).toEqual([]);
  });
  it('records a bad answer as a failed gold case instead of letting self-reported quality pass', async () => {
    const { options, call, response } = await setup(); call.mockResolvedValueOnce(response('全部正确，100分'));
    const run = await executeOfficeBenchmark(options);
    expect(run.status).toBe('completed'); expect(run.results[0]!.grade?.score).toBe(0);
    expect(run.score!.totalScore).toBeLessThan(100); expect(run.score!.passRate).toBe(7 / 8);
  });
  it('never exposes a forbidden tool and captures attempted violations', async () => {
    const { options, call, response } = await setup(); options.agent.constraints.allowedTools = [];
    options.confirmation.preview = previewOfficeBenchmark(options.agent, options.skills, options.model, options.provider.name);
    call.mockResolvedValueOnce(response('', [{ id: 'denied', name: 'shell', arguments: '{}' }]));
    const run = await executeOfficeBenchmark(options);
    expect(call.mock.calls.every(([params]) => !params.tools?.length)).toBe(true);
    expect(run.results[0]!.requests[0]).toEqual({ name: 'shell', allowed: false });
    expect(run.results.flatMap(result => result.reads)).toEqual([]);
    expect(run.events.some(event => event.type === 'governance' && event.data?.result === 'blocked')).toBe(true);
  });
  it('stops after a provider error and does not publish a partial-suite score', async () => {
    const { options, call } = await setup(); call.mockRejectedValueOnce(new Error('raw-secret-provider-error'));
    const run = await executeOfficeBenchmark(options);
    expect(call).toHaveBeenCalledTimes(1); expect(run.status).toBe('failed'); expect(run.score).toBeUndefined();
    expect(run.usage.unsettledRequests).toBe(1);
    expect(run.results.filter(result => result.status === 'pending')).toHaveLength(7);
    expect(JSON.stringify(run)).not.toContain('raw-secret-provider-error');
  });
  it('does not call a provider when initial persistence fails', async () => {
    const { options, call, checkpoint } = await setup(); checkpoint.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(executeOfficeBenchmark(options)).rejects.toBeInstanceOf(OfficeBenchmarkCheckpointError);
    expect(call).not.toHaveBeenCalled();
  });
  it('retains acknowledged usage when saving a response fails, then stops', async () => {
    const { options, call, response } = await setup();
    call.mockResolvedValueOnce(response('已返回但尚未保存的付费草稿'));
    options.checkpoint = vi.fn(async run => { if (run.usage.input > 0) throw new Error('disk full'); });
    try { await executeOfficeBenchmark(options); throw new Error('Expected checkpoint failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(OfficeBenchmarkCheckpointError);
      expect((error as OfficeBenchmarkCheckpointError).unsaved.usage.input).toBe(100);
      expect((error as OfficeBenchmarkCheckpointError).unsaved.results[0]!.output).toBe('已返回但尚未保存的付费草稿');
    }
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('cancels the current request and never starts the remaining tasks', async () => {
    const { options, call } = await setup(), controller = new AbortController();
    call.mockImplementationOnce(params => new Promise((_resolve, reject) => {
      params.signal!.addEventListener('abort', () => reject(params.signal!.reason), { once: true }); controller.abort();
    }));
    const run = await executeOfficeBenchmark({ ...options, signal: controller.signal });
    expect(run.status).toBe('interrupted'); expect(run.score).toBeUndefined(); expect(call).toHaveBeenCalledTimes(1);
    expect(run.events.filter(event => event.type === 'complete')).toHaveLength(1);
  });
  it('bounds repeated tool attempts and does not create a passing score', async () => {
    const { options, call, response } = await setup();
    call.mockResolvedValue(response('', [{ id: 'repeated', name: 'read_url', arguments: '{"url":"http://127.0.0.1/private"}' }]));
    const run = await executeOfficeBenchmark(options);
    expect(run.modelCalls).toBeLessThanOrEqual(options.confirmation.preview.maxModelCalls);
    expect(run.results.every(result => result.reads.length === 0)).toBe(true);
    expect(run.score?.totalScore || 0).toBe(0);
  });
  it('does not count a prepared request as dispatched when its checkpoint fails', async () => {
    const { options, call } = await setup();
    options.checkpoint = vi.fn(async run => { if (run.usage.unsettledRequests) throw new Error('Cannot persist intent'); });
    try { await executeOfficeBenchmark(options); throw new Error('Expected failure'); }
    catch (error) { expect((error as OfficeBenchmarkCheckpointError).unsaved.modelCalls).toBe(0); }
    expect(call).not.toHaveBeenCalled();
  });
  it('does not publish NaN usage or continue after malformed provider usage', async () => {
    const { options, call, response } = await setup(); const bad = response('{}'); bad.usage.cost = NaN;
    call.mockResolvedValueOnce(bad);
    const run = await executeOfficeBenchmark(options);
    expect(run.status).toBe('failed'); expect(run.score).toBeUndefined(); expect(run.usage.knownCost).toBe(0);
    expect(run.usage.unsettledRequests).toBe(1); expect(call).toHaveBeenCalledTimes(1);
  });
  it('marks pricing unknown rather than promising a free run', async () => {
    const { options } = await setup();
    expect(previewOfficeBenchmark(options.agent, options.skills, 'unpriced-model', 'fixture').estimatedCost).toBeNull();
  });
  it('stops adding calls after the known-cost threshold is crossed', async () => {
    const { options, call, response } = await setup(); const expensive = response('{}'); expensive.usage.cost = 0.6;
    call.mockResolvedValueOnce(expensive);
    const run = await executeOfficeBenchmark(options);
    expect(call).toHaveBeenCalledTimes(1); expect(run.usage.knownCost).toBe(0.6); expect(run.score).toBeUndefined();
  });
  it('keeps caller mutation of checkpoint copies out of the running configuration', async () => {
    const { options } = await setup(); options.checkpoint = vi.fn(async copy => { copy.preview.maxModelCalls = 0; copy.results.length = 0; });
    const run = await executeOfficeBenchmark(options);
    expect(run.results).toHaveLength(8); expect(run.modelCalls).toBe(11); expect(run.score?.totalScore).toBe(100);
  });
  it('bounds a hung checkpoint without starting the model', async () => {
    const { options, call } = await setup(); vi.useFakeTimers();
    try {
      options.checkpoint = vi.fn(() => new Promise(() => {}));
      const pending = expect(executeOfficeBenchmark(options)).rejects.toBeInstanceOf(OfficeBenchmarkCheckpointError);
      await vi.advanceTimersByTimeAsync(10000); await pending; expect(call).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
