---
name: lazyload-cloud
description: Use lazyload-cloud to inspect codebases with compact queries, architecture overviews, call traces, type traces, references, and related context. Use this when you need targeted code context instead of loading many files.
---

Use `lazyload-cloud` as your default skill for focused code exploration.

Recommended workflow:

1. Run `scripts/overview.sh` for a quick architecture view.
2. Run `scripts/query-symbols.sh <query>` to locate the best symbol candidates.
3. Run `scripts/get-function.sh <symbol>` or `scripts/get-class.sh <symbol>` to inspect one target.
4. Run `scripts/trace-calls.sh <symbol>` or `scripts/trace-types.sh <symbol>` when you need relationships.
5. Run `scripts/find-references.sh <symbol>` or `scripts/suggest-related.sh <symbol>` to expand context.

Notes:

- The scripts emit compact output that is optimized for agent consumption.
- Set `LAZYLOAD_CLI_BIN` if you want to point at a local binary instead of `npx lazyload-cloud`.
- For Claude Code, the skill lives under `.claude/skills/`. Other Agent Skills-compatible clients can reuse the same folder structure.
