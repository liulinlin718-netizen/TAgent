import { describe, expect, it, vi } from 'vitest';
import { CostTracker, type LLMProvider, type LLMResponse } from '@tagent/ai';
import { applySemanticReview, attributedFindingText, generateResearchReport, inspectResearchCitations, parseResearchDraft, type ResearchDraft } from '../research-report.js';
import { assessResearchSources, evidencePassages, formatEvidenceLedger, makeResearchSource, publisherSite, researchSourceConstraints, selectCitationCandidates, type PublicationEvidence } from '../research-evidence.js';

const sources = [
  makeResearchSource({ url: 'https://publisher-one.example/report', title: 'First report', query: 'AI Agent', retrievedAt: '2026-09-11',
    readable: true, relevant: true, excerpt: 'The company plans to release an AI agent next month. It is not available today.',
    publication: { basis: 'publication_metadata', date: '2026-09-09' } }),
  makeResearchSource({ url: 'https://publisher-two.example/report', title: 'Second report', query: 'AI Agent', retrievedAt: '2026-09-11',
    readable: true, relevant: true, excerpt: 'The office AI agent remains a planned release, not an available product.',
    publication: { basis: 'publication_metadata', date: '2026-09-10' } }),
];
const assessment = assessResearchSources(sources, '2026-09-11', true);
const draft: ResearchDraft = { title: 'AI Agent 近期报道', findings: [{ id: 'f1', heading: '发布计划',
  statement: '来源页面报道，该公司计划下月发布 AI Agent，目前尚未开放。', timeScope: 'recent', basis: 'reported',
  evidence: [{ sourceId: sources[0].id, quote: sources[0].excerpt }] }], limitations: ['来源发布者身份未独立核实。'], unmetRequirements: [] };
const answer = (content: string): LLMResponse => ({ content, model: 'deepseek-chat', stopReason: 'end', toolCalls: [], usage: { inputTokens: 100, outputTokens: 100, cost: 0.01 } });
const verdict = (status = 'supported') => JSON.stringify({ taskSatisfied: true, missingRequirements: [], claims: [{ id: 'f1', verdict: status, kind: 'finding', reason: '原文限定为计划，报告保留了归因和未开放状态。' }] });

