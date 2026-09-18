import { reviewReport, dateWindow, type ReviewInput, type ReviewResult, type Finding } from '../src/index.js';

const input: ReviewInput = { requirements: { id: 'brief', text: '严格串行。' }, report: '建议并行。' };
const result: ReviewResult = reviewReport(input);
const findings: Finding[] = result.findings;
const start: string = dateWindow('2026-09-18', 30).start;
const factVerification: 'not_performed' = result.factVerification;
void [findings, start, factVerification];
// @ts-expect-error Arbitrary claims of verification are not part of the public contract.
const verified: 'passed' = result.status;
// @ts-expect-error Only explicit recent/background use is supported.
const citation: ReviewInput['citations'] = [{ materialId: 'm', reportQuote: 'text', usage: 'fact_checked' }];
void [verified, citation];
