#!/usr/bin/env node
import { createReadStream, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reviewReport, VERSION } from './index.js';

const MAX_BYTES = 1024 * 1024;
const safeLine = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');

export function formatText(result) {
  const lines = [`Evidence-Bound Review ${VERSION}`, result.summary, `Fact verification: ${result.factVerification}`,
    `Covered rule families: ${result.coverage.activeRules.join(', ') || 'none'}`];
  for (const finding of result.findings) {
    lines.push('', `[${finding.ruleId}] ${finding.title}`, finding.reason,
      `Report L${finding.report.line} [${finding.report.start}, ${finding.report.end}): ${safeLine(finding.report.quote)}`);
    for (const ref of finding.evidence) lines.push(`Material ${ref.materialId} L${ref.line} [${ref.start}, ${ref.end}): ${safeLine(ref.quote)}`);
  }
  for (const skipped of result.coverage.skipped) lines.push(`Skipped ${skipped.rule}: ${skipped.reason}`);
  lines.push('', 'No findings is NOT a general fact-check pass. No network, model, or commands were used.');
  return lines.join('\n');
}

async function readBounded(stream) {
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > MAX_BYTES) throw new Error('JSON input exceeds 1 MiB.');
      chunks.push(chunk);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { if (stream !== process.stdin) stream.destroy(); }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node src/cli.js [input.json|-] [--json]\nReads UTF-8 JSON only. No external calls.\nExit 0: no covered findings (not verified); 1: findings; 2: invalid input.');
    return 0;
  }
  if (args.length === 1 && args[0] === '--version') { console.log(VERSION); return 0; }
  let file, json = false;
  for (const arg of args) {
    if (arg === '--json' && !json) json = true;
    else if ((!arg.startsWith('-') || arg === '-') && file === undefined) file = arg;
    else { console.error('Invalid arguments. Use --help.'); return 2; }
  }
  try {
    const text = await readBounded(file && file !== '-' ? createReadStream(file) : process.stdin);
    let input;
    try { input = JSON.parse(text); } catch { throw new Error('Input must be valid UTF-8 JSON.'); }
    const result = reviewReport(input);
    console.log(json ? JSON.stringify(result, null, 2) : formatText(result));
    return result.status === 'issues_found' ? 1 : 0;
  } catch (error) {
    // Avoid exposing OS paths, upstream payloads or complete invalid documents.
    console.error(error instanceof TypeError && !error.code ? error.message : 'Could not read or review input. Use bounded, valid UTF-8 JSON matching the documented schema.');
    return 2;
  }
}

let isEntry = false;
try { isEntry = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* Imported without a file entrypoint. */ }
if (isEntry) process.exitCode = await main();