describe('report-level evidence review', () => {
  it.each(['supported', 'insufficient'])('never publishes an unchecked global title when finding review is %s', async status => {
    const changed = { ...structuredClone(draft), title: '公司已披露成功结果，行业趋势全面升温' };
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer(JSON.stringify(changed))).mockResolvedValueOnce(answer(verdict(status)));
    const result = await generateResearchReport({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: 'AI Agent最新进展', sources, assessment, summaries: '', costTracker: new CostTracker(), maxCost: .025 });
    expect(result.output).toMatch(/^# 调研报告\n/);
    expect(result.output).not.toContain(changed.title);
    expect(result.draft?.title).toBe(changed.title);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('cannot approve old evidence as a today finding, even with a positive semantic review', () => {
    const today = assessResearchSources(sources, '2026-09-11', '今日AI资讯');
    const review = inspectResearchCitations(draft, sources, today);
    expect(review.checks[0].citationIssues).toContainEqual(expect.objectContaining({ code: 'publication_outside_window' }));
    expect(applySemanticReview(review, verdict()).passed).toBe(false);
    const background = structuredClone(draft); background.findings[0].timeScope = 'background';
    expect(inspectResearchCitations(background, sources, today).checks[0].citationIssues || []).toEqual([]);
  });
  it('rejects extra headline numbers even when the semantic reviewer overlooks them', () => {
    const changed = structuredClone(draft);
    changed.findings[0].heading = '面向18岁以上用户';
    changed.findings[0].statement = '来源报道，该产品面向美国用户。';
    const initial = inspectResearchCitations(changed, sources, assessment);
    expect(initial.checks[0].citationIssues).toContainEqual(expect.objectContaining({ code: 'heading_number_mismatch' }));
    expect(applySemanticReview(initial, verdict()).checks[0].status).toBe('rejected');
    expect(applySemanticReview(initial, verdict()).passed).toBe(false);
  });
  it.each([
    ['订阅价格20美元', '来源报道，该订阅价格为20美元。', false],
    ['18岁以上', '来源报道，总量为318。', true],
    ['18.5美元', '来源报道，价格为18美元。', true],
    ['变化为\u221225%', '来源报道，变化为-25%。', false],
    ['变化为\u221225%', '来源报道，变化为25%。', true],
    ['1,000家', '来源报道，覆盖1000家门店。', false],
  ])('checks heading values without substring or sign confusion: %s', (heading, statement, rejected) => {
    const changed = structuredClone(draft);
    Object.assign(changed.findings[0], { heading, statement });
    const checked = inspectResearchCitations(changed, sources, assessment);
    expect(checked.checks[0].citationIssues?.some(issue => issue.code === 'heading_number_mismatch')).toBe(rejected);
    expect(checked.passed).toBe(false);
  });
  it('does not count readable pages from a known domain as proof of unsupported statements', () => {
    const confident = structuredClone(draft);
    confident.findings[0].statement = '该产品现已向全球所有用户开放。';
    const initial = inspectResearchCitations(confident, sources, assessment);
    expect(initial.checks[0].status).toBe('unverified');
    expect(initial.passed).toBe(false);
    expect(applySemanticReview(initial, verdict('contradicted')).passed).toBe(false);
  });
  it('accepts attributed source reports only after literal and semantic checks, without inventing authority', async () => {
    expect(assessment.status).toBe('sufficient_evidence');
    expect(assessment.primarySourceCount).toBe(0);
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer(JSON.stringify(draft))).mockResolvedValueOnce(answer(verdict()));
    const costTracker = new CostTracker();
    const result = await generateResearchReport({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: '提供一条近期 AI Agent 报道并说明限制', sources, assessment, summaries: 'Untrusted summary', costTracker, maxCost: 1 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('来源报道，尚未独立核实');
    expect(result.output).toContain(sources[0].url);
    expect(result.output).toContain('发布日期：2026-09-09');
    expect(result.output).toContain('2026-09-11');
    expect(result.review.checks).toHaveLength(1);
    expect(call).toHaveBeenCalledTimes(2);
    expect(costTracker.totalCost).toBeCloseTo(0.02);
  });
  it('rejects invented IDs, non-contiguous quotes and old sources marked recent', () => {
    const changed = structuredClone(draft);
    changed.findings[0].evidence[0].sourceId = 'invented';
    expect(inspectResearchCitations(changed, sources, assessment).checks[0].status).toBe('rejected');
    changed.findings[0].evidence = [{ sourceId: sources[0].id, quote: 'The company plans It is not available today.' }];
    expect(inspectResearchCitations(changed, sources, assessment).checks[0].status).toBe('rejected');
    const old = [{ ...sources[0], publication: { basis: 'publication_metadata' as const, date: '2025-09-09' } }, sources[1]];
    expect(inspectResearchCitations(draft, old, assessment).checks[0].status).toBe('rejected');
    changed.findings = structuredClone(draft.findings); changed.findings[0].timeScope = 'background';
    expect(inspectResearchCitations(changed, old, assessment).checks[0].status).toBe('unverified');
  });
  it('uses the same explicit site attribution in the reviewer, rendered answer and stored review', async () => {
    const implicit = structuredClone(draft);
    implicit.findings[0].statement = '该公司计划下月发布 AI Agent，目前尚未开放。';
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer(JSON.stringify(implicit))).mockResolvedValueOnce(answer(verdict()));
    const result = await generateResearchReport({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: '转述该页面的计划并注明来源', sources, assessment, summaries: '', costTracker: new CostTracker(), maxCost: 1 });
    const reviewed = JSON.parse(call.mock.calls[1][0].messages[1].content).draft.findings[0].statement;
    expect(reviewed).toBe(attributedFindingText(implicit.findings[0], sources));
    expect(reviewed).toContain('publisher-one.example 页面记载');
    expect(reviewed).toContain('发布者身份未独立核实');
    expect(result.output).toContain(reviewed);
    expect(result.review.checkedStatements).toEqual([{ id: 'f1', text: reviewed }]);
    expect(result.draft?.findings[0].basis).toBe('reported');
    expect(sources[0].publisher).toBe('unverified');
  });
  it('attribution cannot rescue unsupported claims, upgrade source identity or satisfy an official-only task', async () => {
    const changed = structuredClone(draft); changed.findings[0].statement = '该产品已经向所有用户正式开放。';
    expect(attributedFindingText(changed.findings[0], sources)).toContain('该产品已经向所有用户正式开放。');
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer(JSON.stringify(changed))).mockResolvedValueOnce(answer(verdict('contradicted')))
      .mockResolvedValueOnce(answer(JSON.stringify(changed))).mockResolvedValueOnce(answer(verdict('contradicted')));
    const result = await generateResearchReport({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: '仅使用官方来源确认已开放产品', sources, assessment, summaries: '', costTracker: new CostTracker(), maxCost: 1 });
    expect(result.success).toBe(false);
    expect(result.output).not.toContain(changed.findings[0].statement);
    expect(result.review.missingRequirements).toContain('任务要求原始发布证据，当前仅有来源报道或对照材料');
  });
  it('does not duplicate the current source attribution when a revision copies reviewed text', () => {
    const finding = structuredClone(draft.findings[0]);
    const once = attributedFindingText(finding, sources);
    finding.statement = once;
    expect(attributedFindingText(finding, sources)).toBe(once);
    const prefix = once.slice(0, once.length - draft.findings[0].statement.length);
    finding.statement = prefix + once;
    expect(attributedFindingText(finding, sources)).toBe(once);
    finding.statement = '据别的来源报道：' + draft.findings[0].statement;
    expect(attributedFindingText(finding, sources)).toContain('据别的来源报道：');
  });
  it('explains absent, unreadable and off-topic evidence separately without weakening rejection', () => {
    const changed = structuredClone(draft);
    changed.findings[0].evidence.push({ ...changed.findings[0].evidence[0] });
    const missing = inspectResearchCitations(changed, [], assessment);
    expect(missing.checks[0]).toMatchObject({ status: 'rejected', reason: expect.stringContaining('引用来源不在本次读取记录中') });
    expect(missing.checks[0].citationIssues).toHaveLength(1);
    expect(missing.checks[0].citationIssues?.[0]).toMatchObject({ sourceId: sources[0].id, code: 'source_missing' });
    const unreadable = inspectResearchCitations(changed, [{ ...sources[0], readable: false }], assessment);
    expect(unreadable.checks[0]).toMatchObject({ status: 'rejected', reason: expect.stringContaining('引用页面未取得可读正文') });
    const unrelated = inspectResearchCitations(changed, [{ ...sources[0], relevant: false }], assessment);
    expect(unrelated.checks[0]).toMatchObject({ status: 'rejected', reason: expect.stringContaining('引用正文已读取，但未通过当前任务的主题相关性检查') });
    expect(applySemanticReview(unrelated, verdict()).passed).toBe(false);
  });
  it.each<[PublicationEvidence, string, string]>([
    [{ basis: 'unknown' }, 'publication_missing', 'unknown'],
    [{ basis: 'url_hint', date: '2026-09-09' }, 'publication_missing', 'url_hint'],
    [{ basis: 'publication_metadata', date: '2026-02-31' }, 'publication_missing', '有效发布元数据'],
    [{ basis: 'publication_metadata', date: '2025-09-09' }, 'publication_outside_window', '2025-09-09'],
    [{ basis: 'publication_metadata', date: '2026-09-12' }, 'publication_future', '2026-09-12'],
  ])('gives generation and review the same precise date restriction: %j', (publication, code, detail) => {
    const evidence = [{ ...sources[0], publication }, sources[1]];
    const before = JSON.stringify(evidence);
    const constraints = researchSourceConstraints(evidence[0], assessment);
    expect(constraints).toEqual([expect.objectContaining({ code, scope: 'recent', reason: expect.stringContaining(detail), remediation: expect.any(String) })]);
    const ledger = JSON.parse(formatEvidenceLedger(evidence, assessment));
    expect(ledger[0].id).toBe(sources[1].id);
    expect(ledger.find((source: { id: string }) => source.id === sources[0].id).citationConstraints).toEqual(constraints);
    expect(ledger[0].citationConstraints).toEqual([]);
    const finding = structuredClone(draft);
    finding.findings[0].evidence[0].passageIndex = 0;
    const review = inspectResearchCitations(finding, evidence, assessment);
    expect(review.checks[0]).toMatchObject({ status: 'rejected', reason: expect.stringContaining(`来源 ${sources[0].id} 段落 0`) });
    expect(review.checks[0].citationIssues?.[0]).toMatchObject({ sourceId: sources[0].id, passageIndex: 0, code });
    finding.findings[0].timeScope = 'background';
    expect(inspectResearchCitations(finding, evidence, assessment).checks[0].status).toBe('unverified');
    expect(assessResearchSources(evidence, assessment.researchDate, true).datedSourceCount).toBe(1);
    expect(JSON.stringify(evidence)).toBe(before);
  });
  it('does not invent a 30-day constraint for a current-state task or exclude window boundaries', () => {
    const old = { ...sources[0], publication: { basis: 'publication_metadata' as const, date: '2025-09-09' } };
    expect(researchSourceConstraints(old, { researchDate: assessment.researchDate })).toEqual([]);
    for (const date of [assessment.windowStart!, assessment.researchDate]) {
      expect(researchSourceConstraints({ ...old, publication: { basis: 'publication_metadata', date } }, assessment)).toEqual([]);
    }
    const unavailable = { ...old, readable: false, relevant: false };
    expect(researchSourceConstraints(unavailable, assessment).filter(issue => issue.scope === 'any').map(issue => issue.code)).toEqual(['unreadable', 'off_topic']);
    expect(inspectResearchCitations({ ...draft, findings: [{ ...draft.findings[0], timeScope: 'background' }] }, [unavailable], assessment).checks[0].status).toBe('rejected');
  });
  it('retains semantic contradictions alongside hard citation failures without upgrading the result', () => {
    const initial = inspectResearchCitations(draft, [{ ...sources[0], publication: { basis: 'unknown' } }], assessment);
    const semantic = JSON.stringify({ taskSatisfied: true, missingRequirements: [], claims: [{ id: 'f1', verdict: 'insufficient', kind: 'finding', reason: '绑定段落只提供标题，无法支持全球开放这一细节。' }] });
    const checked = applySemanticReview(initial, semantic);
    expect(checked.passed).toBe(false);
    expect(checked.checks[0].reason).toContain('未取得有效发布元数据');
    expect(checked.checks[0].reason).toContain('无法支持全球开放');
    expect(checked.checks[0].semantic?.verdict).toBe('insufficient');
    expect(checked.checks[0].citationIssues).toEqual(initial.checks[0].citationIssues);
    const supported = applySemanticReview(initial, verdict());
    expect(supported.checks[0].semantic?.verdict).toBe('supported');
    expect(supported.checks[0].status).toBe('rejected');
    expect(supported.passed).toBe(false);
  });
  it('supplies source-specific and semantic repair feedback even when every initial finding has a date failure', async () => {
    const evidence = [{ ...sources[0], publication: { basis: 'unknown' as const } }, sources[1]];
    const wrong = structuredClone(draft);
    wrong.findings[0].statement = '产品已正式开放给所有企业。';
    wrong.findings[0].evidence[0].passageIndex = 0;
    const repaired = structuredClone(draft);
    repaired.findings[0].evidence = [{ sourceId: sources[1].id, passageIndex: 0, quote: sources[1].excerpt }];
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer(JSON.stringify(wrong)))
      .mockResolvedValueOnce(answer(JSON.stringify({ taskSatisfied: false, missingRequirements: ['尚无合格近期报道'],
        claims: [{ id: 'f1', verdict: 'contradicted', kind: 'finding', reason: '原文明确尚未开放，不能写为正式开放给所有企业。' }] })))
      .mockImplementationOnce(async params => {
        expect(params.messages[1].content).toContain('"citationConstraints"');
        const feedback = params.messages.at(-1)!.content;
        expect(feedback).toContain('publication_missing');
        expect(feedback).toContain(`"sourceId":"${sources[0].id}"`);
        expect(feedback).toContain('"passageIndex":0');
        expect(feedback).toContain('原文明确尚未开放');
        expect(feedback).toContain('尚无合格近期报道');
        return answer(JSON.stringify(repaired));
      }).mockResolvedValueOnce(answer(verdict()));
    const costTracker = new CostTracker();
    const result = await generateResearchReport({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: '提供一条近期 AI Agent 报道并说明限制', sources: evidence, assessment, summaries: '', costTracker, maxCost: 1 });
    expect(result.success).toBe(true);
    expect(result.review.previousReview?.checks[0]).toMatchObject({ status: 'rejected', semantic: { verdict: 'contradicted' } });
    expect(result.output).not.toContain(wrong.findings[0].statement);
    expect(result.output).toContain(sources[1].url);
    expect(call).toHaveBeenCalledTimes(4);
    expect(call.mock.calls.every(([params]) => !params.tools?.length)).toBe(true);
    expect(costTracker.totalCost).toBeCloseTo(0.04);
  });
  it('does not pay a semantic reviewer to judge an entirely unreadable evidence set', async () => {
    const call = vi.fn<LLMProvider['call']>().mockResolvedValue(answer(JSON.stringify(draft)));
    const result = await generateResearchReport({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: '近期报道', sources: sources.map(source => ({ ...source, readable: false })), assessment, summaries: '', costTracker: new CostTracker(), maxCost: 1 });
    expect(result.success).toBe(false);
    expect(call).toHaveBeenCalledTimes(2);
    expect(result.review.checks[0].semantic).toBeUndefined();
    expect(result.review.previousReview).toBeDefined();
  });
  it('does not let a semantic judge override failed citation or authority checks', () => {
    const changed = structuredClone(draft); changed.findings[0].basis = 'first_party';
    const initial = inspectResearchCitations(changed, sources, assessment);
    expect(initial.checks[0].status).toBe('rejected');
    expect(applySemanticReview(initial, verdict()).passed).toBe(false);
    changed.findings[0].basis = 'corroborated';
    expect(inspectResearchCitations(changed, sources, assessment).checks[0].status).toBe('rejected');
  });
  it('fails closed on missing/duplicate verdicts and unmet task requirements', () => {
    const initial = inspectResearchCitations(draft, sources, assessment);
    expect(() => applySemanticReview(initial, '{"claims":[]}')).toThrow();
    expect(() => applySemanticReview(initial, JSON.stringify({ taskSatisfied: true, missingRequirements: [], claims: [
      { id: 'f1', verdict: 'supported', reason: 'ok' }, { id: 'f1', verdict: 'supported', reason: 'ok' },
    ] }))).toThrow();
    expect(applySemanticReview(initial, verdict().replace('"taskSatisfied":true', '"taskSatisfied":false')).passed).toBe(false);
    expect(() => parseResearchDraft('{"findings":[]}')).toThrow();
  });
  it('resolves numbered original passages without model-transcribed quotations', () => {
    const numbered = { ...draft, findings: [{ ...draft.findings[0], evidence: [{ sourceId: sources[0].id, passageIndex: 0 }] }] };
    expect(parseResearchDraft(JSON.stringify(numbered), sources).findings[0].evidence[0]).toEqual({ sourceId: sources[0].id, passageIndex: 0, quote: sources[0].excerpt });
    numbered.findings[0].evidence[0].passageIndex = 9;
    expect(() => parseResearchDraft(JSON.stringify(numbered), sources)).toThrow('编号');
    expect(() => parseResearchDraft(JSON.stringify({ ...draft, findings: [{ ...draft.findings[0],
      evidence: [{ sourceId: sources[0].id, passageIndex: 0, quote: 'invented quotation' }] }] }), sources)).toThrow('不一致');
  });
  it('rejects cross-site reposts and common upstream sources as independent corroboration', () => {
    const paired = structuredClone(draft);
    paired.findings[0].basis = 'corroborated';
    paired.findings[0].evidence.push({ sourceId: sources[1].id, quote: sources[1].excerpt });
    const linked = [{ ...sources[0], references: [{ url: sources[1].url, text: 'Original announcement', context: 'As the announcement states' }] }, sources[1]];
    expect(inspectResearchCitations(paired, linked, assessment).checks[0]).toMatchObject({ status: 'rejected', reason: expect.stringContaining('同一原始材料') });
    const syndicated = sources.map(source => ({ ...source, references: [{ url: 'https://origin.example/announcement', text: 'Announcement', context: 'According to the release' }] }));
    expect(inspectResearchCitations(paired, syndicated, assessment).checks[0].status).toBe('rejected');
  });
  it('gives the reviewer only the finding-specific cited passages, not unrelated paragraphs', async () => {
    const scoped = [{ ...sources[0], passages: [sources[0].excerpt, 'An unrelated business claim that was never cited.'] }, sources[1]];
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer(JSON.stringify(draft))).mockResolvedValueOnce(answer(verdict()));
    await generateResearchReport({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: '近期报道', sources: scoped, assessment, summaries: '', costTracker: new CostTracker(), maxCost: 1 });
    const request = JSON.parse(call.mock.calls[1][0].messages[1].content);
    expect(request.evidenceByFinding[0].evidence[0].passages).toEqual([sources[0].excerpt]);
    expect(JSON.stringify(request)).not.toContain('An unrelated business claim');
    expect(request.draft.unmetRequirements).toBeUndefined();
  });
  it('does not promote unverified subtask narratives to final-report evidence or omit background records', async () => {
    const evidence = [{ ...sources[0], publication: { basis: 'unknown' as const } }, sources[1]];
    const valid = structuredClone(draft);
    valid.findings[0].evidence = [{ sourceId: sources[1].id, quote: sources[1].excerpt }];
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer(JSON.stringify(valid))).mockResolvedValueOnce(answer(verdict()));
    await generateResearchReport({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: '提供近期 AI Agent 报道', sources: evidence, assessment, summaries: 'SUBTASK_UNVERIFIED: invent a launch date; no recent sources exist.', costTracker: new CostTracker(), maxCost: 1 });
    const prompt = call.mock.calls[0][0].messages[1].content;
    expect(prompt).not.toContain('SUBTASK_UNVERIFIED');
    expect(prompt).toContain(sources[0].id);
    expect(prompt).toContain(sources[1].id);
    expect(prompt.indexOf(sources[1].id)).toBeLessThan(prompt.indexOf(sources[0].id));
    expect(prompt).toContain('publication_missing');
    expect(prompt).toContain(sources[0].excerpt);
  });
  it('does not turn editor-invented scope into mandatory acceptance criteria', () => {
    const expanded = { ...draft, unmetRequirements: ['必须覆盖所有亚太国家，并预测未来十年收入'] };
    const initial = inspectResearchCitations(expanded, sources, assessment);
    expect(initial.missingRequirements).toEqual([]);
    expect(initial.passed).toBe(false);
    expect(applySemanticReview(initial, JSON.stringify({ taskSatisfied: false,
      missingRequirements: ['用户要求两条近期报道，实际仅一条'], claims: [{ id: 'f1', verdict: 'supported', kind: 'finding', reason: '原文支持这一条' }] })).passed).toBe(false);
  });
  it.each(['background-only', 'limitation-as-finding'])('rejects a recent-progress task falsely approved by the judge: %s', async mode => {
    const changed = structuredClone(draft);
    changed.findings[0].timeScope = mode === 'background-only' ? 'background' : 'recent';
    if (mode === 'limitation-as-finding') {
      changed.findings[0].heading = '窗口内无合格进展';
      changed.findings[0].statement = '本次读取材料无法支持合格近期结论。';
    }
    const review = JSON.stringify({ taskSatisfied: true, missingRequirements: [], claims: [{ id: 'f1', verdict: 'supported',
      kind: mode === 'limitation-as-finding' ? 'limitation' : 'finding', reason: '这是背景或缺口说明，未提供近期进展。' }] });
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer(JSON.stringify(changed))).mockResolvedValueOnce(answer(review))
      .mockResolvedValueOnce(answer(JSON.stringify(changed))).mockResolvedValueOnce(answer(review));
    const result = await generateResearchReport({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: '近30天 AI Agent 最新进展', sources, assessment, summaries: '', costTracker: new CostTracker(), maxCost: 1 });
    expect(result.success).toBe(false);
    expect(result.review.missingRequirements).toContainEqual(expect.stringContaining('背景材料与缺口说明不能代替近期调研结果'));
    expect(call).toHaveBeenCalledTimes(4);
    if (mode === 'limitation-as-finding') expect(result.review.checks[0].status).toBe('rejected');
  });
  it('fails closed when the reviewer omits the distinction between an outcome and an evidence gap', () => {
    expect(() => applySemanticReview(inspectResearchCitations(draft, sources, assessment), JSON.stringify({ taskSatisfied: true,
      missingRequirements: [], claims: [{ id: 'f1', verdict: 'supported', reason: 'No outcome classification' }] }))).toThrow('核对结论不完整');
  });
  it('revises a rejected finding once and rechecks without tools, counting every paid response', async () => {
    const wrong = structuredClone(draft); wrong.findings[0].statement = '已经向所有用户开放。';
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer(JSON.stringify(wrong))).mockResolvedValueOnce(answer(verdict('contradicted')))
      .mockResolvedValueOnce(answer(JSON.stringify(draft))).mockResolvedValueOnce(answer(verdict()));
    const costTracker = new CostTracker();
    const result = await generateResearchReport({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: '提供一条近期报道', sources, assessment, summaries: '', costTracker, maxCost: 1 });
    expect(result.success).toBe(true);
    expect(call).toHaveBeenCalledTimes(4);
    expect(result.review.previousReview?.checks[0].status).toBe('rejected');
    expect(call.mock.calls[2][0].messages.at(-1)?.content).toContain('上一版未通过核对');
    expect(call.mock.calls.every(([params]) => !params.tools?.length)).toBe(true);
    expect(costTracker.totalCost).toBeCloseTo(0.04);
  });
  it('never loops indefinitely or reports success when the single revision also fails', async () => {
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer(JSON.stringify(draft))).mockResolvedValueOnce(answer(verdict('insufficient')))
      .mockResolvedValueOnce(answer(JSON.stringify(draft))).mockResolvedValueOnce(answer(verdict('insufficient')));
    const result = await generateResearchReport({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: '近期报道', sources, assessment, summaries: '', costTracker: new CostTracker(), maxCost: 1 });
    expect(result.success).toBe(false);
    expect(call).toHaveBeenCalledTimes(4);
  });
  it('can correct a completed but malformed structured draft once and retains the rejected output for audit', async () => {
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer('{"title":"Incomplete report"}'))
      .mockResolvedValueOnce(answer(JSON.stringify(draft))).mockResolvedValueOnce(answer(verdict()));
    const result = await generateResearchReport({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: '近期报道', sources, assessment, summaries: '', costTracker: new CostTracker(), maxCost: 1 });
    expect(result.success).toBe(true);
    expect(call).toHaveBeenCalledTimes(3);
    expect(result.review.previousReview?.rejectedDraft?.content).toBe('{"title":"Incomplete report"}');
  });
  it('explains the actual finding-count violation and rechecks a bounded correction without hiding the paid-for draft', async () => {
    const oversized = { ...draft, findings: Array.from({ length: 24 }, (_, index) => ({ ...draft.findings[0], id: `f${index + 1}` })) };
    const raw = JSON.stringify(oversized);
    expect(() => parseResearchDraft(raw)).toThrow('实际 24 条，单份报告最多 12 条');
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer(raw)).mockImplementationOnce(async params => {
      const feedback = params.messages.at(-1)!.content;
      expect(feedback).toContain('实际 24 条，单份报告最多 12 条');
      expect(feedback).toContain('原始用户明确指定的数量、地区和主题仍是验收标准');
      expect(feedback).not.toContain('"rejectedDraft"');
      expect(params.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([raw]);
      return answer(JSON.stringify(draft));
    }).mockResolvedValueOnce(answer(verdict()));
    const costTracker = new CostTracker();
    const result = await generateResearchReport({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: '提供一条近期报道', sources, assessment, summaries: '', costTracker, maxCost: 1 });
    expect(result.success).toBe(true);
    expect(result.review.previousReview?.rejectedDraft?.content).toBe(raw);
    expect(result.review.checks).toHaveLength(1);
    expect(call).toHaveBeenCalledTimes(3);
    expect(costTracker.totalCost).toBeCloseTo(0.03);
  });
  it('never silently slices excess findings or bypasses evidence checking after a format correction', async () => {
    const oversized = { ...draft, findings: Array.from({ length: 13 }, (_, index) => ({ ...draft.findings[0], id: `f${index + 1}` })) };
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer(JSON.stringify(oversized)))
      .mockResolvedValueOnce(answer(JSON.stringify(draft))).mockResolvedValueOnce(answer(verdict('contradicted')));
    const result = await generateResearchReport({ provider: { name: 'fixture', call, stream: async function* () {} }, model: 'deepseek-chat',
      task: '整理全部已提供材料', sources, assessment, summaries: '', costTracker: new CostTracker(), maxCost: 1 });
    expect(result.success).toBe(false);
    expect(result.review.checks[0].status).toBe('rejected');
    expect(result.output).not.toContain(draft.findings[0].statement);
    expect(result.review.previousReview?.rejectedDraft?.content).toBe(JSON.stringify(oversized));
    expect(call).toHaveBeenCalledTimes(3);
  });
  it.each(['error', 'budget', 'unknown-price'])('retains the structured draft but not a success claim when verification stops: %s', async mode => {
    const call = vi.fn<LLMProvider['call']>().mockResolvedValueOnce(answer(JSON.stringify(draft))).mockRejectedValueOnce(new Error('Verifier unavailable'));
    const costTracker = new CostTracker();
    const result = await generateResearchReport({ provider: { name: 'fixture', call, stream: async function* () {} }, model: mode === 'unknown-price' ? 'unknown' : 'deepseek-chat',
      task: '近期 AI Agent 报道', sources, assessment, summaries: '', costTracker, maxCost: mode === 'budget' ? 0.011 : 1 });
    expect(result.success).toBe(false);
    expect(result.output).not.toContain(draft.findings[0].statement);
    expect(result.draft).toEqual(draft);
    expect(result.review.missingRequirements.length).toBeGreaterThan(0);
    expect(costTracker.totalCost).toBeCloseTo(0.01);
    expect(call).toHaveBeenCalledTimes(mode === 'error' ? 2 : 1);
  });
});

