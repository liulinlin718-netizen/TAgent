import type { OrchestratorResult } from '@tagent/core';

export type ResearchRecord = NonNullable<OrchestratorResult['research']>;

export function evidenceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export function researchReviewItems(research: ResearchRecord) {
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  return (research.review?.checks || []).map(check => {
    const finding = research.draft?.findings.find(item => item.id === check.id);
    const reviewed = research.review?.checkedStatements?.find(item => item.id === check.id);
    return {
      ...check,
      heading: finding?.heading || check.id,
      statement: reviewed?.text || finding?.statement,
      statementLabel: reviewed ? '核对时的结论' : '草稿结论（未保存核对文本快照）',
      citations: (finding?.evidence || []).map(citation => {
        const source = research.sources.find(item => item.id === citation.sourceId);
        const passages = source?.passages?.length ? source.passages : source ? [source.excerpt] : [];
        return { source, quote: citation.quote, matched: !!source?.readable && normalize(citation.quote).length >= 16
          && passages.some(passage => normalize(passage).includes(normalize(citation.quote))) };
      }),
    };
  });
}
