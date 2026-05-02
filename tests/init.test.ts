import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProjectConfig, saveProjectConfig } from '../src/lib/project-config.js';
import { createCloudflareScaffold, createSkillAssets, updateGitignore } from '../src/lib/skills.js';

async function makeTempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lazyload-cloud-init-'));
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

describe('init scaffolding', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })));
  });

  it('creates skill assets and cloudflare scaffold', async () => {
    const root = await makeTempProject();
    tempDirs.push(root);
    const config = createDefaultProjectConfig(root);
    await saveProjectConfig(root, config);

    await updateGitignore(root);
    const skillFiles = await createSkillAssets(root, config);
    const cloudflareFiles = await createCloudflareScaffold(root, config);

    expect(skillFiles).not.toHaveLength(0);
    expect(cloudflareFiles).not.toHaveLength(0);

    const skillMarkdown = await readText(path.join(root, config.skill.directory, 'SKILL.md'));
    expect(skillMarkdown).toContain('name: lazyload-cloud');
    expect(skillMarkdown).toContain('query-symbols.sh');

    const projectSkillMarkdown = await readText(path.join(root, '.claude/skills/lazyload-cloud-project/SKILL.md'));
    expect(projectSkillMarkdown).toContain('list-files');

    const syncSkillMarkdown = await readText(path.join(root, '.claude/skills/lazyload-cloud-sync/SKILL.md'));
    expect(syncSkillMarkdown).toContain('sync-index');

    const wranglerToml = await readText(path.join(root, config.cloudflare.directory, 'wrangler.toml'));
    expect(wranglerToml).toContain('[[d1_databases]]');
    expect(wranglerToml).toContain('[[queues.producers]]');
    expect(wranglerToml).toContain('[durable_objects]');

    const gitignore = await readText(path.join(root, '.gitignore'));
    expect(gitignore).toContain('.lazyload/');
  });
});
