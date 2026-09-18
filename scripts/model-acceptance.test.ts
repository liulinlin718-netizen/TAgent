import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMResponse, LLMStreamEvent, TokenUsage } from '../packages/tagent-ai/src/types.js';
import { acceptanceOptions, createAcceptanceProvider, officeCaseAdmission, reserveAcceptanceCost } from './model-acceptance.js';

const params = { model: 'fixture', messages: [] };
const usage = (cost = 0.01): TokenUsage => ({ inputTokens: 10, outputTokens: 5, cost });
const response = (cost = 0.01): LLMResponse => ({ content: 'fixture', toolCalls: [], model: 'fixture', stopReason: 'end', usage: usage(cost) });
function fixture(): LLMProvider {
  return { name: 'fixture', call: vi.fn(async () => response()), stream: vi.fn(async function* () {
    yield { type: 'text_delta', content: 'fixture' } as LLMStreamEvent;
    yield { type: 'usage', usage: usage() } as LLMStreamEvent;
    yield { type: 'done' } as LLMStreamEvent;
  }) };
}
async function collect(provider: LLMProvider) { const events = []; for await (const event of provider.stream(params)) events.push(event); return events; }

describe('manual acceptance consent and limits', () => {
  it('does not start a new office case with only enough calls for a partial draft', async () => {
    const upstream = fixture(), wrapped = createAcceptanceProvider(upstream, { maxCalls: 8, maxRecordedCost: .08 });
    for (let index = 0; index < 6; index++) await wrapped.provider.call(params);
    const before = wrapped.snapshot();
    expect(officeCaseAdmission(before)).toEqual({ allowed: false, reason: 'insufficient_calls', remainingCalls: 2, minimumCalls: 4 });
    expect(wrapped.snapshot()).toEqual(before);
    expect(upstream.call).toHaveBeenCalledTimes(6);
    expect(officeCaseAdmission({ ...before, calls: 4 })).toEqual({ allowed: true, remainingCalls: 4, minimumCalls: 4 });
    expect(officeCaseAdmission({ ...before, calls: 3, unsettledRequests: 1 })).toMatchObject({ allowed: false, reason: 'unsettled_usage' });
  });
  it('requires explicit limits, keeps them separate from selected roles/files, and snapshots policy', () => {
    const options = acceptanceOptions(['research', '--live', '--max-calls', '8', '--max-recorded-cost', '0.20']);
    expect(options).toEqual({ maxCalls: 8, maxRecordedCost: 0.2, positional: ['research'] });
    const wrapped = createAcceptanceProvider(fixture(), options);
    options.maxCalls = 24;
    expect(wrapped.snapshot()).toEqual({ maxCalls: 8, maxRecordedCost: .2, calls: 0, recordedCost: 0, activeCalls: 0, unsettledRequests: 0 });
  });
  it.each([
    [], ['--live', '--live'], ['--live'], ['--live', '--max-calls', '8'],
    ['--live', '--max-calls', '0', '--max-recorded-cost', '.2'],
    ['--live', '--max-calls', '25', '--max-recorded-cost', '.2'],
    ['--live', '--max-calls', '1.5', '--max-recorded-cost', '.2'],
    ['--live', '--max-calls', '8', '--max-recorded-cost', 'NaN'],
    ['--live', '--max-calls', '8', '--max-recorded-cost', 'Infinity'],
    ['--live', '--max-calls', '8', '--max-recorded-cost', '0'],
    ['--live', '--max-calls', '8', '--max-recorded-cost', '.66'],
    ['--live', '--max-calls', '8', '--max-calls', '9', '--max-recorded-cost', '.2'],
    ['--live', '--max-calls', '--max-recorded-cost', '.2'],
    ['--live', '--max-calls', '8', '--max-recorded-cost', '.2', '--unknown'],
  ])('rejects missing, ambiguous or invalid authorization arguments: %j', (...args) => {
    expect(() => acceptanceOptions(args)).toThrow();
  });
});

