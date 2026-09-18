const sensitive = /(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credentials?|^env$|^headers$)$/i;
const mask = '[redacted]';
export function previewToolArguments(input: unknown) {
  let redacted = false, truncated = false;
  const cleanText = (text: string) => text.replace(/((?:Bearer\s+)|(?:(?:api[_-]?key|token|secret|password)\s*[=:]\s*)|(?:--(?:api[_-]?key|token|secret|password)\s+))(?:"[^"]*"|'[^']*'|[^\s&"']+)/gi,
    (_match, prefix: string) => { redacted = true; return prefix + mask; });
  const clean = (value: unknown, depth = 0): unknown => {
    if (depth > 12) { truncated = true; return '[nested content omitted]'; }
    if (typeof value === 'string') {
      let text = cleanText(value);
      if (/^https?:\/\//i.test(text)) {
        try {
          const url = new URL(text);
          if (url.username || url.password) { url.username = ''; url.password = ''; redacted = true; }
          for (const key of [...url.searchParams.keys()]) if (sensitive.test(key) || /signature|credential/i.test(key)) { url.searchParams.set(key, mask); redacted = true; }
          text = url.href;
        } catch { /* The original text is displayed, never fetched here. */ }
      }
      if (text.length > 16000) { truncated = true; text = text.slice(0, 16000) + '\n[content omitted]'; }
      return text;
    }
    if (Array.isArray(value)) { if (value.length > 100) truncated = true; return value.slice(0, 100).map(item => clean(item, depth + 1)); }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value); if (entries.length > 100) truncated = true;
      return Object.fromEntries(entries.slice(0, 100).map(([key, item]) => {
        if (sensitive.test(key)) { redacted = true; return [key, mask]; }
        return [key, clean(item, depth + 1)];
      }));
    }
    return value;
  };
  let value = clean(input), preview = JSON.stringify(value, null, 2) || '{}';
  if (Buffer.byteLength(preview) > 16384) { truncated = true; value = { omitted: 'Arguments exceed the approval preview limit' }; preview = '参数超出预览大小上限，不能批准执行；请缩小请求后重试。'; }
  return { value, preview, redacted, truncated };
}
