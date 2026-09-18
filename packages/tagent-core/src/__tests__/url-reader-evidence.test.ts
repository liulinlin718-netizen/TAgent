import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUrlReaderTool } from '../tools/url-reader.js';

afterEach(() => vi.unstubAllGlobals());
const html = '<meta property="article:published_time" content="2026-09-09"><article><h1>AI Agent release</h1><p>' + 'AI agents support office work. '.repeat(30) + '</p></article>';

describe('read_url source collection', () => {
  it('returns observed citation candidates after truncation without fetching or verifying them', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(html.replace('</article>',
      '<p>Original source: <a href="https://publisher.example/original">announcement</a></p></article>'), { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetch);
    const onSources = vi.fn();
    const output = await createUrlReaderTool({ topic: 'AI Agent', onSources }).execute({ url: 'https://media.example/article', maxLength: 500 });
    expect(output).toContain('https://publisher.example/original');
    expect(output).toContain('尚未读取或核实');
    expect(onSources.mock.calls[0][0][0].references[0].url).toBe('https://publisher.example/original');
    expect(onSources.mock.calls[0][0][0].publisher).toBe('unverified');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('records the final URL and publication metadata, not dates in body text', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/index/agent-release' } }))
      .mockResolvedValueOnce(new Response(html, { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetch);
    const onSources = vi.fn();
    const output = await createUrlReaderTool({ topic: 'AI Agent 最新进展', onSources }).execute({ url: 'https://openai.com/old', maxLength: 500 });
    expect(onSources).toHaveBeenCalledWith([expect.objectContaining({ url: 'https://openai.com/index/agent-release', readable: true, relevant: true,
      publication: { basis: 'publication_metadata', date: '2026-09-09', raw: '2026-09-09' }, requestedUrls: ['https://openai.com/old'] })]);
    expect(output).toContain('发布日期: 2026-09-09');
    expect(output).toContain('内容已截断');
  });
  it('does not claim a canonical tag was an actual redirect or another page read', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(html + '<link rel="canonical" href="https://official.example/agent">',
      { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetch);
    const onSources = vi.fn();
    await createUrlReaderTool({ topic: 'AI Agent', onSources }).execute({ url: 'https://media.example/report?utm_source=test' });
    expect(onSources.mock.calls[0][0][0]).toMatchObject({ url: 'https://media.example/report', requestedUrls: ['https://media.example/report'] });
    expect(onSources.mock.calls[0][0][0].requestedUrls).not.toContain('https://official.example/agent');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps a requested version parameter in the material URL and its actual request provenance', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(html, { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetch);
    const onSources = vi.fn();
    const url = 'https://publisher.example/report?ref=2025';
    const output = await createUrlReaderTool({ topic: 'AI Agent', onSources }).execute({ url });
    expect(onSources.mock.calls[0][0][0]).toMatchObject({ url, requestedUrls: [url] });
    expect(output).toContain(`- URL: ${url}`);
  });

  it.each(['http://127.0.0.1/private', 'https://outside.example/secret'])('does not follow a redirect outside URL policy: %s', async location => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    vi.stubGlobal('fetch', fetch);
    const onSources = vi.fn();
    const output = await createUrlReaderTool({ allowedDomains: ['openai.com'], onSources }).execute({ url: 'https://openai.com/redirect' });
    expect(output).toContain('拦截');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onSources).not.toHaveBeenCalled();
  });

  it('does not count a verification page as research or reject legitimate CAPTCHA research', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('<p>Verify you are human. ' + 'Loading '.repeat(50) + '</p>', { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response(html.replace('AI Agent release', 'CAPTCHA research with AI agents'), { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetch);
    const onSources = vi.fn();
    const tool = createUrlReaderTool({ topic: 'AI Agent', onSources });
    expect(await tool.execute({ url: 'https://example.com/blocked' })).toContain('未读取到可用正文');
    expect(onSources.mock.calls[0][0][0].readable).toBe(false);
    expect(await tool.execute({ url: 'https://example.com/article' })).toContain('CAPTCHA research');
    expect(onSources.mock.calls[1][0][0].readable).toBe(true);
  });
  it('does not use a matching page title to certify unrelated consent or marketing content', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('<title>Latest AI Agent news</title><main><p>'
      + 'Manage cookie consent. Accept or deny marketing cookies and save your preferences. '.repeat(10) + '</p></main>', { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetch);
    const onSources = vi.fn();
    await createUrlReaderTool({ topic: 'AI Agent', onSources }).execute({ url: 'https://publisher.example/article' });
    expect(onSources.mock.calls[0][0][0]).toMatchObject({ readable: true, relevant: false });
  });
});