describe('manual acceptance provider accounting', () => {
  it('reserves the next request before dispatch and releases only known usage', async () => {
    const upstream = fixture(), wrapped = createAcceptanceProvider(upstream, { maxCalls: 8, maxRecordedCost: .025 }, () => .02);
    await wrapped.provider.call(params);
    expect(wrapped.snapshot()).toMatchObject({ calls: 1, recordedCost: .01, reservedCost: 0 });
    await expect(collect(wrapped.provider)).rejects.toThrow('Insufficient budget');
    expect(upstream.stream).not.toHaveBeenCalled();
  });
  it('includes concurrent reservations in the admission budget', async () => {
    const upstream = fixture(); let release!: (value: LLMResponse) => void;
    upstream.call = vi.fn(() => new Promise<LLMResponse>(resolve => { release = resolve; }));
    const wrapped = createAcceptanceProvider(upstream, { maxCalls: 8, maxRecordedCost: .03 }, () => .02);
    const pending = wrapped.provider.call(params);
    expect(wrapped.snapshot()).toMatchObject({ calls: 1, reservedCost: .02 });
    await expect(collect(wrapped.provider)).rejects.toThrow('Insufficient budget');
    release(response()); await pending;
    expect(wrapped.snapshot().reservedCost).toBe(0);
  });
  it('records a local reservation refusal without claiming a dispatched or billable request', async () => {
    const upstream = fixture(), wrapped = createAcceptanceProvider(upstream, { maxCalls: 1, maxRecordedCost: .04 }, () => .06);
    await expect(wrapped.provider.call(params)).rejects.toThrow('Insufficient budget');
    expect(wrapped.snapshot()).toMatchObject({ calls: 0, recordedCost: 0, reservedCost: 0, activeCalls: 0, unsettledRequests: 0,
      admissionFailure: { reason: 'insufficient_reservation', requiredReservation: .06, availableBudget: .04 } });
    expect(upstream.call).not.toHaveBeenCalled();
  });
  it('keeps a prior unknown request distinct from a new admission refusal', async () => {
    const upstream = fixture(); upstream.call = vi.fn(async () => { throw new Error('offline'); });
    const wrapped = createAcceptanceProvider(upstream, { maxCalls: 2, maxRecordedCost: .04 }, () => .02);
    await expect(wrapped.provider.call(params)).rejects.toThrow('offline');
    await expect(wrapped.provider.call(params)).rejects.toThrow('uncertain usage');
    expect(wrapped.snapshot()).toMatchObject({ calls: 1, reservedCost: .02, unsettledRequests: 1,
      admissionFailure: { reason: 'unknown_usage', availableBudget: .02 } });
    expect(upstream.call).toHaveBeenCalledTimes(1);
  });
  it('keeps the full reservation if a request ends without known usage', async () => {
    const upstream = fixture(); upstream.call = vi.fn(async () => { throw new Error('offline'); });
    const wrapped = createAcceptanceProvider(upstream, { maxCalls: 8, maxRecordedCost: .2 }, () => .02);
    await expect(wrapped.provider.call(params)).rejects.toThrow('offline');
    expect(wrapped.snapshot()).toMatchObject({ reservedCost: .02, recordedCost: 0, unsettledRequests: 1 });
    await expect(collect(wrapped.provider)).rejects.toThrow('uncertain usage');
  });
  it('stops if the supplier reports costs above the reservation rather than continuing on a false bound', async () => {
    const wrapped = createAcceptanceProvider(fixture(), { maxCalls: 8, maxRecordedCost: .2 }, () => .005);
    await expect(wrapped.provider.call(params)).rejects.toThrow('exceeded its reservation');
    expect(wrapped.snapshot()).toMatchObject({ reservedCost: .005, recordedCost: .01, unsettledRequests: 1 });
    await expect(collect(wrapped.provider)).rejects.toThrow('uncertain usage');
  });
  it('prices the complete message/tool payload with headroom and bounded output tokens', () => {
    const base = { ...params, model: 'deepseek-flash', maxTokens: 4096 };
    const small = reserveAcceptanceCost(base);
    const large = reserveAcceptanceCost({ ...base, messages: [{ role: 'user', content: '中文'.repeat(200) }],
      tools: [{ name: 'fixture', description: 'tool', parameters: { type: 'object' } }] });
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(4096 * 1.2 / 1_000_000);
    expect(() => reserveAcceptanceCost(params)).toThrow('priced model');
    expect(() => reserveAcceptanceCost({ ...base, maxTokens: 0 })).toThrow();
    expect(() => reserveAcceptanceCost({ ...base, maxTokens: 1_000_000 })).toThrow();
  });
  it('counts call and stream together, without starting a stream merely because its iterator exists', async () => {
    const upstream = fixture(), wrapped = createAcceptanceProvider(upstream, { maxCalls: 2, maxRecordedCost: .2 });
    const iterator = wrapped.provider.stream(params);
    expect(wrapped.snapshot().calls).toBe(0);
    await wrapped.provider.call(params);
    for await (const event of iterator) expect(event.type).toBeDefined();
    expect(wrapped.snapshot()).toMatchObject({ calls: 2, recordedCost: .02, activeCalls: 0, unsettledRequests: 0 });
    await expect(wrapped.provider.call(params)).rejects.toThrow('guard reached');
    await expect(collect(wrapped.provider)).rejects.toThrow('guard reached');
    expect(upstream.call).toHaveBeenCalledTimes(1); expect(upstream.stream).toHaveBeenCalledTimes(1);
  });
  it('reserves calls before awaiting concurrent results and never refunds a started request', async () => {
    const upstream = fixture();
    let release!: (value: LLMResponse) => void;
    upstream.call = vi.fn(() => new Promise<LLMResponse>(resolve => { release = resolve; }));
    const wrapped = createAcceptanceProvider(upstream, { maxCalls: 1, maxRecordedCost: .2 });
    const pending = wrapped.provider.call(params);
    expect(wrapped.snapshot()).toMatchObject({ calls: 1, activeCalls: 1, unsettledRequests: 1 });
    await expect(collect(wrapped.provider)).rejects.toThrow('guard reached');
    release(response()); await pending;
    expect(upstream.call).toHaveBeenCalledTimes(1); expect(upstream.stream).not.toHaveBeenCalled();
  });
  it('stops admission after the recorded threshold, not claiming it is a hard billing cap', async () => {
    const upstream = fixture(); upstream.call = vi.fn(async () => response(.21));
    const wrapped = createAcceptanceProvider(upstream, { maxCalls: 8, maxRecordedCost: .2 });
    await wrapped.provider.call(params);
    expect(wrapped.snapshot().recordedCost).toBe(.21);
    await expect(collect(wrapped.provider)).rejects.toThrow('guard reached');
    expect(upstream.stream).not.toHaveBeenCalled();
  });
  it('does not admit an already-cancelled request or count it as unknown billing', async () => {
    const upstream = fixture(), wrapped = createAcceptanceProvider(upstream, { maxCalls: 8, maxRecordedCost: .2 });
    const signal = AbortSignal.abort(new Error('Stopped before dispatch'));
    await expect(wrapped.provider.call({ ...params, signal })).rejects.toThrow('Stopped before dispatch');
    await expect((async () => { for await (const _event of wrapped.provider.stream({ ...params, signal })) throw new Error('Unexpected stream'); })())
      .rejects.toThrow('Stopped before dispatch');
    expect(wrapped.snapshot()).toMatchObject({ calls: 0, activeCalls: 0, unsettledRequests: 0 });
    expect(upstream.call).not.toHaveBeenCalled(); expect(upstream.stream).not.toHaveBeenCalled();
  });
  it('retains unknown usage after a failed call and refuses automatic continuation', async () => {
    const upstream = fixture(); upstream.call = vi.fn(async () => { throw new Error('Connection lost'); });
    const wrapped = createAcceptanceProvider(upstream, { maxCalls: 8, maxRecordedCost: .2 });
    await expect(wrapped.provider.call(params)).rejects.toThrow('Connection lost');
    expect(wrapped.snapshot()).toMatchObject({ calls: 1, recordedCost: 0, unsettledRequests: 1, activeCalls: 0 });
    await expect(collect(wrapped.provider)).rejects.toThrow('uncertain usage');
    expect(upstream.stream).not.toHaveBeenCalled();
  });
  it.each(['break', 'throw', 'no-usage', 'duplicate-usage'])('retains streaming uncertainty and closes the upstream iterator: %s', async mode => {
    const closed = vi.fn(), upstream = fixture();
    upstream.stream = vi.fn(async function* () {
      try {
        yield { type: 'text_delta', content: 'partial' } as LLMStreamEvent;
        if (mode === 'throw') throw new Error('Connection lost');
        if (mode === 'duplicate-usage') {
          yield { type: 'usage', usage: usage(.03) } as LLMStreamEvent;
          yield { type: 'usage', usage: usage(.03) } as LLMStreamEvent;
        }
        yield { type: 'done' } as LLMStreamEvent;
      } finally { closed(); }
    });
    const wrapped = createAcceptanceProvider(upstream, { maxCalls: 8, maxRecordedCost: .2 });
    if (mode === 'break') { for await (const _event of wrapped.provider.stream(params)) break; }
    else await expect(collect(wrapped.provider)).rejects.toThrow();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(wrapped.snapshot()).toMatchObject({ calls: 1, activeCalls: 0, unsettledRequests: 1, recordedCost: mode === 'duplicate-usage' ? .03 : 0 });
    await expect(wrapped.provider.call(params)).rejects.toThrow('uncertain usage');
    expect(upstream.call).not.toHaveBeenCalled();
  });
  it('rejects malformed usage without making the remaining budget NaN', async () => {
    const upstream = fixture(); upstream.call = vi.fn(async () => response(NaN));
    const wrapped = createAcceptanceProvider(upstream, { maxCalls: 8, maxRecordedCost: .2 });
    await expect(wrapped.provider.call(params)).rejects.toThrow('invalid or duplicate usage');
    expect(wrapped.snapshot()).toMatchObject({ calls: 1, recordedCost: 0, unsettledRequests: 1 });
    await expect(wrapped.provider.call(params)).rejects.toThrow('uncertain usage');
  });
});
