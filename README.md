# lazyload-cloud

[日本語版はこちら](./README.ja.md)

`lazyload-cloud` is a Node CLI for building and querying compact code context from local projects. It indexes **TypeScript, JavaScript, and Python**, exposes a focused query surface for code exploration, and can work in three modes:

1. **Local mode** — read and query the local index only
2. **Worker mode** — sync/query through a deployed Cloudflare Worker
3. **Direct D1/R2 mode** — talk to Cloudflare storage directly from the CLI, without deploying a Worker

## Requirements

- **Node.js 20+**

## Install

```bash
npm install -g lazyload-cloud@0.1.4
```

You can also run it with `npx lazyload-cloud`.

## What this repository provides

- A CLI package: `lazyload-cloud`
- A Worker export: `lazyload-cloud/worker`
- Built-in Agent Skills under `skills/`
- Benchmark scripts under `benchmarks/`

## Core features

- Indexes TypeScript, JavaScript, and Python source files
- Stores a local index at `.lazyload/index.json`
- Supports `json`, `compact`, and `markdown` output formats
- Provides query commands for:
  - symbol search
  - function / class lookup
  - related context
  - references
  - call tracing
  - type tracing
  - module dependencies
  - architecture overview
  - index statistics
- Supports file watching with automatic re-indexing
- Can scaffold Cloudflare assets and Agent Skills with `init`

## Quick start

```bash
lazyload-cloud init --yes
lazyload-cloud index
lazyload-cloud stats --format compact
lazyload-cloud query symbols handler --format compact
lazyload-cloud overview --format compact
```

## Main commands

| Command | Purpose |
| --- | --- |
| `init` | Create `lazyload.config.json`, skills, Cloudflare scaffold, and onboarding docs |
| `auth login` / `logout` / `status` | Manage stored auth/config values |
| `index` | Build the local index |
| `watch` | Rebuild on file changes |
| `stats` | Show local or remote index stats |
| `query` | Run the primary query interface |
| `overview` | Show project-level architecture summary |
| `sync` | Upload the current index to the configured remote backend |
| `status` | Show local and remote status |
| `config inspect` | Show resolved config values and their sources |
| `doctor` | Check for common setup problems |

## Query surface

The CLI exposes query helpers through the `query` command group and compatibility aliases.

### Primary query commands

- `query symbols <query>`
- `query function <name>`
- `query class <name>`
- `query related-context <name>`
- `query references <name>`
- `query calls <name>`
- `query types <name>`
- `query module-dependencies <module-path>`
- `query suggest-related <name>`

### Compatibility commands

- `list-files`
- `list-functions`
- `search-symbols`
- `get-function`
- `get-class`
- `get-related-context`
- `find-references`
- `trace-calls`
- `trace-types`
- `get-module-dependencies`
- `get-architecture-overview`
- `suggest-related`
- `sync-index`

## Local mode

Local mode does not require Cloudflare.

```bash
lazyload-cloud init --yes
lazyload-cloud index
lazyload-cloud query symbols render --format compact
```

If the local index is missing, commands fail with a clear message telling you to run `lazyload-cloud index` first.

## Configuration

Project configuration lives in `lazyload.config.json`.

Default behavior includes:

- project directories: `["."]`
- output path: `.lazyload/index.json`
- include patterns:
  - `**/*.ts`
  - `**/*.tsx`
  - `**/*.js`
  - `**/*.jsx`
  - `**/*.py`
- exclude patterns for common generated directories such as `node_modules`, `dist`, `build`, `.git`, `coverage`, `venv`, and `__pycache__`

Notable user-facing settings:

- `remote.projectId`
- `remote.preferRemote`
- `privacy.uploadSource`

When `privacy.uploadSource` is `false`, remote sync strips symbol source and documentation from the uploaded artifact.

## Auth and config resolution

Stored auth lives at:

