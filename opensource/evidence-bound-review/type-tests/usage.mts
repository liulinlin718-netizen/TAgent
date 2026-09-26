import { reviewReport, dateWindow, ReviewInputError, errorEnvelope, LIMITS,
  type ReviewInput, type ReviewResult, type Finding, type ReviewErrorEnvelope } from '../src/index.js';

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

const uniqueCitations: number = result.coverage.uniqueDateCitations;
const assessedSources: number = result.coverage.assessedDateSources;
const digits: number = LIMITS.integerDigits;
const error: TypeError = new ReviewInputError('quote_not_found', '/materials/0/source/dateQuote', 'Exact quote required.');
const envelope: ReviewErrorEnvelope = errorEnvelope(error);
// @ts-expect-error Error codes are a stable union, not arbitrary upstream error text.
const invalidError = new ReviewInputError('api_secret_error', '', '');
void [uniqueCitations, assessedSources, digits, envelope, invalidError];
