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
const query = process.argv[3] ?? 'handler';
const supportedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.py']);

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

async function collectSourceFiles(rootDir) {
  const collected = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (['node_modules', 'dist', '.git', '.lazyload', 'coverage', '__pycache__'].includes(entry.name)) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (supportedExtensions.has(path.extname(entry.name))) {
        collected.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return collected.sort();
}

await ensureBuilt();

const directStart = performance.now();
const files = await collectSourceFiles(targetDir);
const directMatches = [];
for (const filePath of files) {
  const content = await fs.readFile(filePath, 'utf8');
  if (content.toLowerCase().includes(query.toLowerCase())) {
    directMatches.push(path.relative(targetDir, filePath).replace(/\\/g, '/'));
  }
}
const directSearchMs = Math.round((performance.now() - directStart) * 100) / 100;

await runCli(['index'], targetDir);
const indexedResult = await runCli(['search-symbols', query, '--format', 'json'], targetDir);
const indexedMatches = JSON.parse(indexedResult.stdout);

const summary = {
  targetDir,
  query,
  filesScanned: files.length,
  directSearchMs,
  directMatchCount: directMatches.length,
  directMatches,
  indexedSearchMs: indexedResult.durationMs,
  indexedMatchCount: indexedMatches.length,
  indexedTopResults: indexedMatches.slice(0, 5).map((entry) => ({
    symbol: entry.symbol.qualifiedName,
    filePath: entry.symbol.filePath,
    score: entry.score,
  })),
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
