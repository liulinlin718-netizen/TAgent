/** Explicit same-day requests differ from an as-of date or a multi-day period. */
export function requestsSameDayResearch(query: string): boolean {
  if (/(?:近|过去|最近)\s*(?:\d+|三十|一个|一)\s*(?:天|日|月)|本月|本周|last\s+\d+\s+days|this\s+(?:month|week)/i.test(query)) return false;
  const scope = query.replace(/(?:截至|截止|到)\s*(?:今天|今日)|(?:今天|今日)\s*(?:为止|之前)|\b(?:as of|through|up to)\s+today\b/gi, '');
  return /今天|今日|\btoday\b/i.test(scope);
}

export function requiresRecentWindow(query: string): boolean {
  return /最新|近\s*30\s*天|近三十天|过去\s*30\s*天|近一个月|近一月|本月|新闻|资讯|今天|今日|latest|recent|last\s*30\s*days|news|\btoday\b/i.test(query);
}

export function researchWindowStart(researchDate: string, request: string | boolean): string | undefined {
  if (!(typeof request === 'boolean' ? request : requiresRecentWindow(request))) return undefined;
  const date = new Date(`${researchDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== researchDate) throw new Error('Invalid research calendar date');
  if (typeof request === 'string' && requestsSameDayResearch(request)) return researchDate;
  // Preserve the existing rolling-window contract for older callers and records.
  return new Date(date.getTime() - 30 * 86400000).toISOString().slice(0, 10);
}
