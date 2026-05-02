import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

const originalCwd = process.cwd();

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let output = '';
  const originalWrite = process.stdout.write.bind(process.stdout);

  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }

  return output;
}

describe('CLI parity commands', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    process.chdir(originalCwd);
    await Promise.all(tempDirs.splice(0).map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })));
  });

  it('supports init --yes, stats, and watch --once', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lazyload-cloud-cli-parity-'));
    tempDirs.push(root);
    process.chdir(root);

    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'src', 'app.ts'),
      `export function hello(name: string) {
  return name.toUpperCase();
}
`,
      'utf8'
    );
    await fs.writeFile(
      path.join(root, 'src', 'text_tools.py'),
      `def normalize_text(value):
    return value.strip().lower()
`,
      'utf8'
    );

    const initOutput = JSON.parse(await captureStdout(() => runCli(['node', 'lazyload-cloud', 'init', '--yes']))) as {
      configPath: string;
      onboardingFiles: string[];
      outputPath: string;
    };
    expect(initOutput.configPath).toBe(path.join(root, 'lazyload.config.json'));
    expect(initOutput.onboardingFiles).toContain(path.join(root, 'CLAUDE.md'));
    expect(initOutput.onboardingFiles).toContain(path.join(root, 'AGENTS.md'));
    expect(initOutput.outputPath).toBe(path.join(root, '.lazyload', 'index.json'));

    const stats = JSON.parse(
      await captureStdout(() => runCli(['node', 'lazyload-cloud', 'stats', '--format', 'json']))
    ) as {
      totalFiles: number;
      byLanguage: { python: { files: number }; typescript: { files: number } };
    };
    expect(stats.totalFiles).toBe(3);
    expect(stats.byLanguage.typescript.files).toBe(2);
    expect(stats.byLanguage.python.files).toBe(1);

    const watchOutput = JSON.parse(
      await captureStdout(() => runCli(['node', 'lazyload-cloud', 'watch', '--once']))
    ) as { mode: string; files: number; symbols: number };
    expect(watchOutput.mode).toBe('once');
    expect(watchOutput.files).toBe(3);
    expect(watchOutput.symbols).toBeGreaterThanOrEqual(2);
  });
});
