import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { load } from 'cheerio';
import Markdown from '../../components/Markdown';

describe('report Markdown links', () => {
  it('preserves nested lists, native numbering starts and continuation paragraphs', () => {
    const html = renderToStaticMarkup(<Markdown content={'3. 先核对\n\n   续段不能丢\n\n   - 子任务\n     - [x] 已完成\n4. 后发送'} />);
    const $ = load(html);
    expect($('ol').attr('start')).toBe('3');
    expect($('ol > li > ul > li > ul input[checked]')).toHaveLength(1);
    expect($('ol > li > p').text()).toContain('续段不能丢');
    expect($('ol > li')).toHaveLength(2);
  });
  it('preserves escaped pipes and surplus cells rather than silently dropping data', () => {
    const $ = load(renderToStaticMarkup(<Markdown content={'| 字段 | 值 |\n|---|---|\n| **甲\\|乙** | 001 | 不可丢失 |'} />));
    expect($('tbody td').map((_, cell) => $(cell).text()).get()).toEqual(['甲|乙', '001', '不可丢失']);
    expect($('thead th')).toHaveLength(3);
  });
  it('resolves definitions across sections and isolates footnote IDs between replies', () => {
    const content = '# 报告\n\n## 第一部分\n\n[来源][ref] 信息[^1]\n\n## 第二部分\n\n[ref]: https://example.com/source\n\n[^1]: 核对口径';
    const $ = load(renderToStaticMarkup(<><Markdown content={content} /><Markdown content={content} /></>));
    expect($('a[href="https://example.com/source"]')).toHaveLength(2);
    const ids = $('[id]').map((_, node) => $(node).attr('id')).get();
    expect(new Set(ids).size).toBe(ids.length);
    $('a[href^="#"]').each((_, anchor) => {
      expect($(anchor).attr('target')).toBeUndefined();
      const id = decodeURIComponent($(anchor).attr('href')!.slice(1));
      expect(ids).toContain(id);
    });
    expect($.text()).toContain('核对口径');
  });
  it('keeps ordinary hash prefixes, setext headings, soft breaks and tilde code fences', () => {
    const $ = load(renderToStaticMarkup(<Markdown content={'标题\n====\n\n#不是标题\n第二行\n\n~~~js\nconst a = "<x>&";\n~~~\n\n##### 五级\n\n###### 六级'} />));
    expect($('h1').text()).toBe('标题'); expect($('p').text()).toContain('#不是标题\n第二行');
    expect($('pre code').text()).toContain('const a = "<x>&";');
    expect($('h5').text()).toBe('五级'); expect($('h6').text()).toBe('六级');
  });
  it('preserves body content in nested warning notices', () => {
    const $ = load(renderToStaticMarkup(<Markdown content={'> [!WARNING] 待确认\n> 第一段\n>\n> - 条件一\n>   - 条件二'} />));
    expect($.text()).toContain('待确认'); expect($.text()).toContain('第一段'); expect($('ul ul').text()).toContain('条件二');
  });
  it('does not present ordinary bullet points or error reasons as passed checks', () => {
    const html = renderToStaticMarkup(<Markdown content={'- 模型服务认证失败\n- 尚未形成可用中间结果'} />);
    expect(html).toContain('<ul');
    expect(html).toContain('模型服务认证失败');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('checkIcon');
  });

  it('keeps the icon on an explicitly marked success notice', () => {
    const html = renderToStaticMarkup(<Markdown content={'> [!SUCCESS] 检查通过\n> 已完成明确的核对。'} />);
    expect(html).toContain('检查通过');
    expect(html).toContain('<svg');
  });

  it('renders angle-delimited source URLs and balanced parentheses as real links', () => {
    const html = renderToStaticMarkup(<Markdown content={'- 来源：[公告](<https://example.com/news_(2026)?lang=zh>)\n- [普通链接](https://example.com/report_(draft))'} />);
    expect(html).toContain('href="https://example.com/news_(2026)?lang=zh"');
    expect(html).toContain('href="https://example.com/report_(draft)"');
    expect(html).not.toContain('href="&lt;');
  });
  it('preserves escaped source titles and nested formatting without injecting HTML', () => {
    const html = renderToStaticMarkup(<Markdown content={'[标题\\[公告\\]](<https://example.com/>) 与 **重要的 *计划***\n\n<script>alert(1)</script>'} />);
    expect(html).toContain('标题[公告]');
    expect(html).toContain('<strong>重要的 <em>计划</em></strong>');
    expect(html).not.toContain('<script');
  });
  it('never creates active script or data links and does not fetch arbitrary remote images', () => {
    const html = renderToStaticMarkup(<Markdown content={'[x](javascript:alert%281%29) [y](data:text/html,test) ![illustration](https://tracker.example/pixel)'} />);
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).not.toContain('<img');
  });
});
