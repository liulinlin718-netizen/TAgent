import { MODEL_PRICING, type LLMCallParams, type LLMProvider, type TokenUsage } from '../packages/tagent-ai/src/types.js';

export interface AcceptanceLimits { maxCalls: number; maxRecordedCost: number }

export function officeCaseAdmission(snapshot: AcceptanceLimits & { calls: number; unsettledRequests: number }) {
  // Conservative entry floor, not a full-run reservation: a sole office worker can finish in
  // three calls, but the plan is not known yet; extra workers/revisions may need more than four.
  const minimumCalls = 4;
  const remainingCalls = snapshot.maxCalls - snapshot.calls;
  if (snapshot.unsettledRequests > 0) return { allowed: false, reason: 'unsettled_usage', remainingCalls, minimumCalls };
  if (remainingCalls < minimumCalls) return { allowed: false, reason: 'insufficient_calls', remainingCalls, minimumCalls };
  return { allowed: true, remainingCalls, minimumCalls };
}

function validateLimits(limits: AcceptanceLimits) {
  if (!Number.isSafeInteger(limits.maxCalls) || limits.maxCalls < 1 || limits.maxCalls > 24
    || !Number.isFinite(limits.maxRecordedCost) || limits.maxRecordedCost <= 0 || limits.maxRecordedCost > 0.65) {
    throw new Error('Acceptance requires explicit limits: 1-24 calls and a positive recorded-cost threshold no greater than $0.65.');
  }
}

export function acceptanceOptions(args: string[]): AcceptanceLimits & { positional: string[] } {
  if (args.filter(value => value === '--live').length !== 1) throw new Error('Pass --live once to authorize real model acceptance.');
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--live') continue;
    if (arg === '--max-calls' || arg === '--max-recorded-cost') {
      const value = args[index + 1];
      if (values.has(arg) || !value || value.startsWith('--')) throw new Error('Missing or duplicate acceptance limit.');
      values.set(arg, value); index++;
    } else if (arg.startsWith('--')) throw new Error('Unknown acceptance option.');
    else positional.push(arg);
  }
  const limits = { maxCalls: Number(values.get('--max-calls')), maxRecordedCost: Number(values.get('--max-recorded-cost')) };
  validateLimits(limits);
  return { ...limits, positional };
}

export function reserveAcceptanceCost(params: LLMCallParams): number {
  const pricing = MODEL_PRICING[params.model];
  const output = params.maxTokens ?? 4096;
  if (!pricing || !Number.isSafeInteger(output) || output < 1 || output > 16384) {
    throw new Error('Manual acceptance requires a priced model and an explicit bounded output.');
  }
  // Conservative serialization/token margin, not a tokenizer or a provider billing quote.
  const input = Buffer.byteLength(JSON.stringify({ messages: params.messages, tools: params.tools }), 'utf8') * 4 + 8192;
  return (input * pricing.inputPer1M + output * pricing.outputPer1M) / 1_000_000;
}

/** Manual acceptance only. Live scripts reserve cost before dispatch; never infer provider billing. */
export function createAcceptanceProvider(underlying: LLMProvider, limits: AcceptanceLimits, reserveCost?: (params: LLMCallParams) => number) {
  validateLimits(limits);
  const policy = { maxCalls: limits.maxCalls, maxRecordedCost: limits.maxRecordedCost };
  let calls = 0, recordedCost = 0, activeCalls = 0, unknownUsageCalls = 0, reservedCost = 0;
  let admissionFailure: { reason: string; requiredReservation?: number; availableBudget: number } | undefined;
  const refuse = (reason: string, message: string, requiredReservation?: number): never => {
    admissionFailure = { reason, availableBudget: policy.maxRecordedCost - recordedCost - reservedCost,
      ...(requiredReservation === undefined ? {} : { requiredReservation }) };
    throw new Error(message);
  };
  const begin = (params: LLMCallParams) => {
    params.signal?.throwIfAborted();
    if (unknownUsageCalls) refuse('unknown_usage', 'Acceptance stopped: a previous request has uncertain usage; inspect it before authorizing more calls.');
    if (calls >= policy.maxCalls || recordedCost >= policy.maxRecordedCost) refuse('call_or_cost_limit', 'Manual acceptance call/cost guard reached; no automatic retry.');
    const reservation = reserveCost ? reserveCost(params) : 0;
    if (!Number.isFinite(reservation) || reservation < 0 || (reserveCost && reservation === 0)) refuse('invalid_reservation', 'Invalid acceptance cost reservation.');
    if (recordedCost + reservedCost + reservation > policy.maxRecordedCost) refuse('insufficient_reservation', 'Insufficient budget to reserve the next acceptance request.', reservation);
    admissionFailure = undefined;
    calls++; activeCalls++; reservedCost += reservation;
    let received = false, invalid = false;
    return {
      record(usage: TokenUsage | undefined) {
        if (received || !usage || ![usage.cost, usage.inputTokens, usage.outputTokens].every(value => Number.isFinite(value) && value >= 0)) {
          invalid = true;
          throw new Error('Acceptance received invalid or duplicate usage; billing is uncertain.');
        }
        recordedCost += usage.cost;
        received = true;
        if (reserveCost && usage.cost > reservation) {
          invalid = true;
          throw new Error('Reported cost exceeded its reservation; stop and reconcile provider billing.');
        }
      },
      requireUsage() { if (!received) throw new Error('Acceptance response ended without usage; billing is uncertain.'); },
      finish() {
        activeCalls--;
        if (!received || invalid) unknownUsageCalls++;
        else reservedCost = Math.max(0, reservedCost - reservation);
      },
    };
  };
  const provider: LLMProvider = {
    name: underlying.name,
    async call(params) {
      const request = begin(params);
      try {
        const response = await underlying.call(params);
        request.record(response.usage);
        return response;
      } finally { request.finish(); }
    },
    async *stream(params) {
      const request = begin(params);
      try {
        for await (const event of underlying.stream(params)) {
          if (event.type === 'usage') request.record(event.usage);
          yield event;
        }
        request.requireUsage();
      } finally { request.finish(); }
    },
  };
  return { provider, snapshot: () => ({ ...policy, calls, recordedCost, activeCalls, ...(reserveCost ? { reservedCost } : {}),
    ...(admissionFailure ? { admissionFailure: { ...admissionFailure } } : {}),
    unsettledRequests: activeCalls + unknownUsageCalls }) };
}
