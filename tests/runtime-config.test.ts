import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveProjectConfig } from '../src/lib/project-config.js';
import { resolveRuntimeConfig } from '../src/lib/runtime-config.js';
import { saveUserConfig } from '../src/lib/user-config.js';
import type { ProjectConfig } from '../src/types.js';

const originalEnv = { ...process.env };

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('runtime config resolution', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    process.env = { ...originalEnv };
    await Promise.all(tempDirs.splice(0).map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })));
  });

  async function makeProjectRoot(): Promise<string> {
    const projectRoot = await createTempDir('lazyload-cloud-runtime-project-');
    tempDirs.push(projectRoot);
    const projectConfig: ProjectConfig = {
      schemaVersion: 2,
      directories: ['.'],
      include: ['**/*.ts'],
      exclude: ['**/node_modules/**'],
      outputPath: '.lazyload/index.json',
      remote: {
        projectId: 'project-id',
        apiBaseUrl: undefined,
        preferRemote: false,
      },
      privacy: {
        uploadSource: false,
        redactPatterns: [],
      },
      skill: { name: 'lazyload-cloud', directory: '.claude/skills/lazyload-cloud' },
      cloudflare: { directory: 'cloudflare' },
    };
    await saveProjectConfig(projectRoot, projectConfig);
    return projectRoot;
  }

  it('resolves precedence across cli, env-file, env, user config, and project config', async () => {
    const projectRoot = await createTempDir('lazyload-cloud-runtime-project-');
    const configRoot = await createTempDir('lazyload-cloud-runtime-config-');
    tempDirs.push(projectRoot, configRoot);

    process.env.XDG_CONFIG_HOME = configRoot;
    process.env.LAZYLOAD_API_TOKEN = 'env-token';
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare-env-token';
    process.env.LAZYLOAD_UPLOAD_SOURCE = 'true';

    const projectConfig: ProjectConfig = {
      schemaVersion: 1,
      include: ['**/*.ts'],
      exclude: ['**/node_modules/**'],
      outputPath: '.lazyload/index.json',
      remote: {
        projectId: 'project-id',
        apiBaseUrl: 'https://project.example.com',
        preferRemote: false,
      },
      privacy: {
        uploadSource: false,
        redactPatterns: ['**/.env*'],
      },
      skill: {
        name: 'lazyload-cloud',
        directory: '.claude/skills/lazyload-cloud',
      },
      cloudflare: {
        directory: 'cloudflare',
      },
    };
    await saveProjectConfig(projectRoot, projectConfig);

    await saveUserConfig({
      schemaVersion: 1,
      apiBaseUrl: 'https://user.example.com',
      workerApiToken: 'user-token',
      cloudflareApiToken: 'user-cloudflare-token',
    });

    const envFilePath = path.join(projectRoot, '.custom.env');
    await fs.writeFile(
      envFilePath,
      [
        'LAZYLOAD_API_BASE_URL=https://env-file.example.com',
        'LAZYLOAD_API_TOKEN=env-file-token',
        'LAZYLOAD_CLOUDFLARE_API_TOKEN=env-file-cloudflare-token',
        'LAZYLOAD_PROJECT_ID=env-file-project',
        'LAZYLOAD_PREFER_REMOTE=true',
      ].join('\n'),
      'utf8'
    );

    const resolved = await resolveRuntimeConfig(projectRoot, {
      envFile: envFilePath,
      apiBaseUrl: 'https://cli.example.com',
      projectId: 'cli-project',
    });

    expect(resolved.projectConfig.remote.projectId).toBe('cli-project');
    expect(resolved.projectConfig.remote.apiBaseUrl).toBe('https://cli.example.com');
    expect(resolved.userConfig.workerApiToken).toBe('env-file-token');
    expect(resolved.userConfig.cloudflareApiToken).toBe('env-file-cloudflare-token');
    expect(resolved.projectConfig.remote.preferRemote).toBe(true);
    expect(resolved.projectConfig.privacy.uploadSource).toBe(true);

    expect(resolved.resolved.projectId.source).toBe('cli');
    expect(resolved.resolved.apiBaseUrl.source).toBe('cli');
    expect(resolved.resolved.workerApiToken.source).toBe('env-file');
    expect(resolved.resolved.cloudflareApiToken.source).toBe('env-file');
    expect(resolved.resolved.preferRemote.source).toBe('env-file');
    expect(resolved.resolved.uploadSource.source).toBe('env');
  });

  // -------------------------------------------------------------------------
  // Direct mode: remoteMode resolution
  // -------------------------------------------------------------------------

  it('auto-detects direct mode when all five R2/D1 credentials are present', async () => {
    const projectRoot = await makeProjectRoot();
    const configRoot = await createTempDir('lazyload-cloud-runtime-config-');
    tempDirs.push(configRoot);
    process.env.XDG_CONFIG_HOME = configRoot;

    process.env.LAZYLOAD_ACCOUNT_ID = 'acct-123';
    process.env.LAZYLOAD_D1_DATABASE_ID = 'db-abc';
    process.env.LAZYLOAD_R2_BUCKET = 'my-bucket';
    process.env.LAZYLOAD_R2_ACCESS_KEY_ID = 'r2-key';
    process.env.LAZYLOAD_R2_SECRET_ACCESS_KEY = 'r2-secret';

    const resolved = await resolveRuntimeConfig(projectRoot);

    expect(resolved.resolved.remoteMode.value).toBe('direct');
    expect(resolved.resolved.remoteMode.source).toBe('default');
    expect(resolved.resolved.accountId.value).toBe('acct-123');
    expect(resolved.resolved.d1DatabaseId.value).toBe('db-abc');
    expect(resolved.resolved.r2Bucket.value).toBe('my-bucket');
    expect(resolved.resolved.r2AccessKeyId.value).toBe('r2-key');
    expect(resolved.resolved.r2SecretAccessKey.value).toBe('r2-secret');
  });

  it('stays in worker mode when not all five R2/D1 credentials are present', async () => {
    const projectRoot = await makeProjectRoot();
    const configRoot = await createTempDir('lazyload-cloud-runtime-config-');
    tempDirs.push(configRoot);
    process.env.XDG_CONFIG_HOME = configRoot;

    // Only partial credentials – missing r2SecretAccessKey
    process.env.LAZYLOAD_ACCOUNT_ID = 'acct-123';
    process.env.LAZYLOAD_D1_DATABASE_ID = 'db-abc';
    process.env.LAZYLOAD_R2_BUCKET = 'my-bucket';
    process.env.LAZYLOAD_R2_ACCESS_KEY_ID = 'r2-key';

    const resolved = await resolveRuntimeConfig(projectRoot);

    expect(resolved.resolved.remoteMode.value).toBe('worker');
  });

  it('respects LAZYLOAD_REMOTE_MODE=direct env var override', async () => {
    const projectRoot = await makeProjectRoot();
    const configRoot = await createTempDir('lazyload-cloud-runtime-config-');
    tempDirs.push(configRoot);
    process.env.XDG_CONFIG_HOME = configRoot;
    process.env.LAZYLOAD_REMOTE_MODE = 'direct';

    const resolved = await resolveRuntimeConfig(projectRoot);

    expect(resolved.resolved.remoteMode.value).toBe('direct');
    expect(resolved.resolved.remoteMode.source).toBe('env');
  });

  it('respects LAZYLOAD_REMOTE_MODE=worker env var even when all direct creds are present', async () => {
    const projectRoot = await makeProjectRoot();
    const configRoot = await createTempDir('lazyload-cloud-runtime-config-');
    tempDirs.push(configRoot);
    process.env.XDG_CONFIG_HOME = configRoot;

    process.env.LAZYLOAD_REMOTE_MODE = 'worker';
    process.env.LAZYLOAD_ACCOUNT_ID = 'acct-123';
    process.env.LAZYLOAD_D1_DATABASE_ID = 'db-abc';
    process.env.LAZYLOAD_R2_BUCKET = 'my-bucket';
    process.env.LAZYLOAD_R2_ACCESS_KEY_ID = 'r2-key';
    process.env.LAZYLOAD_R2_SECRET_ACCESS_KEY = 'r2-secret';

    const resolved = await resolveRuntimeConfig(projectRoot);

    expect(resolved.resolved.remoteMode.value).toBe('worker');
    expect(resolved.resolved.remoteMode.source).toBe('env');
  });

  it('respects --remote-mode cli override for direct mode', async () => {
    const projectRoot = await makeProjectRoot();
    const configRoot = await createTempDir('lazyload-cloud-runtime-config-');
    tempDirs.push(configRoot);
    process.env.XDG_CONFIG_HOME = configRoot;

    const resolved = await resolveRuntimeConfig(projectRoot, { remoteMode: 'direct' });

    expect(resolved.resolved.remoteMode.value).toBe('direct');
    expect(resolved.resolved.remoteMode.source).toBe('cli');
  });

  it('resolves direct credentials from user config', async () => {
    const projectRoot = await makeProjectRoot();
    const configRoot = await createTempDir('lazyload-cloud-runtime-config-');
    tempDirs.push(configRoot);
    process.env.XDG_CONFIG_HOME = configRoot;

    await saveUserConfig({
      schemaVersion: 1,
      accountId: 'user-acct',
      d1DatabaseId: 'user-db',
      r2Bucket: 'user-bucket',
      r2AccessKeyId: 'user-key',
      r2SecretAccessKey: 'user-secret',
    });

    const resolved = await resolveRuntimeConfig(projectRoot);

    expect(resolved.resolved.remoteMode.value).toBe('direct');
    expect(resolved.resolved.accountId.value).toBe('user-acct');
    expect(resolved.resolved.accountId.source).toBe('user-config');
    expect(resolved.resolved.r2SecretAccessKey.value).toBe('user-secret');
    expect(resolved.resolved.r2SecretAccessKey.source).toBe('user-config');
  });

  it('resolves CLOUDFLARE_ACCOUNT_ID as alias for LAZYLOAD_ACCOUNT_ID', async () => {
    const projectRoot = await makeProjectRoot();
    const configRoot = await createTempDir('lazyload-cloud-runtime-config-');
    tempDirs.push(configRoot);
    process.env.XDG_CONFIG_HOME = configRoot;
    process.env.CLOUDFLARE_ACCOUNT_ID = 'cf-acct';

    const resolved = await resolveRuntimeConfig(projectRoot);

    expect(resolved.resolved.accountId.value).toBe('cf-acct');
    expect(resolved.resolved.accountId.source).toBe('env');
  });

  it('env-file direct credentials override user config', async () => {
    const projectRoot = await makeProjectRoot();
    const configRoot = await createTempDir('lazyload-cloud-runtime-config-');
    tempDirs.push(configRoot);
    process.env.XDG_CONFIG_HOME = configRoot;

    await saveUserConfig({
      schemaVersion: 1,
      accountId: 'user-acct',
      d1DatabaseId: 'user-db',
      r2Bucket: 'user-bucket',
      r2AccessKeyId: 'user-key',
      r2SecretAccessKey: 'user-secret',
    });

    const envFilePath = path.join(projectRoot, 'direct.env');
    await fs.writeFile(
      envFilePath,
      [
        'LAZYLOAD_ACCOUNT_ID=envfile-acct',
        'LAZYLOAD_D1_DATABASE_ID=envfile-db',
        'LAZYLOAD_R2_BUCKET=envfile-bucket',
        'LAZYLOAD_R2_ACCESS_KEY_ID=envfile-key',
        'LAZYLOAD_R2_SECRET_ACCESS_KEY=envfile-secret',
      ].join('\n'),
      'utf8'
    );

    const resolved = await resolveRuntimeConfig(projectRoot, { envFile: envFilePath });

    expect(resolved.resolved.accountId.value).toBe('envfile-acct');
    expect(resolved.resolved.accountId.source).toBe('env-file');
    expect(resolved.resolved.remoteMode.value).toBe('direct');
  });
});
