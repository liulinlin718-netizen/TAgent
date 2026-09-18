import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestToolApproval, type ApprovalRequest } from '../tool-approval.js';
afterEach(() => vi.useRealTimers());
describe('explicit tool approval', () => {
  it.each(['suggest', 'auto_edit'] as const)('does not grant %s after three seconds and denies at expiry', async mode => {
    vi.useFakeTimers(); let request!: ApprovalRequest;
    const done = vi.fn(), task = requestToolApproval('external_tool', { command: 'run' }, mode, value => { request = value; });
    void task.then(done); await vi.advanceTimersByTimeAsync(3000); expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(117000); expect(await task).toBe(false); request.resolve(true); expect(done).toHaveBeenLastCalledWith(false);
  });
  it('requires explicit approval, freezes parameter meaning and settles once', async () => {
    const input = { target: 'first' }; let request!: ApprovalRequest;
    const task = requestToolApproval('send', input, 'suggest', value => { request = value; });
    request.toolArgs.target = 'changed'; expect(input.target).toBe('first');
    request.resolve(true); request.resolve(false); expect(await task).toBe(true);
  });
  it('fails closed when the callback rejects or throws and on cancellation', async () => {
    expect(await requestToolApproval('tool', {}, 'suggest', () => { throw new Error('UI gone'); })).toBe(false);
    expect(await requestToolApproval('tool', {}, 'suggest', async () => { throw new Error('store failed'); })).toBe(false);
    const controller = new AbortController(); let request!: ApprovalRequest;
    const task = requestToolApproval('tool', {}, 'suggest', value => { request = value; }, controller.signal);
    controller.abort(); request.resolve(true); expect(await task).toBe(false);
  });
  it('only auto-approves explicitly trusted local reads, not unknown tools or suggested-mode reads', async () => {
    expect(await requestToolApproval('read_skill_file', {}, 'auto_edit', undefined, undefined, true)).toBe(true);
    expect(await requestToolApproval('read_skill_file', {}, 'auto_edit')).toBe(false);
    expect(await requestToolApproval('read_skill_file', {}, 'suggest', undefined, undefined, true)).toBe(false);
    expect(await requestToolApproval('tool', {}, 'full_auto')).toBe(true);
  });
});
