# lazyload-cloud

Cloudflare-backed code context CLI for Agent Skills.

`lazyload-cloud` is a Node-compatible CLI built around the open Agent Skills format. It indexes local JavaScript and TypeScript projects, answers focused code-context queries, generates portable skill assets, and can sync/query through a Cloudflare Worker.

## Features

- JS/TS project indexing with compact symbol metadata
- Local queries for symbols, functions, call traces, and architecture overview
- **13 code-context commands** on the CLI surface
- Agent Skills bootstrap with `SKILL.md`, scripts, references, and examples
- Cloudflare Worker API for sync, remote queries, and status checks
- Node-first runtime with Bun-friendly development workflow

## Install

```bash
npm install -g lazyload-cloud
```

Pinned install for the current release:

```bash
npm install -g lazyload-cloud@0.1.2
```

## Devbox

This repository includes a `devbox.json` so `node`, `npm`, `gh`, and `bun` are available automatically inside `devbox shell`.

```bash
cd lazyload_cli
devbox shell
npm -v
npm install -g lazyload-cloud
```

Inside Devbox, global npm installs are redirected to a repo-local prefix under `.devbox/npm-global`, so you can use `npm install -g` without polluting the host machine.

If you also want `node` / `npm` in your normal shell outside this repository, use Devbox global packages:

```bash
devbox global add nodejs@22
source ~/.bashrc
npm -v
```

This repository does **not** install Node system-wide. The repo `devbox.json` affects only shells started with `devbox shell`.

## Quick start

```bash
lazyload-cloud init
lazyload-cloud index
lazyload-cloud query symbols handler --format compact
lazyload-cloud overview --format compact
```

## Commands

- `init` - create `lazyload.config.json`, skill assets, and Cloudflare scaffolding
- `auth login|logout|status` - manage Worker auth and Cloudflare API Token in user config
- `index` - build `.lazyload/index.json`
- `query` - search symbols, fetch a function, or trace calls
- `overview` - summarize the local or remote project index
- `sync` - upload the local index to a Cloudflare Worker
- `status` - inspect local and remote project state
- `config inspect` - show resolved config values and their sources
- `doctor` - diagnose common setup issues

### 13 compatibility commands

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

## Cloudflare deployment

`init` creates a `cloudflare/` directory with:

- `worker.ts` - re-export for the bundled Worker handler
- `wrangler.toml` - starter Worker config
- `migrations/0001_init.sql` - D1 schema

After editing bindings and secrets, deploy with Wrangler:

```bash
wrangler d1 migrations apply lazyload-cloud
wrangler deploy
```

## Agent Skills

The package now ships a small **Agent Skills pack** under `skills/`:

- `skills/lazyload-cloud/` - general query skill
- `skills/lazyload-cloud-project/` - project exploration skill
- `skills/lazyload-cloud-sync/` - auth/sync/remote workflow skill

`init` copies these into `.claude/skills/` for Claude Code as the first supported client. The layout follows the open Agent Skills folder structure and can be adapted for other skills-compatible clients.

### Managing skills with GitHub CLI

Because the repository exposes a top-level `skills/` directory, it is also compatible with the newer `gh skill` workflow described by GitHub.

Typical usage:

```bash
# Install the current pinned release from GitHub
gh skill install ozekimasaki/lazyload-cloud lazyload-cloud --pin v0.1.2 --agent claude-code
gh skill install ozekimasaki/lazyload-cloud lazyload-cloud-project --pin v0.1.2 --agent claude-code
gh skill install ozekimasaki/lazyload-cloud lazyload-cloud-sync --pin v0.1.2 --agent claude-code

# Or follow the latest release without pinning
gh skill install ozekimasaki/lazyload-cloud lazyload-cloud --agent claude-code

# Validate skills before publishing
gh skill publish
```

This makes the package useful in two modes:

- **npm package**: install `lazyload-cloud` and run `init`
- **skills repository**: install the bundled skills directly with `gh skill`

## Auth and environment variables

Secrets are stored in the user config path, not in the project:

- auth file: `~/.config/lazyload-cloud/auth.json` (or `$XDG_CONFIG_HOME/lazyload-cloud/auth.json`)
- project config: `lazyload.config.json`

Recommended auth flow:

```bash
lazyload-cloud auth login \
  --api-base-url https://api.example.com \
  --worker-token <worker-bearer-token> \
  --cloudflare-api-token <cloudflare-api-token>
lazyload-cloud auth status
```

Supported env vars:

- `LAZYLOAD_API_BASE_URL`
- `LAZYLOAD_API_TOKEN`
- `LAZYLOAD_CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_API_TOKEN`
- `LAZYLOAD_PROJECT_ID`
- `LAZYLOAD_PREFER_REMOTE`
- `LAZYLOAD_UPLOAD_SOURCE`
- `LAZYLOAD_ENV_FILE`

Resolution precedence:

1. CLI flags
2. `--env-file`
3. `process.env`
4. user config
5. project config
6. defaults

`.env` files are **not** auto-loaded. Use `--env-file path/to/file.env` when you need one-off overrides.

Credential split:

- **Worker bearer token**: used for `Authorization: Bearer ...` when talking to the deployed Worker API
- **Cloudflare API Token**: stored separately for future Cloudflare-native operations and integrations

## Publish checklist

Before publishing:

1. Update `version` in `package.json`
2. Review generated `README.md`
3. Run `npm run build`
4. Run `npm test`
5. Publish with `npm publish`
