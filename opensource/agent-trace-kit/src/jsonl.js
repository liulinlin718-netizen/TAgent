import { lstat, open } from 'node:fs/promises';
import { LIMITS, TraceInputError, issue, normalizeEvent, collectEvents } from './events.js';

function bound(value, fallback, maximum, name) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TraceInputError('invalid_limit', `${name} must be a positive integer within the built-in maximum.`);
  return value;
}

/** Read only a caller-selected regular local file. Byte offsets refer to the original UTF-8 file. */
export async function* readJsonl(path, options = {}) {
  const maxFileBytes = bound(options.maxFileBytes, LIMITS.maxFileBytes, LIMITS.maxFileBytes, 'maxFileBytes');
  const maxLineBytes = bound(options.maxLineBytes, LIMITS.maxLineBytes, LIMITS.maxLineBytes, 'maxLineBytes');
  const maxEvents = bound(options.maxEvents, LIMITS.maxEvents, LIMITS.maxEvents, 'maxEvents');
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new TraceInputError('not_regular_file', 'Choose a regular file, not a directory, pipe or symbolic link.');
    if (before.size > maxFileBytes) throw new TraceInputError('file_limit', 'JSONL file exceeds the byte limit.');
    handle = await open(path, 'r');
    const opened = await handle.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) throw new TraceInputError('file_changed', 'File identity changed while opening.');
    const buffer = Buffer.alloc(64 * 1024), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let tail = Buffer.alloc(0), offset = 0, position = 0, line = 0, records = 0;
    function parse(bytes, byteLength) {
      line++;
      const at = offset; offset += byteLength;
      let text;
      try { text = decoder.decode(bytes); }
      catch {
        if (++records > maxEvents) throw new TraceInputError('event_limit', 'JSONL file exceeds the record limit.');
        return { line, byteOffset: at, byteLength, event: null, issues: [issue('invalid_utf8', 'error', 'Line is not valid UTF-8.', { line })] };
      }
      if (line === 1 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (!text.trim()) return null;
      if (++records > maxEvents) throw new TraceInputError('event_limit', 'JSONL file exceeds the record limit.');
      let raw;
      try { raw = JSON.parse(text); }
      catch { return { line, byteOffset: at, byteLength, event: null, issues: [issue('invalid_json', 'error', 'Line is not a complete JSON value.', { line })] }; }
      const result = normalizeEvent(raw);
      return { line, byteOffset: at, byteLength, event: result.event, issues: result.issues.map(item => ({ ...item, line })) };
    }
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      if (position > maxFileBytes) throw new TraceInputError('file_limit', 'JSONL file grew beyond the byte limit.');
      const current = Buffer.concat([tail, buffer.subarray(0, bytesRead)]);
      let start = 0, end;
      while ((end = current.indexOf(10, start)) !== -1) {
        const length = end + 1 - start;
        if (length > maxLineBytes) throw new TraceInputError('line_limit', 'JSONL line exceeds the byte limit.');
        const item = parse(current.subarray(start, end), length);
        if (item) yield item;
        start = end + 1;
      }
      tail = Buffer.from(current.subarray(start));
      if (tail.length > maxLineBytes) throw new TraceInputError('line_limit', 'JSONL line exceeds the byte limit.');
    }
    if (tail.length) { const item = parse(tail, tail.length); if (item) yield item; }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new TraceInputError('file_changed', 'File changed while reading; retry a stable copy.');
  } catch (error) {
    if (error instanceof TraceInputError) throw error;
    throw new TraceInputError('file_read_failed', 'Cannot read the selected local trace file.');
  } finally { await handle?.close(); }
}

export async function readTraceFile(path, options = {}) {
  const events = [], sourceIssues = []; let invalid = 0, records = 0;
  for await (const record of readJsonl(path, options)) {
    records++;
    sourceIssues.push(...record.issues);
    if (record.event) events.push(record.event); else invalid++;
  }
  const collected = collectEvents(events);
  // Validation warnings already have file line numbers; retain only new deduplication issues.
  return { events: collected.events, counts: { ...collected.counts, input: records, invalid },
    issues: [...sourceIssues, ...collected.issues.filter(item => item.code === 'conflicting_duplicate')] };
}
