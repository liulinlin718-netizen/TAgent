import { describe, expect, it } from 'vitest';
import { prepareSummaryFork, extractSummary, summarySourceHash } from '../session-summary.js';
const messages = [{ id: 'u', role: 'user' as const, content: '预算1200元，禁止安装。' }, { id: 'a', role: 'assistant' as const, content: '建议先核实材料，尚未发送邮件。' }];
const connection = { provider: 'fixture', model: 'deepseek-chat', endpoint: 'http://127.0.0.1/model' };
describe('extractive summary package', () => {
  it('previews actual payload and excludes preserved originals from model input', () => {
    const prepared = prepareSummaryFork(messages, ['u'], connection);
    expect(prepared.preview).toMatchObject({ maxModelCalls: 1, willWrite: false, willExecute: false, requiresConfirmation: true,
      inputMessageIds: ['a'], preservedMessageIds: ['u'] });
    expect(prepared.input[1].content).not.toContain('预算1200');
    expect(prepared.preview.inputBytes).toBe(prepared.input.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0));
    expect(prepared.preview.estimatedCost).toBeGreaterThan(0);
    expect(prepareSummaryFork(messages, [], { ...connection, model: 'unpriced' }).preview.estimatedCost).toBeNull();
  });
  it.each([['missing'], ['u', 'u'], ['u', 'a'], false])('rejects invalid or entirely preserved choices %j', preserve => {
    expect(() => prepareSummaryFork(messages, preserve, connection)).toThrow();
  });
  it('bounds preserved and model material without silent truncation', () => {
    expect(() => prepareSummaryFork([{ ...messages[0], content: '字'.repeat(30000) }], [], connection)).toThrow('64000');
    expect(() => prepareSummaryFork([{ ...messages[0], content: '字'.repeat(8001) }, messages[1]], ['u'], connection)).toThrow('8000');
    expect(summarySourceHash(messages)).not.toBe(summarySourceHash([{ ...messages[0], content: 'changed' }, messages[1]]));
  });
  it('copies contiguous original evidence, derives trust labels and refuses invented or repeated material', () => {
    const result = extractSummary(JSON.stringify({ excerpts: [{ messageId: 'u', quote: '预算1200元' }, { messageId: 'a', quote: '尚未发送邮件' }] }), messages, ['u', 'a']);
    expect(result.excerpts.map(item => item.kind)).toEqual(['user_input', 'assistant_unverified']);
    expect(result.output).toContain('未独立核验');
    for (const row of [{ messageId: 'u', quote: '已安装' }, { messageId: 'a', quote: '建议材料' }, { messageId: 'foreign', quote: '预算1200元' }]) {
      expect(() => extractSummary(JSON.stringify({ excerpts: [row] }), messages, ['u', 'a'])).toThrow('原文');
    }
    expect(() => extractSummary(JSON.stringify({ excerpts: [result.excerpts[0], result.excerpts[0]] }), messages, ['u'])).toThrow('重复');
    expect(() => extractSummary('{bad}', messages, ['u'])).toThrow('格式');
    expect(() => extractSummary('{"excerpts":[]}', messages, ['u'])).toThrow('1至16');
  });
});
