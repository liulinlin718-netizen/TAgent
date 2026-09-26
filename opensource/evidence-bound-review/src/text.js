import { fail } from './errors.js';
import { LIMITS } from './limits.js';

export function withoutQuotes(text) {
  return text.replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|`[^`\n]*`/g, match => ' '.repeat(match.length));
}

/** A per-call text index: no global cache retains report or material contents. */
export function createTextIndex(text, materialId, path) {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  let parsed;
  const reference = (start, end) => {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= start) lo = mid + 1; else hi = mid; }
    return { ...(materialId === undefined ? {} : { materialId }), quote: text.slice(start, end), start, end, line: lo };
  };
  return {
    reference,
    locate(quote, start, field) {
      const at = start === undefined ? text.indexOf(quote) : start;
      if (!Number.isSafeInteger(at) || at < 0 || text.slice(at, at + quote.length) !== quote)
        fail('quote_not_found', field, 'Quote must be an exact substring at the supplied offset.');
      if (start === undefined && text.indexOf(quote, at + 1) !== -1)
        fail('quote_ambiguous', field, 'Repeated quote requires an explicit start offset.');
      return reference(at, at + quote.length);
    },
    sentences() {
      if (parsed) return parsed;
      const result = [];
      let fence;
      for (const line of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
        if (!line[0]) continue;
        const content = line[0].replace(/[\r\n]+$/, '');
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
        if (fence) {
          if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
          continue;
        }
        if (marker) { fence = marker[1]; continue; }
        if (/^\s*>|^(?: {4}|\t)/.test(content)) continue;
        // Mask quote punctuation for segmentation, but keep every reference in the original text.
        for (const match of withoutQuotes(content).matchAll(/[^。！？!?]+[。！？!?]?/g)) {
          const original = content.slice(match.index, match.index + match[0].length);
          const leading = original.length - original.trimStart().length, quote = original.trim();
          if (!quote) continue;
          const start = line.index + match.index + leading;
          if (result.length >= LIMITS.proseStatements) fail('limit_exceeded', path, 'Too many prose statements; split the text explicitly.');
          result.push(reference(start, start + quote.length));
        }
      }
      parsed = result;
      return parsed;
    },
  };
}
