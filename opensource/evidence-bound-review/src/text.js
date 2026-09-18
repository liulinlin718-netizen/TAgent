export function reference(text, start, end, materialId) {
  return { ...(materialId === undefined ? {} : { materialId }), quote: text.slice(start, end), start, end,
    line: text.slice(0, start).split(/\r\n|\r|\n/).length };
}

// Deliberately not a Markdown parser: omit common top-level examples and retain exact offsets.
export function sentences(text, materialId) {
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
    for (const match of content.matchAll(/[^。！？!?]+[。！？!?]?/g)) {
      const leading = match[0].length - match[0].trimStart().length;
      const quote = match[0].trim();
      if (!quote) continue;
      const start = line.index + match.index + leading;
      if (result.length >= 2000) throw new TypeError('Too many prose statements; split the text explicitly.');
      result.push(reference(text, start, start + quote.length, materialId));
    }
  }
  return result;
}

export function withoutQuotes(text) {
  return text.replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|`[^`\n]*`/g, match => ' '.repeat(match.length));
}

export function locate(text, quote, start, field, materialId) {
  const at = start === undefined ? text.indexOf(quote) : start;
  if (!Number.isSafeInteger(at) || at < 0 || text.slice(at, at + quote.length) !== quote)
    throw new TypeError(`${field}: quote must be an exact substring at the supplied offset.`);
  if (start === undefined && text.indexOf(quote, at + 1) !== -1)
    throw new TypeError(`${field}: repeated quote requires an explicit start offset.`);
  return reference(text, at, at + quote.length, materialId);
}
