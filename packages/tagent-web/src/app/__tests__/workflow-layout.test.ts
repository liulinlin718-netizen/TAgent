import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('workflow theme contract', () => {
  it('uses defined design tokens so backgrounds and borders cannot silently become transparent', () => {
    const css = readFileSync(new URL('../WorkflowDrawer.module.css', import.meta.url), 'utf8');
    const tokens = readFileSync(new URL('../../styles/tokens.css', import.meta.url), 'utf8');
    const defined = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
    const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map(match => match[1]));
    expect([...used].filter(token => !defined.has(token))).toEqual([]);
  });
});
