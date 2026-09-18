import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, apiFetch } from '../../lib/api-client';

afterEach(() => vi.unstubAllGlobals());
describe('credentialed TAgent client', () => {
  it('includes cookies and CSRF headers only for the configured API', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await apiFetch(`${API_BASE}/api/skills`, { method: 'POST', body: '{}' });
    const [url, options] = fetch.mock.calls[0];
    expect(new URL(url).pathname).toBe('/api/skills');
    expect(options.credentials).toBe('include');
    expect(options.headers.get('x-tagent-request')).toBe('1');
    expect(options.redirect).toBe('error');
    await expect(apiFetch('https://github.com/api/skills')).rejects.toThrow('外部站点');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
