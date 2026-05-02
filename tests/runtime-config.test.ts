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
});
