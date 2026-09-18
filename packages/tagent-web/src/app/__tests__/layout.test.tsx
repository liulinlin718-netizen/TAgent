import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import RootLayout from '../layout';

vi.mock('../../components/AccessGate', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));

describe('root document resource hints', () => {
  it('does not direct a deployed browser to developer localhost services', () => {
    const $ = load(renderToStaticMarkup(<RootLayout><p>页面内容</p></RootLayout>));
    expect($('html').attr('lang')).toBe('zh-CN');
    expect($('body').text()).toContain('页面内容');
    const hints = $('link[rel="preconnect"], link[rel="dns-prefetch"]').map((_, node) => $(node).attr('href')).get();
    expect(hints.some(href => /localhost|127\.0\.0\.1|\[::1\]/i.test(href))).toBe(false);
  });
});
