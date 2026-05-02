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

  async function makeTempEnv(): Promise<{ workingDir: string; configRoot: string }> {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazyload-cloud-auth-project-'));
    const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lazyload-cloud-auth-config-'));
    tempDirs.push(workingDir, configRoot);
    process.chdir(workingDir);
    process.env.XDG_CONFIG_HOME = configRoot;
    return { workingDir, configRoot };
  }

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
    const authStats = await fs.stat(getUserConfigPath());
    expect(authStats.mode & 0o777).toBe(0o600);

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

  it('rewriting auth config tightens file permissions back to 0600', async () => {
    await makeTempEnv();

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
      ])
    );

    await fs.chmod(getUserConfigPath(), 0o644);

    await captureStdout(() =>
      runCli([
        'node',
        'lazyload-cloud',
        'auth',
        'login',
        '--api-base-url',
        'https://api.example.com',
        '--worker-token',
        'worker-secret-token-2',
      ])
    );

    const stats = await fs.stat(getUserConfigPath());
    expect(stats.mode & 0o777).toBe(0o600);
  });

  // -------------------------------------------------------------------------
  // Direct mode: auth login stores D1/R2 credentials
  // -------------------------------------------------------------------------

  it('stores direct-mode credentials and reports mode=direct', async () => {
    await makeTempEnv();

    const loginOutput = JSON.parse(
      await captureStdout(() =>
        runCli([
          'node', 'lazyload-cloud', 'auth', 'login',
          '--account-id', 'acct-456',
          '--d1-database-id', 'db-xyz',
          '--r2-bucket', 'my-bucket',
          '--r2-access-key-id', 'r2-key-id',
          '--r2-secret-access-key', 'r2-secret-key',
        ])
      )
    ) as {
      saved: string;
      mode: string;
      accountIdSet: boolean;
      d1DatabaseIdSet: boolean;
      r2BucketSet: boolean;
      r2AccessKeyIdSet: boolean;
      r2SecretAccessKeySet: boolean;
    };

    expect(loginOutput.mode).toBe('direct');
    expect(loginOutput.accountIdSet).toBe(true);
    expect(loginOutput.d1DatabaseIdSet).toBe(true);
    expect(loginOutput.r2BucketSet).toBe(true);
    expect(loginOutput.r2AccessKeyIdSet).toBe(true);
    expect(loginOutput.r2SecretAccessKeySet).toBe(true);

    const stored = await loadUserConfig();
    expect(stored.accountId).toBe('acct-456');
    expect(stored.d1DatabaseId).toBe('db-xyz');
    expect(stored.r2Bucket).toBe('my-bucket');
    expect(stored.r2AccessKeyId).toBe('r2-key-id');
    expect(stored.r2SecretAccessKey).toBe('r2-secret-key');
  });

  it('loads direct-mode credentials from env-file during auth login', async () => {
    const { workingDir } = await makeTempEnv();
    const envFilePath = path.join(workingDir, '.direct.env');
    await fs.writeFile(
      envFilePath,
      [
        'LAZYLOAD_ACCOUNT_ID=acct-env',
        'LAZYLOAD_D1_DATABASE_ID=db-env',
        'LAZYLOAD_R2_BUCKET=bucket-env',
        'LAZYLOAD_R2_ACCESS_KEY_ID=key-env',
        'LAZYLOAD_R2_SECRET_ACCESS_KEY=secret-env',
      ].join('\n'),
      'utf8'
    );

    const loginOutput = JSON.parse(
      await captureStdout(() => runCli(['node', 'lazyload-cloud', 'auth', 'login', '--env-file', envFilePath]))
    ) as { mode: string; accountIdSet: boolean; d1DatabaseIdSet: boolean; r2BucketSet: boolean };

    expect(loginOutput.mode).toBe('direct');
    expect(loginOutput.accountIdSet).toBe(true);
    expect(loginOutput.d1DatabaseIdSet).toBe(true);
    expect(loginOutput.r2BucketSet).toBe(true);

    const stored = await loadUserConfig();
    expect(stored.accountId).toBe('acct-env');
    expect(stored.d1DatabaseId).toBe('db-env');
    expect(stored.r2Bucket).toBe('bucket-env');
    expect(stored.r2AccessKeyId).toBe('key-env');
    expect(stored.r2SecretAccessKey).toBe('secret-env');
  });

  it('auth login --direct mode does not require --api-base-url', async () => {
    await makeTempEnv();

    // Should not throw even though no --api-base-url is provided
    await expect(
      captureStdout(() =>
        runCli([
          'node', 'lazyload-cloud', 'auth', 'login',
          '--account-id', 'acct-789',
          '--d1-database-id', 'db-789',
          '--r2-bucket', 'bucket-789',
          '--r2-access-key-id', 'key-789',
          '--r2-secret-access-key', 'secret-789',
        ])
      )
    ).resolves.not.toThrow();
  });

  it('auth login direct mode works alongside an optional cloudflare-api-token', async () => {
    await makeTempEnv();

    await captureStdout(() =>
      runCli([
        'node', 'lazyload-cloud', 'auth', 'login',
        '--account-id', 'acct-xyz',
        '--d1-database-id', 'db-xyz',
        '--r2-bucket', 'bkt-xyz',
        '--r2-access-key-id', 'k-xyz',
        '--r2-secret-access-key', 's-xyz',
        '--cloudflare-api-token', 'cf-tok-xyz',
      ])
    );

    const stored = await loadUserConfig();
    expect(stored.cloudflareApiToken).toBe('cf-tok-xyz');
    expect(stored.accountId).toBe('acct-xyz');
  });

  it('auth status shows stored direct credential presence', async () => {
    await makeTempEnv();

    await captureStdout(() =>
      runCli([
        'node', 'lazyload-cloud', 'auth', 'login',
        '--account-id', 'acct-status',
        '--d1-database-id', 'db-status',
        '--r2-bucket', 'bkt-status',
        '--r2-access-key-id', 'k-status',
        '--r2-secret-access-key', 's-status',
      ])
    );

    const statusOutput = JSON.parse(
      await captureStdout(() => runCli(['node', 'lazyload-cloud', 'auth', 'status']))
    ) as {
      storedAccountIdPresent: boolean;
      storedD1DatabaseIdPresent: boolean;
      storedR2BucketPresent: boolean;
      storedR2AccessKeyIdPresent: boolean;
      storedR2SecretAccessKeyPresent: boolean;
      resolvedAccountIdPresent: boolean;
      resolvedD1DatabaseIdPresent: boolean;
      resolvedR2BucketPresent: boolean;
    };

    expect(statusOutput.storedAccountIdPresent).toBe(true);
    expect(statusOutput.storedD1DatabaseIdPresent).toBe(true);
    expect(statusOutput.storedR2BucketPresent).toBe(true);
    expect(statusOutput.storedR2AccessKeyIdPresent).toBe(true);
    expect(statusOutput.storedR2SecretAccessKeyPresent).toBe(true);
    expect(statusOutput.resolvedAccountIdPresent).toBe(true);
    expect(statusOutput.resolvedD1DatabaseIdPresent).toBe(true);
    expect(statusOutput.resolvedR2BucketPresent).toBe(true);
  });

  it('auth login partial update preserves previously stored direct credentials', async () => {
    await makeTempEnv();

    // First login: set all direct creds
    await captureStdout(() =>
      runCli([
        'node', 'lazyload-cloud', 'auth', 'login',
        '--account-id', 'acct-orig',
        '--d1-database-id', 'db-orig',
        '--r2-bucket', 'bkt-orig',
        '--r2-access-key-id', 'k-orig',
        '--r2-secret-access-key', 's-orig',
      ])
    );

    // Second login: only update r2-bucket
    await captureStdout(() =>
      runCli([
        'node', 'lazyload-cloud', 'auth', 'login',
        '--account-id', 'acct-orig',
        '--d1-database-id', 'db-orig',
        '--r2-bucket', 'bkt-updated',
        '--r2-access-key-id', 'k-orig',
        '--r2-secret-access-key', 's-orig',
      ])
    );

    const stored = await loadUserConfig();
    expect(stored.r2Bucket).toBe('bkt-updated');
    // Other fields preserved
    expect(stored.accountId).toBe('acct-orig');
    expect(stored.r2AccessKeyId).toBe('k-orig');
  });

  it('auth login without direct creds or api-base-url throws', async () => {
    await makeTempEnv();

    await expect(
      captureStdout(() =>
        runCli([
          'node', 'lazyload-cloud', 'auth', 'login',
          '--worker-token', 'tok',
          // no --api-base-url, no direct creds
        ])
      )
    ).rejects.toThrow(/API base URL/);
  });

  it('worker-mode auth login rejects configs without a worker token', async () => {
    await makeTempEnv();

    await expect(
      captureStdout(() =>
        runCli([
          'node',
          'lazyload-cloud',
          'auth',
          'login',
          '--api-base-url',
          'https://api.example.com',
          '--cloudflare-api-token',
          'cloudflare-secret-token',
        ])
      )
    ).rejects.toThrow(/worker credential resolved/i);
  });
});
