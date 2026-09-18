import { describe, expect, it } from 'vitest';
import { buildResearchSmokePayload } from '../research-smoke.js';

describe('research smoke payload', () => {
  it('returns a final report with required research evidence fields', () => {
    const payload = buildResearchSmokePayload(
      '近 30 天 AI Agent 最新进展',
      new Date('2026-06-18T02:00:00.000Z'),
    );

    expect(payload.output).toContain('调研日期');
    expect(payload.output).toContain('来源日期线索');
    expect(payload.output).toContain('https://');
    expect(payload.output).toContain('可验证性');
    expect(payload.output).toContain('不足以验证');
    expect(payload.output).toContain('research_smoke');
  });

  it('emits workflow events compatible with the real research flow', () => {
    const payload = buildResearchSmokePayload('近 30 天 AI Agent 最新进展');
    const eventTypes = payload.events.map(event => event.type);

    expect(eventTypes).toContain('task_decomposition');
    expect(eventTypes).toContain('agent_spawn');
    expect(eventTypes).toContain('agent_tool_call');
    expect(eventTypes).toContain('agent_tool_result');
    expect(eventTypes).toContain('governance');
    expect(eventTypes).toContain('synthesis_start');
    expect(eventTypes).toContain('agent_complete');
    expect(payload.events.some(event =>
      event.type === 'agent_tool_call' &&
      event.data.agentId === 'research-agent' &&
      event.data.tool === 'web_research',
    )).toBe(true);
    expect(payload.events.filter(event => event.data.agentId).every(event => event.data.taskId === 'smoke-research')).toBe(true);
    const snapshot = payload.events.find(event => event.type === 'agent_spawn')?.agentSnapshot;
    expect(snapshot?.version).toBe(1);
    expect(snapshot?.name).toContain('验收样例');
    expect(snapshot?.constraints.maxCostPerTask).toBe(0);
  });
});
