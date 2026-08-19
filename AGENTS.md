# AGENTS.md

Guidance for coding agents working on the **lazyload-cloud** repository itself.

> Note: `lazyload-cloud init` can generate an `AGENTS.md` *inside a target project* to teach agents how to use the CLI for code exploration. This file is different — it documents how to develop and maintain this repository.

## Project overview

`lazyload-cloud` is a Node.js CLI (with a companion Cloudflare Worker) that builds and queries a compact code-context index for TypeScript, JavaScript, and Python projects. It can run fully locally, through a deployed Cloudflare Worker, or by talking to Cloudflare D1/R2 storage directly.

The package is published to npm as `lazyload-cloud` and ships:

- a CLI binary (`lazyload-cloud` → `dist/bin.js`)
- a library entrypoint (`.` → `dist/index.js`)
- a Worker entrypoint (`./worker` → `dist/worker.js`)
- bundled Agent Skills under `skills/`
- benchmark scripts under `benchmarks/`

## Requirements

- **Node.js 20+** (`engines.node` is `>=20.0.0`)
- npm (a `package-lock.json` is committed)

`devbox.json` optionally pins `nodejs@22`, `bun@1`, `gh@2`, and `git` for a reproducible shell, but Devbox is not required to build or test.

## Source layout and entrypoints

- `src/bin.ts` — CLI executable entrypoint; calls `runCli(process.argv)`.
- `src/cli.ts` — all Commander command definitions (`init`, `auth`, `index`, `watch`, `stats`, `query`, `overview`, `sync`, `status`, `config inspect`, `doctor`, and top-level compatibility commands).
- `src/index.ts` — public library exports.
- `src/worker.ts` — Cloudflare Worker `fetch` handler and `handleWorkerRequest`.
- `src/types.ts` — shared type definitions.
- `src/lib/` — implementation modules:
  - `indexer.ts` — index building and query helpers (`buildIndex`, `searchSymbols`, `traceCalls`, etc.).
  - `format.ts` — `json` / `compact` / `markdown` output formatting.
  - `project-config.ts` — `lazyload.config.json` schema (Zod) and load/save.
  - `runtime-config.ts` — auth/config resolution and precedence.
  - `user-config.ts` — stored auth file (`~/.config/lazyload-cloud/auth.json`).
  - `cloud-store.ts` / `direct-cloud-store.ts` / `cloud-store-factory.ts` — Worker-mode and direct D1/R2 remote stores and mode selection.
  - `skills.ts` — Agent Skills and Cloudflare scaffold generation.
- `tests/` — Vitest tests.
- `skills/` — bundled skills (`lazyload-cloud`, `lazyload-cloud-project`, `lazyload-cloud-sync`).
- `benchmarks/` — `quick.mjs` and `compare.mjs`.

## Setup

```bash
npm install
```

## Build, test, typecheck

All commands are defined in `package.json` scripts:

```bash
npm run build       # tsc -p tsconfig.json  → emits to dist/
npm run typecheck   # tsc -p tsconfig.json --noEmit
npm test            # vitest run (single pass)
npm run test:watch  # vitest (watch mode)
```

Benchmarks (require a build first):

```bash
npm run build
npm run bench:quick   -- /path/to/project
npm run bench:compare -- /path/to/project <symbol>
```

Before committing changes, run **`npm run typecheck`** and **`npm test`** and make sure both pass.

### Linting

There is **no separate linter** configured (no ESLint/Prettier config, no `lint` script). Type safety is enforced by `npm run typecheck`. Do not invent a lint command.

## Coding conventions

- **Language:** TypeScript, ESM only (`"type": "module"`). Use `.js` extension in relative import specifiers (NodeNext module resolution), e.g. `import { runCli } from './cli.js';`.
- **Strictness:** `tsconfig.json` enables `strict`, `noImplicitOverride`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Write code that satisfies these — avoid `any`, handle possibly-undefined index access, and don't pass `undefined` to optional properties unless the type allows it.
- **Target/module:** `ES2022`, `NodeNext`.
- **Style:** 2-space indentation, single quotes, semicolons — match the existing files.
- **Config validation:** project config is validated with Zod in `project-config.ts`; extend the schema there rather than parsing config ad hoc.
- **Output formats:** user-facing command output should support the `json` / `compact` / `markdown` formats via the helpers in `lib/format.ts`.
- **Tests:** add or update Vitest tests under `tests/` for behavior changes. `tests/cli-parity.test.ts` and `tests/tool-compat.test.ts` guard CLI/command parity — keep them passing when adding commands.

## Notes and gotchas

- Compiled output goes to `dist/` (git-ignored). `bin`, `main`, `types`, and `exports` in `package.json` all point at `dist/`, so a build is required for the published/linked CLI to work; `prepublishOnly` runs `build` then `test`.
- `.env` files are **not** auto-loaded by the CLI. Auth/config resolution precedence is: CLI flags → `--env-file` → `process.env` → user auth file → project config → defaults (see `runtime-config.ts`).
- The stored auth file is written with `0600` permissions and may contain Cloudflare/R2 secrets — never log or commit its contents.
- Do not modify generated files by hand; regenerate via the relevant code (e.g. skill/scaffold output from `lib/skills.ts`).
- Keep the English `README.md` and the Japanese `README.ja.md` in sync when documenting user-facing changes.
