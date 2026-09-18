import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunRegistry, RunAdmissionError } from '../runs.js';
afterEach(() => vi.useRealTimers());
describe('run registry', () => {
  it('rejects duplicate session work until execution, stopping and persistence are all finished', () => {
    vi.useFakeTimers();
    const runs = new RunRegistry(1000, 2), first = runs.create('w', 's');
    const duplicate = () => runs.create('w', 's');
    expect(duplicate).toThrow(RunAdmissionError);
    runs.stop(first.runId);
    expect(duplicate).toThrow('此会话已有任务');
    runs.finalizing(first.runId);
    expect(duplicate).toThrow('此会话已有任务');
    runs.finish(first.runId, true);
    const next = runs.create('w', 's');
    expect(next.runId).not.toBe(first.runId);
    runs.finish(next.runId, true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reserves capacity before asynchronous setup and releases a failed setup idempotently', () => {
    vi.useFakeTimers();
    const runs = new RunRegistry(1000, 2);
    const first = runs.reserve('w', 'a'), second = runs.reserve();
    expect(() => runs.reserve('w', 'a')).toThrow('此会话已有任务');
    expect(() => runs.reserve('w', 'b')).toThrow('当前已有 2 个任务');
    second.release(); second.release();
    const active = first.start('w', 'a'); first.release();
    const other = runs.create('w', 'b');
    expect(() => first.start('w', 'c')).toThrow('already');
    runs.stop(other.runId);
    expect(() => runs.reserve()).toThrow('当前已有 2 个任务');
    runs.finish(active.runId, false); runs.finish(other.runId, true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks a resolved session identity and keeps independent sessions/workspaces usable', () => {
    vi.useFakeTimers();
    const runs = new RunRegistry(1000, 3), prepared = runs.reserve();
    const one = runs.create('w', 's'), two = runs.create('another-w', 's');
    expect(() => prepared.start('w', 's')).toThrow('此会话已有任务');
    prepared.release();
    const three = runs.create('w', 'another-s');
    for (const run of [one, two, three]) runs.finish(run.runId, true);
  });

  it.each([0, -1, 1.5, 17, NaN, Infinity])('rejects invalid task capacity %s', limit => {
    expect(() => new RunRegistry(1000, limit)).toThrow('TAGENT_MAX_ACTIVE_RUNS');
  });

  it('acknowledges cancellation without claiming cleanup already finished', () => {
    const runs = new RunRegistry(), run = runs.create('workspace', 'session');
    expect(runs.stop(run.runId)).toMatchObject({ status: 'stopping', termination: 'cancelled' });
    expect(run.signal.aborted).toBe(true);
    expect(runs.stop(run.runId, 'disconnected')?.termination).toBe('cancelled');
    runs.finalizing(run.runId); runs.finish(run.runId, true);
    expect(runs.get(run.runId)).toMatchObject({ status: 'finished', persisted: true });
  });
  it('applies a total runtime deadline and clears it during final persistence', () => {
    vi.useFakeTimers();
    const runs = new RunRegistry(1000), first = runs.create('w', 'a'), second = runs.create('w', 'b');
    runs.finalizing(first.runId);
    vi.advanceTimersByTime(1000);
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(true);
    expect(runs.get(second.runId)?.termination).toBe('deadline');
    runs.finish(first.runId, false); runs.finish(second.runId, true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects invalid deadlines and does not expose controllers', () => {
    expect(() => new RunRegistry(0)).toThrow();
    const runs = new RunRegistry(), run = runs.create('w', 's');
    expect(runs.get(run.runId)).not.toHaveProperty('controller');
    expect(runs.stop('unknown')).toBeUndefined();
    runs.finish(run.runId, true);
  });
});
