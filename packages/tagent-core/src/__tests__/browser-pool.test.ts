import { afterEach, describe, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => vi.fn());
vi.mock('playwright', () => ({ chromium: { launch } }));
import { closeSharedBrowser, getSharedBrowser } from '../tools/browser-pool.js';

afterEach(async () => { await closeSharedBrowser(); vi.clearAllMocks(); });

describe('shared research browser', () => {
  it('launches and closes only one browser for concurrent callers', async () => {
    const instance = { isConnected: () => true, close: vi.fn(async () => {}) };
    launch.mockResolvedValue(instance);
    const result = await Promise.all([getSharedBrowser(), getSharedBrowser(), getSharedBrowser()]);
    expect(launch).toHaveBeenCalledTimes(1);
    for (const browser of result) expect(browser).toBe(instance);
    await closeSharedBrowser();
    expect(instance.close).toHaveBeenCalledTimes(1);
  });

  it('clears a failed launch so later requests can recover', async () => {
    const instance = { isConnected: () => true, close: vi.fn(async () => {}) };
    launch.mockRejectedValueOnce(new Error('Launch failed')).mockResolvedValueOnce(instance);
    await expect(getSharedBrowser()).rejects.toThrow('Launch failed');
    expect(await getSharedBrowser()).toBe(instance);
    expect(launch).toHaveBeenCalledTimes(2);
  });
});
