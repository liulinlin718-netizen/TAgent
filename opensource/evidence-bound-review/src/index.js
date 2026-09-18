import { checkGrounding } from './grounding.js';
import { assessDate, dateWindow } from './dates.js';
import { locate, sentences, reference } from './text.js';

export { dateWindow } from './dates.js';
export const VERSION = '0.1.0';
export const RULESET = 'evidence-bound-review/v1';
export const LIMITS = Object.freeze({ textLength: 100000, totalTextLength: 250000, materials: 32, citations: 128, quoteLength: 2000 });

const object = (value, name, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value)))
    throw new TypeError(`${name} must be a plain object.`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${name} contains an unknown field.`);
  return value;
};
const string = (value, name, limit = LIMITS.textLength) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new TypeError(`${name} must be non-empty text of at most ${limit} UTF-16 code units.`);
  return value;
};
const identifier = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) throw new TypeError('Material id must be 1-80 ASCII letters, digits, dot, underscore or hyphen.');
  return value;
};

function validateMaterial(value, index, requirements = false) {
  object(value, `material[${index}]`, requirements ? ['id', 'text'] : ['id', 'text', 'source']);
  const material = { id: identifier(value.id), text: string(value.text, `material[${index}].text`) };
  if (value.source !== undefined) {
    const source = object(value.source, 'source', ['url', 'basis', 'publicationDate', 'dateQuote', 'dateStart']);
    if (!['publication', 'modified', 'url_hint', 'unknown'].includes(source.basis)) throw new TypeError('source.basis is invalid.');
    if (source.url !== undefined) {
      string(source.url, 'source.url', 2048);
      let url;
      try { url = new URL(source.url); } catch { throw new TypeError('source.url must be an HTTP(S) URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('source.url must be an HTTP(S) URL without credentials.');
    }
    if (source.publicationDate !== undefined) string(source.publicationDate, 'source.publicationDate', 64);
    if (source.dateQuote !== undefined) string(source.dateQuote, 'source.dateQuote', LIMITS.quoteLength);
    if (source.dateStart !== undefined && !Number.isSafeInteger(source.dateStart)) throw new TypeError('source.dateStart must be an integer offset.');
    if (source.dateStart !== undefined && source.dateQuote === undefined) throw new TypeError('source.dateStart requires dateQuote.');
    material.source = { ...source };
    if (source.dateQuote !== undefined) material.dateEvidence = locate(material.text, source.dateQuote, source.dateStart, 'source.dateQuote', material.id);
  }
  return material;
}

/** Pure and deterministic; no clock, network, filesystem, shell, environment or model access. */
export function reviewReport(value) {
  object(value, 'input', ['requirements', 'materials', 'report', 'temporal', 'citations']);
  const requirements = validateMaterial(value.requirements, 'requirements', true), report = string(value.report, 'report');
  if (value.materials !== undefined && (!Array.isArray(value.materials) || value.materials.length > LIMITS.materials)) throw new TypeError('materials must be an array of at most 32 items.');
  const materials = (value.materials || []).map((material, index) => validateMaterial(material, index));
  const all = [requirements, ...materials];
  if (new Set(all.map(item => item.id)).size !== all.length) throw new TypeError('Material ids must be unique, including requirements.');
  if (all.reduce((sum, item) => sum + item.text.length, report.length) > LIMITS.totalTextLength) throw new TypeError('Combined text exceeds the review limit; split the input explicitly.');
  if (value.citations !== undefined && (!Array.isArray(value.citations) || value.citations.length > LIMITS.citations)) throw new TypeError('citations must be an array of at most 128 items.');
  let window;
  if (value.temporal !== undefined) {
    object(value.temporal, 'temporal', ['asOf', 'days']);
    window = dateWindow(value.temporal.asOf, value.temporal.days);
  }
  if (value.citations?.length && !window) throw new TypeError('Citations require an explicit temporal window.');
  const citations = (value.citations || []).map(citation => {
    object(citation, 'citation', ['materialId', 'reportQuote', 'reportStart', 'usage']);
    const material = materials.find(item => item.id === identifier(citation.materialId));
    if (!material) throw new TypeError('Citation materialId must identify a provided reference material.');
    if (!['recent', 'background'].includes(citation.usage)) throw new TypeError('Citation usage must be recent or background.');
    const quote = string(citation.reportQuote, 'citation.reportQuote', LIMITS.quoteLength);
    return { material, usage: citation.usage, report: locate(report, quote, citation.reportStart, 'citation.reportQuote') };
  });
  const findings = [], coverage = { activeRules: [], proseStatements: 0, materialCount: all.length, explicitDateCitations: citations.length, skipped: [] };
  checkGrounding({ requirements, materials, report }, findings, coverage);
  const sources = [];
  for (const citation of citations) {
    if (!coverage.activeRules.includes('sources.date')) coverage.activeRules.push('sources.date');
    const { material } = citation, assessment = assessDate(material.source, window, material.dateEvidence);
    sources.push({ materialId: material.id, usage: citation.usage, report: citation.report, ...assessment,
      ...(material.source?.url ? { url: material.source.url } : {}), ...(material.source?.publicationDate ? { publicationDate: material.source.publicationDate } : {}) });
    if (citation.usage !== 'recent' || assessment.status === 'eligible') continue;
    const evidence = material.dateEvidence || sentences(material.text, material.id)[0] || reference(material.text, 0, Math.min(material.text.length, 200), material.id);
    findings.push({ ruleId: assessment.ruleId, title: '近期引用的日期证据不足', reason: assessment.reason,
      evidence: [evidence], report: citation.report, metadata: { basis: material.source?.basis || 'unknown',
        publicationDate: material.source?.publicationDate ?? null, windowStart: window.start, windowEnd: window.end } });
  }
  const unique = [...new Map(findings.map(item => [JSON.stringify([item.ruleId, item.report.start, item.report.end, item.evidence.map(ref => [ref.materialId, ref.start, ref.end])]), item])).values()];
  return { ruleset: RULESET, status: unique.length ? 'issues_found' : 'no_findings', factVerification: 'not_performed',
    summary: unique.length ? `发现 ${unique.length} 项给定材料范围内的问题；需要人工复核。` : '未发现已覆盖规则中的冲突；这不是事实验证通过或全文审核通过。',
    findings: unique, coverage, sources, ...(window ? { window } : {}),
    limitations: [
      '只覆盖明确的中文串行/日历排期措辞、有限单位的字面包含关系，以及调用者显式绑定的来源日期。',
      '不验证外部事实、来源真实性、链接内容、算术、全部指令、英文语义或报告交付质量。',
      '日期合格只代表给定发布日期和引用绑定在窗口内，不证明结论受到正文支持；未绑定的报告引用不检查。',
      '不是完整 Markdown 解析器；跳过顶层代码围栏、缩进代码和引用块。嵌套结构、复杂否定、表格语义或混合条件可能漏检。',
    ] };
}
