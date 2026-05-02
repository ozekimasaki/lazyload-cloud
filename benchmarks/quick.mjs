import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = path.join(repoRoot, 'dist', 'bin.js');
const targetDir = path.resolve(process.argv[2] ?? process.cwd());

async function ensureBuilt() {
  await fs.access(cliEntry);
}

async function runCli(args, cwd) {
  const start = performance.now();
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, ...args], {
    cwd,
    env: process.env,
  });
  return {
    stdout,
    durationMs: Math.round((performance.now() - start) * 100) / 100,
  };
}

await ensureBuilt();

const indexResult = await runCli(['index'], targetDir);
const statsResult = await runCli(['stats', '--format', 'json'], targetDir);
const overviewResult = await runCli(['overview', '--format', 'json'], targetDir);

const stats = JSON.parse(statsResult.stdout);
const overview = JSON.parse(overviewResult.stdout);
const summary = {
  targetDir,
  indexMs: indexResult.durationMs,
  statsMs: statsResult.durationMs,
  overviewMs: overviewResult.durationMs,
  totalFiles: stats.totalFiles,
  totalSymbols: stats.totalSymbols,
  generatedAt: stats.generatedAt,
  topFile: overview.topFiles?.[0]?.path ?? null,
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
