import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '../types.js';

function ensureTrailingNewline(input: string): string {
  return input.endsWith('\n') ? input : `${input}\n`;
}

function renderSkillMarkdown(config: ProjectConfig): string {
  return ensureTrailingNewline(`---
name: ${config.skill.name}
description: Query compact code context for this project with lazyload-cloud. Use this skill when you need targeted symbol search, function source, call traces, or a quick architecture overview without reading many files manually.
---

Use this skill to fetch compact code context through the \`lazyload-cloud\` CLI.

Recommended workflow:

1. Run \`${'${CLAUDE_SKILL_DIR}'}/scripts/overview.sh\` when you need a structural overview.
2. Run \`${'${CLAUDE_SKILL_DIR}'}/scripts/query-symbols.sh <query>\` to find likely symbols.
3. Run \`${'${CLAUDE_SKILL_DIR}'}/scripts/get-function.sh <symbol>\` to inspect one function or method.
4. Run \`${'${CLAUDE_SKILL_DIR}'}/scripts/trace-calls.sh <symbol>\` to inspect the local call graph.

Notes:

- These scripts default to local project queries.
- Set \`LAZYLOAD_CLI_BIN\` if you want to point at a specific executable path instead of \`npx lazyload-cloud\`.
- The generated layout follows the Agent Skills folder format and can be adapted for other skills-compatible clients.

If remote sync is configured for the project, use \`lazyload-cloud sync\` before relying on remote results.
`);
}

function renderScript(command: string): string {
  return ensureTrailingNewline(`#!/usr/bin/env bash
set -euo pipefail

if [[ -n "\${LAZYLOAD_CLI_BIN:-}" ]]; then
  "\${LAZYLOAD_CLI_BIN}" ${command} "$@" --format compact
else
  npx lazyload-cloud ${command} "$@" --format compact
fi
`);
}

function renderOverviewScript(): string {
  return ensureTrailingNewline(`#!/usr/bin/env bash
set -euo pipefail

if [[ -n "\${LAZYLOAD_CLI_BIN:-}" ]]; then
  "\${LAZYLOAD_CLI_BIN}" overview --format compact "$@"
else
  npx lazyload-cloud overview --format compact "$@"
fi
`);
}

function renderReference(): string {
  return ensureTrailingNewline(`# Workflow reference

- Run \`lazyload-cloud index\` after meaningful code changes.
- Run \`lazyload-cloud sync\` if the project is configured to use a Cloudflare Worker.
- Prefer \`query symbols\` first, then \`query function\`, and only then read whole files.
- The CLI output is intentionally compact for agent use.
`);
}

function renderExample(): string {
  return ensureTrailingNewline(`score\tkind\tname\tfile\tline\tsignature
100\tfunction\thandleRequest\tsrc/server.ts\t12\texport async function handleRequest(request: Request): Promise<Response> {
`);
}

export async function updateGitignore(projectRoot: string): Promise<void> {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  let current = '';
  try {
    current = await fs.readFile(gitignorePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (!current.includes('.lazyload/')) {
    current = `${current.trimEnd()}\n\n# lazyload-cloud\n.lazyload/\n`;
  }

  await fs.writeFile(gitignorePath, ensureTrailingNewline(current.trimStart()), 'utf8');
}

export async function createSkillAssets(projectRoot: string, config: ProjectConfig): Promise<string[]> {
  const destinationRoot = path.join(projectRoot, path.dirname(config.skill.directory));
  const sourceRoot = fileURLToPath(new URL('../../skills/', import.meta.url));
  await fs.mkdir(destinationRoot, { recursive: true });

  const created: string[] = [];

  async function copyDir(sourceDir: string, targetDir: string): Promise<void> {
    await fs.mkdir(targetDir, { recursive: true });
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);

      if (entry.isDirectory()) {
        await copyDir(sourcePath, targetPath);
        continue;
      }

      const content = await fs.readFile(sourcePath, 'utf8');
      const mode = sourcePath.endsWith('.sh') ? 0o755 : 0o644;
      await fs.writeFile(targetPath, content, { encoding: 'utf8', mode });
      created.push(targetPath);
    }
  }

  const sourceEntries = await fs.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of sourceEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    await copyDir(path.join(sourceRoot, entry.name), path.join(destinationRoot, entry.name));
  }

  return created.sort();
}

function renderWranglerToml(config: ProjectConfig): string {
  return ensureTrailingNewline(`name = "${config.skill.name}-worker"
main = "cloudflare/worker.ts"
compatibility_date = "2025-01-01"

[[d1_databases]]
binding = "DB"
database_name = "lazyload-cloud"
database_id = "replace-me"

[[r2_buckets]]
binding = "INDEX_BUCKET"
bucket_name = "lazyload-cloud-indexes"
`);
}

function renderCloudflareReadme(): string {
  return ensureTrailingNewline(`# Cloudflare worker scaffold

1. Edit \`wrangler.toml\` with your real D1 database ID and R2 bucket name.
2. Set the write token:

\`\`\`bash
wrangler secret put API_TOKEN
\`\`\`

3. Apply D1 migrations:

\`\`\`bash
wrangler d1 migrations apply lazyload-cloud
\`\`\`

4. Deploy:

\`\`\`bash
wrangler deploy
\`\`\`
`);
}

export async function createCloudflareScaffold(projectRoot: string, config: ProjectConfig): Promise<string[]> {
  const cloudflareDir = path.join(projectRoot, config.cloudflare.directory);
  const migrationsDir = path.join(cloudflareDir, 'migrations');
  await fs.mkdir(migrationsDir, { recursive: true });

  const files = [
    {
      path: path.join(cloudflareDir, 'worker.ts'),
      content: ensureTrailingNewline(`export { default } from 'lazyload-cloud/worker';`),
    },
    {
      path: path.join(cloudflareDir, 'wrangler.toml'),
      content: renderWranglerToml(config),
    },
    {
      path: path.join(migrationsDir, '0001_init.sql'),
      content: ensureTrailingNewline(`CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  symbol_count INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  schema_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_snapshots (
  project_id TEXT NOT NULL,
  version TEXT NOT NULL,
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, version)
);`),
    },
    {
      path: path.join(cloudflareDir, 'README.md'),
      content: renderCloudflareReadme(),
    },
  ];

  for (const file of files) {
    await fs.writeFile(file.path, file.content, 'utf8');
  }

  return files.map((file) => file.path);
}
