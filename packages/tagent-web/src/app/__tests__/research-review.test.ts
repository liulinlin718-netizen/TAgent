import { describe, expect, it } from 'vitest';
import { evidenceUrl, researchReviewItems, type ResearchRecord } from '../../components/ResearchReview.logic';

const source: ResearchRecord['sources'][number] = { id: 's1', title: 'Source', url: 'https://example.com/report', query: 'office',
  retrievedAt: '2026-09-11', publication: { basis: 'unknown' }, readable: true, relevant: false, publisher: 'unverified',
  excerpt: 'The product is planned. It is not generally available.' };
const record: ResearchRecord = { sources: [source],
  assessment: { status: 'insufficient_evidence', researchDate: '2026-09-11', sourceCount: 0,
    datedSourceCount: 0, primarySourceCount: 0, independentPublisherCount: 1, issues: [] },
  draft: { title: 'Report', findings: [{ id: 'f1', heading: 'Product plan', statement: 'Draft statement', basis: 'reported', timeScope: 'background',
    evidence: [{ sourceId: 's1', quote: source.excerpt }] }], limitations: [], unmetRequirements: [] },
  review: { passed: false, checks: [{ id: 'f1', status: 'rejected', reason: 'Off-topic' }], missingRequirements: [],
    checkedStatements: [{ id: 'f1', text: 'Exact reviewed statement' }] } };

describe('research review presentation', () => {
  it('preserves rejected status while distinguishing read original text from topical relevance', () => {
    const item = researchReviewItems(record)[0];
    expect(item).toMatchObject({ status: 'rejected', reason: 'Off-topic', statement: 'Exact reviewed statement' });
    expect(item.citations[0].matched).toBe(true);
    expect(item.citations[0].source?.relevant).toBe(false);
  });
  it('never labels invented or unreadable quotations as matching original evidence', () => {
    const changed = structuredClone(record);
    changed.draft!.findings[0].evidence[0].quote = 'The product is available today.';
    expect(researchReviewItems(changed)[0].citations[0].matched).toBe(false);
    changed.draft!.findings[0].evidence[0].quote = source.excerpt;
    changed.sources[0].readable = false;
    expect(researchReviewItems(changed)[0].citations[0].matched).toBe(false);
    changed.sources = [];
    expect(researchReviewItems(changed)[0].citations[0].matched).toBe(false);
  });
  it('does not manufacture a review or an exact historical snapshot when missing', () => {
    const changed = structuredClone(record);
    delete changed.review!.checkedStatements;
    expect(researchReviewItems(changed)[0].statementLabel).toContain('未保存核对文本快照');
    delete changed.draft;
    expect(researchReviewItems(changed)[0].statement).toBeUndefined();
    delete changed.review;
    expect(researchReviewItems(changed)).toEqual([]);
  });
  it('allows source links but rejects script, file and embedded-credential URLs', () => {
    expect(evidenceUrl(source.url)).toBe(source.url);
    for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', 'https://user:secret@example.com', 'not a url']) expect(evidenceUrl(url)).toBeUndefined();
  });
});
