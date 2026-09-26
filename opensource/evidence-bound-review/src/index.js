import { checkGrounding } from './grounding.js';
import { assessDate, checkedDateWindow } from './dates.js';
import { createTextIndex } from './text.js';
import { fail } from './errors.js';
import { LIMITS } from './limits.js';

export { dateWindow } from './dates.js';
export { ReviewInputError, errorEnvelope } from './errors.js';
export { LIMITS } from './limits.js';
export const VERSION = '0.2.0';
export const RULESET = 'evidence-bound-review/v2';

const object = (value, path, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value)))
    fail('invalid_type', path, 'Expected a plain object.');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail('unknown_field', path, 'Object contains an unknown field.');
  return value;
};
const string = (value, path, limit = LIMITS.textLength) => {
  if (typeof value !== 'string') fail('invalid_type', path, 'Expected text.');
  if (!value.trim() || value.length > limit) fail(value.length > limit ? 'limit_exceeded' : 'invalid_value', path,
    `Expected non-empty text of at most ${limit} UTF-16 code units.`);
  return value;
};
const identifier = (value, path) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value))
    fail('invalid_value', path, 'Material id must be 1-80 ASCII letters, digits, dot, underscore or hyphen.');
  return value;
};
const boundedArray = (value, path, limit) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) fail(Array.isArray(value) ? 'limit_exceeded' : 'invalid_type', path,
    `Expected an array of at most ${limit} items.`);
  return value;
};

