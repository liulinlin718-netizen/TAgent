export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Inclusive calendar window; 1 means the as-of day only, 30 includes that day plus 29 prior days. */
export function dateWindow(asOf, days = 30) {
  if (!isCalendarDate(asOf)) throw new TypeError('asOf must be a real YYYY-MM-DD calendar date.');
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new TypeError('days must be an integer from 1 to 366.');
  const start = new Date(Date.parse(`${asOf}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  if (!isCalendarDate(start)) throw new TypeError('The requested window is outside supported calendar dates.');
  return { start, end: asOf, days };
}

export function assessDate(source, window, dateEvidence) {
  if (!source || source.basis !== 'publication' || !isCalendarDate(source.publicationDate))
    return { status: 'unverified', ruleId: 'sources.date.unverified', reason: '缺少有效的发布日期；更新日期、URL日期或未知日期不等于发布日期。' };
  if (!dateEvidence || !dateEvidence.quote.includes(source.publicationDate))
    return { status: 'unverified', ruleId: 'sources.date.unverified', reason: '提供的原文没有精确绑定此发布日期，不能仅凭一个日期字段作为近期证据。' };
  if (source.publicationDate > window.end)
    return { status: 'unverified', ruleId: 'sources.date.future', reason: '给定发布日期晚于本次调研日期，不能作为截至该日的近期证据。' };
  if (source.publicationDate < window.start)
    return { status: 'background', ruleId: 'sources.date.outside_window', reason: '来源发布日期早于所选窗口，只可作背景，不能用来证明窗口内的新进展。' };
  return { status: 'eligible', reason: '给定发布日期及原文绑定落在所选窗口内；未核实来源真伪，也未核实正文是否支持结论。' };
}