describe('source diversity and citation selection', () => {
  const corroborated = () => ({ ...structuredClone(draft), findings: [{ ...structuredClone(draft.findings[0]), basis: 'corroborated' as const,
    evidence: sources.map(source => ({ sourceId: source.id, quote: source.excerpt })) }] });
  it('rejects indirect copies even when the intermediate report is not cited in the final finding', () => {
    const middle = { ...sources[0], id: 'middle', url: 'https://middle.example/report', discoveredFrom: sources[0].url,
      references: [{ url: sources[1].url, text: 'Original', context: 'AI Agent announcement' }] };
    const records = [...sources, middle];
    const review = inspectResearchCitations(corroborated(), records, assessment);
    expect(review.checks[0].citationIssues?.some(issue => issue.code === 'not_independent')).toBe(true);
    expect(review.checks[0].status).toBe('rejected');
  });
  it('preserves upstream relationships through actually requested redirect aliases', () => {
    const alias = 'https://publisher-two.example/old-report';
    const records = [{ ...sources[0], references: [{ url: alias, text: 'Original', context: 'AI Agent release' }] },
      { ...sources[1], requestedUrls: [alias] }];
    const review = inspectResearchCitations(corroborated(), records, assessment);
    expect(review.checks[0].citationIssues?.some(issue => issue.code === 'not_independent')).toBe(true);
  });
  it('finds shared upstream originals through separate intermediates and terminates on citation cycles', () => {
    const upstream = 'https://original.example/announcement';
    const middle = sources.map((source, index) => ({ ...source, id: `middle-${index}`, url: `https://middle-${index}.example/report`,
      discoveredFrom: source.url, references: [{ url: upstream, text: 'Original', context: 'AI Agent release' },
        { url: source.url, text: 'Coverage', context: 'AI Agent report' }] }));
    expect(inspectResearchCitations(corroborated(), [...sources, ...middle], assessment).checks[0].status).toBe('rejected');
  });
  it('does not treat two publishers as copies merely because an uncited directory links both', () => {
    const directory = { ...sources[0], id: 'directory', url: 'https://directory.example/news',
      references: sources.map(source => ({ url: source.url, text: 'Report', context: 'AI Agent news' })) };
    const result = inspectResearchCitations(corroborated(), [...sources, directory], assessment);
    expect(result.checks[0].status).toBe('unverified');
    expect(result.passed).toBe(false);
  });
  it('uses public suffix rules and does not treat sibling subdomains as independent publishers', () => {
    expect(publisherSite('https://news.example.co.uk/story')).toBe('example.co.uk');
    const same = [sources[0], { ...sources[1], url: 'https://news.publisher-one.example/other' }];
    expect(assessResearchSources(same, '2026-09-11', true).independentPublisherCount).toBe(1);
    expect(assessResearchSources(same, '2026-09-11', true).status).toBe('insufficient_evidence');
  });
  it('follows relevant original citations, not profiles, sponsors, homepages or already-read URLs', () => {
    const candidates = selectCitationCandidates([{ url: sources[0].url, references: [
      { url: 'https://original.example/news/agent', text: 'Original announcement', context: 'The AI agent release is described in the original announcement.' },
      { url: 'https://original.example/', text: 'Original', context: 'AI agent release announcement' },
      { url: 'https://publisher-one.example/other', text: 'Related', context: 'AI agent release announcement' },
      { url: 'https://sponsor.example/promo', text: 'Conference', context: 'Cloud computing expo tickets' },
    ] }], 'AI Agent 最新进展', new Set());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].discoveredFrom).toBe(sources[0].url);
    expect(selectCitationCandidates([{ url: sources[0].url, references: [{ url: candidates[0].url, text: 'Original', context: 'AI agent release' }] }], 'AI Agent', new Set([candidates[0].url]))).toEqual([]);
  });
  it('retains bounded original passages rather than generated summaries', () => {
    const text = 'AI agents are not yet generally available. The release is planned for next month. '.repeat(200);
    const passages = evidencePassages(text, 'AI Agent release');
    expect(passages.length).toBeLessThanOrEqual(12);
    expect(passages.join('').length).toBeLessThanOrEqual(6000);
    for (const passage of passages) expect(text).toContain(passage);
  });
  it('keeps nearby short negation and attribution alongside relevant sentences', () => {
    const text = 'This is speculation. The AI agent product could become generally available next month. Not yet confirmed. More information will follow.';
    const passages = evidencePassages(text, 'AI agent product');
    const relevant = passages.find(passage => passage.includes('AI agent product'));
    expect(relevant).toContain('This is speculation.');
    expect(relevant).toContain('Not yet confirmed.');
    expect(text).toContain(relevant);
  });
  it.each(['\n\n', '\r\n\r\n', '\n \t\n'])('does not let blank sentence segments separate a heading from the fact and its limitation: %j', separator => {
    const text = [
      'Office AI agent release',
      'The vendor announced a limited agent pilot with ten partner teams.',
      'It is not generally available.',
      'Commentary: broader adoption will depend on customer evaluation.',
    ].join(separator);
    const passages = evidencePassages(text, 'AI agent release');
    const fact = passages.find(passage => passage.includes('ten partner teams'));
    expect(fact).toBeDefined();
    expect(fact).toContain('limited agent pilot');
    expect(fact).toContain('not generally available');
    for (const passage of passages) expect(text).toContain(passage);
  });
  it('merges overlapping context without losing neighboring facts or exceeding per-passage and total budgets', () => {
    const text = Array.from({ length: 80 }, (_, index) => [
      `AI agent update ${index}`,
      `Report ${index} describes a limited AI agent trial in the office, involving ${index + 2} partner teams.`,
      'The vendor has not confirmed general availability and independent verification remains necessary.',
    ].join('\n\n')).join('\n\n');
    const passages = evidencePassages(text, 'AI agent update');
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.length).toBeLessThanOrEqual(12);
    expect(passages.join('').length).toBeLessThanOrEqual(6000);
    for (const passage of passages) {
      expect(passage.length).toBeLessThanOrEqual(2400);
      expect(text).toContain(passage);
    }
    const firstFact = passages.find(passage => passage.includes('Report 0 describes'));
    expect(firstFact).toContain('has not confirmed general availability');
  });
});
