import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { getUserConfigPath, loadUserConfig } from '../src/lib/user-config.js';

const originalEnv = { ...process.env };
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

describe('auth command group', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
    await Promise.all(tempDirs.splice(0).map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })));
  });

  it('stores, reports, and clears auth config through auth commands', async () => {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazyload-cloud-auth-project-'));
    const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lazyload-cloud-auth-config-'));
    tempDirs.push(workingDir, configRoot);
    process.chdir(workingDir);
    process.env.XDG_CONFIG_HOME = configRoot;

    await captureStdout(() =>
      runCli([
        'node',
        'lazyload-cloud',
        'auth',
        'login',
        '--api-base-url',
        'https://api.example.com',
        '--worker-token',
        'worker-secret-token',
        '--cloudflare-api-token',
        'cloudflare-secret-token',
      ])
    );

    const stored = await loadUserConfig();
    expect(stored.apiBaseUrl).toBe('https://api.example.com');
    expect(stored.workerApiToken).toBe('worker-secret-token');
    expect(stored.cloudflareApiToken).toBe('cloudflare-secret-token');

    const statusOutput = await captureStdout(() => runCli(['node', 'lazyload-cloud', 'auth', 'status']));
    const status = JSON.parse(statusOutput) as {
      authFilePath: string;
      storedWorkerTokenPresent: boolean;
      storedCloudflareApiTokenPresent: boolean;
      resolvedApiBaseUrlSource: string;
      resolvedWorkerApiTokenSource: string;
      resolvedCloudflareApiTokenSource: string;
      resolvedWorkerApiTokenMasked: string;
      resolvedCloudflareApiTokenMasked: string;
    };

    expect(status.authFilePath).toBe(getUserConfigPath());
    expect(status.storedWorkerTokenPresent).toBe(true);
    expect(status.storedCloudflareApiTokenPresent).toBe(true);
    expect(status.resolvedApiBaseUrlSource).toBe('user-config');
    expect(status.resolvedWorkerApiTokenSource).toBe('user-config');
    expect(status.resolvedCloudflareApiTokenSource).toBe('user-config');
    expect(status.resolvedWorkerApiTokenMasked.endsWith('oken')).toBe(true);
    expect(status.resolvedCloudflareApiTokenMasked.endsWith('oken')).toBe(true);

    await captureStdout(() => runCli(['node', 'lazyload-cloud', 'auth', 'logout']));
    await expect(fs.access(getUserConfigPath())).rejects.toThrow();
  });
});