- `~/.config/lazyload-cloud/auth.json`
- or `$XDG_CONFIG_HOME/lazyload-cloud/auth.json`

The auth file is written with restrictive permissions (`0600`).

Resolution precedence is:

1. CLI flags
2. `--env-file`
3. `process.env`
4. user auth file
5. project config
6. defaults

`.env` files are **not** auto-loaded. Use `--env-file` explicitly.

## Worker mode

Worker mode uses a deployed Cloudflare Worker as the remote API.

### Required values

- API base URL
- Worker bearer token

### Example

```bash
lazyload-cloud auth login \
  --api-base-url https://api.example.com \
  --worker-token <worker-bearer-token> \
  --cloudflare-api-token <cloudflare-api-token>
```

In Worker mode, the Worker token is the credential used for remote API requests.

## Direct D1/R2 mode

Direct mode skips the Worker and talks to Cloudflare storage directly.

### Required values

- Cloudflare account ID
- D1 database ID
- R2 bucket name
- R2 access key ID
- R2 secret access key

Optional:

- Cloudflare API token

The Cloudflare API token is used for D1 metadata reads/writes. R2 access uses the S3-compatible credentials.

### Example

```bash
lazyload-cloud auth login \
  --account-id <cloudflare-account-id> \
  --d1-database-id <d1-database-id> \
  --r2-bucket <r2-bucket-name> \
  --r2-access-key-id <r2-access-key-id> \
  --r2-secret-access-key <r2-secret-access-key> \
  --cloudflare-api-token <cloudflare-api-token>
```

### Remote mode selection

The CLI auto-selects direct mode when all five direct credentials are available. You can also force it:

```bash
lazyload-cloud sync --remote-mode direct
```

### Important direct-mode behavior

- `sync` uploads the artifact to **R2**
- D1 metadata is only used when a Cloudflare API token is configured
- Remote queries in direct mode **download the artifact from R2 and run the normal local query helpers on that artifact**

### D1 setup

If you want D1 metadata support, apply the bundled schema once:

```bash
wrangler d1 execute <DB_NAME> --file cloudflare/migrations/0001_init.sql
```

## Environment variables

### Shared

- `LAZYLOAD_PROJECT_ID`
- `LAZYLOAD_PREFER_REMOTE`
- `LAZYLOAD_UPLOAD_SOURCE`
- `LAZYLOAD_ENV_FILE`
- `LAZYLOAD_REMOTE_MODE`
- `LAZYLOAD_CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_API_TOKEN`

### Worker mode

- `LAZYLOAD_API_BASE_URL`
- `LAZYLOAD_API_TOKEN`

### Direct mode

- `LAZYLOAD_ACCOUNT_ID`
- `CLOUDFLARE_ACCOUNT_ID`
- `LAZYLOAD_D1_DATABASE_ID`
- `LAZYLOAD_R2_BUCKET`
- `LAZYLOAD_R2_ACCESS_KEY_ID`
- `LAZYLOAD_R2_SECRET_ACCESS_KEY`

## Cloudflare scaffold

`init` can generate a `cloudflare/` directory containing:

- `worker.ts`
- `wrangler.toml`
- `migrations/0001_init.sql`

The generated scaffold includes bindings/config for D1, R2, Queues, and Durable Objects.

## Agent Skills

This repository ships three skills:

- `skills/lazyload-cloud/`
- `skills/lazyload-cloud-project/`
- `skills/lazyload-cloud-sync/`

`init` copies them into `.claude/skills/`.

The generated skill scripts use `npx lazyload-cloud` by default, or `LAZYLOAD_CLI_BIN` when explicitly set.

## Benchmarks

Two benchmark scripts are included:

```bash
npm run build
npm run bench:quick -- /path/to/project
npm run bench:compare -- /path/to/project render
```

- `bench:quick` measures index/stats/overview timing
- `bench:compare` compares naive file scanning with indexed symbol search

Both scripts print JSON.
