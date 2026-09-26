export const VERSION: '0.2.0';
export const RULESET: 'evidence-bound-review/v2';
export const LIMITS: Readonly<{ textLength: number; totalTextLength: number; materials: number; citations: number; quoteLength: number;
  proseStatements: number; subsetRelations: number; findings: number; integerDigits: number }>;

export type ReviewErrorCode = 'invalid_type' | 'invalid_value' | 'unknown_field' | 'duplicate_id' | 'unknown_material'
  | 'limit_exceeded' | 'quote_not_found' | 'quote_ambiguous' | 'input_not_readable' | 'invalid_json' | 'invalid_utf8' | 'invalid_arguments';
export class ReviewInputError extends TypeError {
  constructor(code: ReviewErrorCode, path: string, message: string);
  code: ReviewErrorCode;
  /** JSON Pointer into the input; the empty string denotes the root. No OS path or input text. */
  path: string;
}
export interface ReviewErrorEnvelope {
  schema: 'evidence-bound-review/error-v1';
  error: { code: ReviewErrorCode | 'internal_error'; path: string; message: string };
}
/** Unexpected errors are redacted; recognized input errors retain their safe code/path/message. */
export function errorEnvelope(error: unknown): ReviewErrorEnvelope;

export interface TextReference {
  quote: string;
  /** Zero-based UTF-16 offset in the original, unmodified text. */
  start: number;
  /** Exclusive UTF-16 end offset. */
  end: number;
  /** One-based line number, treating CRLF as a single line ending. */
  line: number;
}
export interface MaterialReference extends TextReference { materialId: string }
export interface Requirements { id: string; text: string }
export interface SourceMetadata {
  /** Informational only; never fetched. HTTP(S), without embedded credentials. */
  url?: string;
  basis: 'publication' | 'modified' | 'url_hint' | 'unknown';
  publicationDate?: string;
  /** Exact excerpt from material.text containing the given YYYY-MM-DD date. */
  dateQuote?: string;
  /** Required when dateQuote occurs more than once. */
  dateStart?: number;
}
export interface Material extends Requirements { source?: SourceMetadata }
export interface DateCitation {
  materialId: string;
  reportQuote: string;
  /** Required when reportQuote occurs more than once. */
  reportStart?: number;
  usage: 'recent' | 'background';
}
export interface ReviewInput {
  /** Only this field supplies execution constraints. Reference materials cannot change them. */
  requirements: Requirements;
  materials?: Material[];
  report: string;
  /** No implicit wall clock. days defaults to 30; 1 means the asOf day only. */
  temporal?: { asOf: string; days?: number };
  /** Explicit caller-supplied bindings, not inferred from all report links. */
  citations?: DateCitation[];
}
export type RuleId = 'requirements.serial.parallel_action' | 'requirements.serial.redundant_question'
  | 'requirements.calendar.excluded' | 'material.subset.already_explicit'
  | 'sources.date.unverified' | 'sources.date.future' | 'sources.date.outside_window';
export interface Finding {
  ruleId: RuleId;
  title: string;
  reason: string;
  report: TextReference;
  evidence: MaterialReference[];
  metadata?: { basis: SourceMetadata['basis']; publicationDate: string | null; windowStart: string; windowEnd: string };
}
export interface DateWindow { start: string; end: string; days: number }
export interface SourceCheck {
  materialId: string;
  usage: DateCitation['usage'];
  report: TextReference;
  status: 'eligible' | 'background' | 'unverified';
  reason: string;
  ruleId?: RuleId;
  url?: string;
  publicationDate?: string;
}
export interface ReviewResult {
  ruleset: typeof RULESET;
  status: 'issues_found' | 'no_findings';
  factVerification: 'not_performed';
  summary: string;
  findings: Finding[];
  coverage: {
    activeRules: Array<'requirements.serial' | 'requirements.calendar' | 'material.subset' | 'sources.date'>;
    proseStatements: number;
    materialCount: number;
    explicitDateCitations: number;
    /** Bindings deduplicated by materialId, report range and usage. sources has this length. */
    uniqueDateCitations: number;
    /** Distinct materials whose dates were assessed in this call. */
    assessedDateSources: number;
    skipped: Array<{ rule: string; reason: string }>;
  };
  sources: SourceCheck[];
  window?: DateWindow;
  limitations: string[];
}

/** Pure offline check. Throws ReviewInputError (a TypeError) on invalid, oversized or ambiguously bound input. */
export function reviewReport(input: ReviewInput): ReviewResult;
/** Inclusive day window, based only on caller-supplied dates. Does not use the current time. */
export function dateWindow(asOf: string, days?: number): DateWindow;
