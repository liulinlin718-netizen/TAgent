import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import type { OfficeDeliveryReview } from '@tagent/core';
import DeliveryReview from '../../components/DeliveryReview';

const review = (overrides: Partial<OfficeDeliveryReview> = {}): OfficeDeliveryReview => ({
  version: 1, blockSchema: 'table-rows-v1', status: 'unverified', model: 'fixture', checkedAt: '2026-09-16',
  materialCount: 1, checks: [], issues: ['核对输出达到长度限制，尚未完成全部检查。'],
  coverage: { expectedBlocks: 31, checkedBlocks: 0 }, ...overrides,
});

describe('office review status presentation', () => {
  it('does not display an empty check list as a zero-out-of-zero score', () => {
    const $ = load(renderToStaticMarkup(<DeliveryReview review={review()} />));
    const panel = $('[data-testid="delivery-review"]');
    expect(panel.attr('open')).toBeUndefined();
    expect(panel.children('summary').text()).toContain('暂无检查结果');
    expect(panel.children('summary').text()).not.toContain('0/0');
    expect(panel.text()).toContain('核对覆盖 0/31 处内容');
    expect(panel.children('div').children('ul').text()).toContain('输出达到长度限制');
  });
  it('preserves the check denominator and incomplete verdict for partial results', () => {
    const $ = load(renderToStaticMarkup(<DeliveryReview review={review({
      coverage: { expectedBlocks: 31, checkedBlocks: 1 },
      checks: [
        { id: 'first', label: '表格 1 · 第 1 行', status: 'passed', method: 'model', reason: '有材料支持' },
        { id: 'second', label: '表格 1 · 第 2 行', status: 'unverified', method: 'model', reason: '缺少有效引用' },
      ],
    })} />));
    const summary = $('[data-testid="delivery-review"]').children('summary').text();
    expect(summary).toContain('尚未完成核对');
    expect(summary).toContain('1/2 项');
    expect($('[data-review-status]').first().attr('data-review-status')).toBe('unverified');
    expect($.text()).toContain('核对覆盖 1/31 处内容');
  });
  it('keeps legacy records without coverage readable and does not invent a denominator', () => {
    const $ = load(renderToStaticMarkup(<DeliveryReview review={review({ blockSchema: undefined, coverage: undefined })} />));
    expect($.text()).toContain('暂无检查结果');
    expect($.text()).not.toContain('核对覆盖');
  });
  it('retains a passed verdict and count when complete checks exist', () => {
    const $ = load(renderToStaticMarkup(<DeliveryReview review={review({ status: 'passed', issues: [],
      coverage: { expectedBlocks: 1, checkedBlocks: 1 },
      checks: [{ id: 'sum', label: '算术复算', status: 'passed', method: 'programmatic', reason: '合计310万元' }],
    })} />));
    const summary = $('[data-testid="delivery-review"]').children('summary').text();
    expect(summary).toContain('办公交付核对通过');
    expect(summary).toContain('1/1 项');
    expect(summary).not.toContain('暂无检查结果');
  });
});
