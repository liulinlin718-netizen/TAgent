# TAgent Standalone Tools

[中文](./README.md) | [English](./README_EN.md)

This directory contains three focused open-source tools extracted from reusable TAgent mechanisms. Each solves one bounded problem, can be copied and used independently, does not require the TAgent service, and does not change the main project's runtime dependencies.

| Project | Purpose | Minimal command |
| --- | --- | --- |
| [Agent Trace Kit](https://github.com/liulinlin718-netizen/agent-trace-kit) | Validate and organize agent WorkflowEvent JSONL into runs, stages, parent relationships, and tool interactions | `node bin/agent-trace.js summary examples/research.jsonl` |
| [Approval-First Import](https://github.com/liulinlin718-netizen/approval-first-import) | Add content-bound risk previews and explicit confirmation to Skill/MCP imports | `node bin/approval-first-import.js demo` |
| [Evidence-Bound Review](https://github.com/liulinlin718-netizen/evidence-bound-review) | Check explicit office-report constraints against supplied evidence and return exact text locations | `node src/cli.js examples/project.json` |

Each directory contains independent source code, bilingual READMEs, type declarations, synthetic examples, tests, an MIT license, and provenance notes. Node.js 22 or newer is required; no model key or TAgent account is needed.

## Design Principles

- **Evidence first:** missing, ambiguous, and unknown values are never guessed into success.
- **Separate operations:** discovery, preview, saving, and execution use different authorization boundaries.
- **Local by default:** examples use local synthetic data without network or model calls.
- **Honest scope:** each tool implements its own contract and does not pretend to be a full agent platform or universal fact checker.
- **Easy integration:** every package has zero runtime dependencies and includes an ESM API, type declarations, and CLI examples.

## Scope Boundaries

- Agent Trace Kit analyzes producer-supplied logs; those logs are not tamper-proof audit evidence.
- Approval-First Import provides an approval contract, while authentication, network fetching, safe persistence, and execution sandboxing belong to the host.
- Evidence-Bound Review applies a limited rule set and does not verify external facts; no matching rule does not mean an entire report is correct.
- None of the tools automatically executes external commands, installs packages, sends messages, or reads private TAgent data.

See each repository README for its input contract, examples, and safety notes.
