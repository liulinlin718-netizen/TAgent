# Local Verification

Date: 2026-09-18. Runtime: Node.js v24.13.1, Windows.

- `node --test`: 95 tests passed, 0 failed, 0 skipped.
- `node --test --test-reporter=dot`: exit 0 after the CLI entrypoint adjustment.
- `node src/cli.js examples/project.json`: three expected findings, exit 1.
- The CLI source-date fixture, stdin, invalid UTF-8/JSON, size limits and exit codes are exercised by `test/cli.test.js`.
- `tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck type-tests/usage.mts`: exit 0 using an already installed TypeScript tool, no installation.
- Package-name self import of `reviewReport` and `dateWindow`: successful, with `status: no_findings` and `factVerification: not_performed`.

No model, network, account, mailbox, or installation was used by these tests.
No generated build or dependency directory was created. Tests use synthetic
fixtures and Node's built-in runner.

The package declares Node >=22; this run verified Node 24, not a complete
cross-platform/Node-version matrix. The findings are narrow deterministic
checks, not evidence of general semantic accuracy or factual truth. See README
for explicit scope and limitations.

## Implementation Follow-Up: 2026-09-26

Runtime: Node.js v24.13.1, Windows. Version 0.2.0, ruleset v2. The record
above remains the historical v0.1.0 result, not a claim about the current tree.

- Targeted grounding/optimization run: 88 tests passed before the final CLI
  and malformed-source regressions were added.
- Final `node --test --test-reporter=dot`: 132 tests passed, exit 0.
- TypeScript consumer check (same flags as above): exit 0, using the existing
  local TypeScript executable without installing dependencies.
- CLI project fixture: three expected findings, exit 1. The suite covers
  structured stderr, empty stdout, errors, dates, stdin, and exit codes.
- `node examples/handle-review-error.mjs`: exit 0, demonstrates
  `quote_not_found` at `/materials/0/source/dateQuote` without echoing input.

Bounded performance probe: one 92,489 UTF-16-unit material, 1,800 statements,
missing publication metadata, repeated identical recent-source citations.
One warm-up and three measurements per case; median observations:

| Raw citations | Median | Unique bindings | Assessed materials |
| --- | --- | --- | --- |
| 1 | 26.41 ms | 1 | 1 |
| 16 | 29.27 ms | 1 | 1 |
| 128 | 29.39 ms | 1 | 1 |

All cases produced one identical finding and original text location. The
same-machine bound `t128 <= 2 * t1 + 100 ms` passed. These are local
observations, not a cross-machine latency guarantee or general complexity
proof. Regression tests also check per-index segmentation reuse and cache
isolation between calls.

No network, model/API costs, account access, external commands from input,
dependency installation, commits, or pushes. No build/cache files were
generated. Node 22 and Linux remain unverified; integration into TAgent's
embedded copy is not part of this standalone change.
