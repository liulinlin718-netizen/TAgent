#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTraceFile, createTraceIndex, modelForEvents, formatText, TraceInputError } from '../src/index.js';
import { terminalText } from '../src/format.js';

const help = `Agent Trace Kit (offline, read-only)

  node bin/agent-trace.js summary FILE [--json] [filters]
  node bin/agent-trace.js validate FILE [--json]
  node bin/agent-trace.js events FILE [--json] [filters] [--offset N] [--limit N]

Filters: --workspace ID --session ID --run ID --task ID --agent ID --type TYPE
Only events accepts pagination (default limit 100, maximum 1000).
No network, model calls, execution, data writes or automatic file discovery.
Exit 0: valid input (warnings/failed tasks allowed); 2: invalid trace records; 1: usage/IO/limit error.
`;
const filterFlags = { '--workspace': 'workspaceId', '--session': 'sessionId', '--run': 'runId', '--task': 'taskId', '--agent': 'agentId', '--type': 'type' };

function parseArgs(args) {
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) return null;
  const [command, file, ...flags] = args;
  if (!['summary', 'validate', 'events'].includes(command) || !file || file.startsWith('--')) throw new TraceInputError('usage', 'Choose summary/validate/events and one local JSONL file.');
  const result = { command, file, json: false, filter: {}, offset: 0, limit: 100 }, seen = new Set();
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (seen.has(flag)) throw new TraceInputError('usage', 'Duplicate options are not accepted.');
    seen.add(flag);
    if (flag === '--json') { result.json = true; continue; }
    if (!Object.hasOwn(filterFlags, flag) && !['--offset', '--limit'].includes(flag)) throw new TraceInputError('usage', 'Unknown option; use --help.');
    const value = flags[++index];
    if (value === undefined || value.startsWith('--')) throw new TraceInputError('usage', 'Option value is missing.');
    if (Object.hasOwn(filterFlags, flag)) result.filter[filterFlags[flag]] = value;
    else {
      if (command !== 'events' || !/^\d+$/.test(value)) throw new TraceInputError('usage', 'Only events accepts nonnegative integer pagination.');
      result[flag.slice(2)] = Number(value);
    }
  }
  if (command === 'validate' && Object.keys(result.filter).length) throw new TraceInputError('usage', 'Validation checks the whole file and does not accept filters.');
  return result;
}

function eventView(event) {
  // No raw data/tool arguments or agent configuration on stdout by default.
  const { data: _data, agentSnapshot: _snapshot, ...view } = event;
  return view;
}

export async function main(args, stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text)) {
  try {
    const options = parseArgs(args);
    if (!options) { stdout(help); return 0; }
    const loaded = await readTraceFile(resolve(options.file));
    let output;
    if (options.command === 'validate') {
      output = { counts: loaded.counts, issues: loaded.issues };
      stdout(options.json ? JSON.stringify(output, null, 2) + '\n'
        : `Validation: ${loaded.counts.accepted} accepted, ${loaded.counts.invalid} invalid, ${loaded.counts.conflictingIdentities} conflicting identities, ${loaded.issues.length} diagnostics.\n`);
    } else {
      const index = createTraceIndex(loaded.events);
      if (options.command === 'events') {
        const page = index.query(options.filter, { offset: options.offset, limit: options.limit });
        output = { ...page, events: page.events.map(eventView), sourceCounts: loaded.counts, issues: loaded.issues };
        stdout(options.json ? JSON.stringify(output, null, 2) + '\n'
          : `Events ${page.offset}..${page.offset + page.events.length} of ${page.total}; next offset ${page.nextOffset ?? 'none'}\n`
            + page.events.map(event => `${terminalText(event.eventId)} | ${event.timestamp ?? 'time unknown'} | ${terminalText(event.type)} | ${terminalText(event.summary)}\n`).join(''));
      } else {
        const selected = []; let offset = 0;
        do { const page = index.query(options.filter, { offset, limit: 1000 }); selected.push(...page.events); offset = page.nextOffset; } while (offset !== null);
        const model = modelForEvents(selected);
        output = { version: 1, counts: loaded.counts, filtered: Object.keys(options.filter).length > 0,
          selectedEventCount: selected.length, runs: model.runs, issues: [...loaded.issues, ...model.issues],
          note: 'Outcomes are explicit producer claims, not verified task quality. Cost is only a recorded run total, not a bill. JSONL is not tamper-proof audit evidence.' };
        stdout(options.json ? JSON.stringify(output, null, 2) + '\n' : formatText(output));
      }
    }
    return loaded.issues.some(item => item.severity === 'error') ? 2 : 0;
  } catch (error) {
    const code = error instanceof TraceInputError ? error.code : 'unexpected_error';
    const message = error instanceof TraceInputError ? error.message : 'Trace processing failed.';
    stderr(`${terminalText(code)}: ${terminalText(message)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
