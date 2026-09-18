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