function validateMaterial(value, path, requirements = false) {
  object(value, path, requirements ? ['id', 'text'] : ['id', 'text', 'source']);
  const material = { id: identifier(value.id, `${path}/id`), text: string(value.text, `${path}/text`), path };
  if (value.source !== undefined) {
    const field = `${path}/source`, source = object(value.source, field, ['url', 'basis', 'publicationDate', 'dateQuote', 'dateStart']);
    if (!['publication', 'modified', 'url_hint', 'unknown'].includes(source.basis)) fail('invalid_value', `${field}/basis`, 'Source basis is invalid.');
    if (source.url !== undefined) {
      string(source.url, `${field}/url`, 2048);
      let url;
      try { url = new URL(source.url); } catch { fail('invalid_value', `${field}/url`, 'Source URL must be an HTTP(S) URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        fail('invalid_value', `${field}/url`, 'Source URL must be an HTTP(S) URL without credentials.');
    }
    if (source.publicationDate !== undefined) string(source.publicationDate, `${field}/publicationDate`, 64);
    if (source.dateQuote !== undefined) string(source.dateQuote, `${field}/dateQuote`, LIMITS.quoteLength);
    if (source.dateStart !== undefined && (!Number.isSafeInteger(source.dateStart) || source.dateStart < 0))
      fail('invalid_value', `${field}/dateStart`, 'Date start must be a non-negative integer offset.');
    if (source.dateStart !== undefined && source.dateQuote === undefined) fail('invalid_value', `${field}/dateQuote`, 'Date start requires dateQuote.');
    material.source = { ...source };
  }
  return material;
}

/** Pure and deterministic; no clock, network, filesystem, shell, environment or model access. */
export function reviewReport(value) {
  object(value, '', ['requirements', 'materials', 'report', 'temporal', 'citations']);
  const requirements = validateMaterial(value.requirements, '/requirements', true), report = string(value.report, '/report');
  const materials = Array.from(boundedArray(value.materials, '/materials', LIMITS.materials), (material, index) => validateMaterial(material, `/materials/${index}`));
  const all = [requirements, ...materials];
  const ids = new Set();
  for (const material of all) {
    if (ids.has(material.id)) fail('duplicate_id', `${material.path}/id`, 'Material ids must be unique, including requirements.');
    ids.add(material.id);
  }
  if (all.reduce((sum, item) => sum + item.text.length, report.length) > LIMITS.totalTextLength)
    fail('limit_exceeded', '', 'Combined text exceeds the review limit; split the input explicitly.');
  const rawCitations = boundedArray(value.citations, '/citations', LIMITS.citations);
  let window;
  if (value.temporal !== undefined) {
    object(value.temporal, '/temporal', ['asOf', 'days']);
    window = checkedDateWindow(value.temporal.asOf, value.temporal.days);
  }
  if (rawCitations.length && !window) fail('invalid_value', '/temporal', 'Citations require an explicit temporal window.');
  for (const material of all) {
    material.index = createTextIndex(material.text, material.id, `${material.path}/text`);
    const source = material.source;
    if (source?.dateQuote !== undefined)
      material.dateEvidence = material.index.locate(source.dateQuote, source.dateStart, `${material.path}/source/dateQuote`);
  }
  const reportIndex = createTextIndex(report, undefined, '/report'), materialMap = new Map(materials.map(item => [item.id, item]));
  const citations = new Map();
  for (const [index, citation] of rawCitations.entries()) {
    const path = `/citations/${index}`;
    object(citation, path, ['materialId', 'reportQuote', 'reportStart', 'usage']);
    const material = materialMap.get(identifier(citation.materialId, `${path}/materialId`));
    if (!material) fail('unknown_material', `${path}/materialId`, 'Citation materialId must identify a provided reference material.');
    if (!['recent', 'background'].includes(citation.usage)) fail('invalid_value', `${path}/usage`, 'Citation usage must be recent or background.');
    const quote = string(citation.reportQuote, `${path}/reportQuote`, LIMITS.quoteLength);
    if (citation.reportStart !== undefined && (!Number.isSafeInteger(citation.reportStart) || citation.reportStart < 0))
      fail('invalid_value', `${path}/reportStart`, 'Report start must be a non-negative integer offset.');
    const ref = reportIndex.locate(quote, citation.reportStart, `${path}/reportQuote`);
    citations.set(JSON.stringify([material.id, ref.start, ref.end, citation.usage]), { material, usage: citation.usage, report: ref });
  }
  const findings = new Map(), coverage = { activeRules: [], proseStatements: 0, materialCount: all.length,
    explicitDateCitations: rawCitations.length, uniqueDateCitations: citations.size, assessedDateSources: 0, skipped: [] };
  const addFinding = finding => {
    const key = JSON.stringify([finding.ruleId, finding.report.start, finding.report.end, finding.evidence.map(ref => [ref.materialId, ref.start, ref.end])]);
    if (findings.has(key)) return;
    if (findings.size >= LIMITS.findings) fail('limit_exceeded', '', 'Too many findings; split the input explicitly.');
    findings.set(key, finding);
  };
  checkGrounding({ requirements, materials, reportIndex }, addFinding, coverage);
  const sources = [], assessments = new Map();
  for (const citation of citations.values()) {
    if (!coverage.activeRules.includes('sources.date')) coverage.activeRules.push('sources.date');
    const { material } = citation;
    if (!assessments.has(material.id)) assessments.set(material.id, assessDate(material.source, window, material.dateEvidence));
    const assessment = assessments.get(material.id);
    sources.push({ materialId: material.id, usage: citation.usage, report: citation.report, ...assessment,
      ...(material.source?.url ? { url: material.source.url } : {}), ...(material.source?.publicationDate ? { publicationDate: material.source.publicationDate } : {}) });
    if (citation.usage !== 'recent' || assessment.status === 'eligible') continue;
    const evidence = material.dateEvidence || material.index.sentences()[0] || material.index.reference(0, Math.min(material.text.length, 200));
    addFinding({ ruleId: assessment.ruleId, title: '近期引用的日期证据不足', reason: assessment.reason,
      evidence: [evidence], report: citation.report, metadata: { basis: material.source?.basis || 'unknown',
        publicationDate: material.source?.publicationDate ?? null, windowStart: window.start, windowEnd: window.end } });
  }
  coverage.assessedDateSources = assessments.size;
  const unique = [...findings.values()];
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
