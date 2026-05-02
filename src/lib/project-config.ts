import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ProjectConfig } from '../types.js';

const projectConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  include: z.array(z.string()).default([
    '**/*.ts',
    '**/*.tsx',
    '**/*.js',
    '**/*.jsx',
  ]),
  exclude: z.array(z.string()).default([
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.git/**',
    '**/.turbo/**',
    '**/.next/**',
    '**/coverage/**',
    '**/*.min.js',
    '**/*.map',
    '**/.env*',
  ]),
  outputPath: z.string().default('.lazyload/index.json'),
  remote: z.object({
    projectId: z.string(),
    apiBaseUrl: z.string().url().optional(),
    preferRemote: z.boolean().default(false),
  }),
  privacy: z
    .object({
      uploadSource: z.boolean().default(false),
      redactPatterns: z.array(z.string()).default([
        '**/.env*',
        '**/*secret*',
        '**/*credentials*',
        '**/*.pem',
        '**/*.key',
      ]),
    })
    .default({}),
  skill: z
    .object({
      name: z.string().default('lazyload-cloud'),
      directory: z.string().default('.claude/skills/lazyload-cloud'),
    })
    .default({}),
  cloudflare: z
    .object({
      directory: z.string().default('cloudflare'),
    })
    .default({}),
});

export const PROJECT_CONFIG_FILE = 'lazyload.config.json';

export function slugifyProjectName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'lazyload-project';
}

export function createDefaultProjectConfig(projectRoot: string): ProjectConfig {
  const projectId = slugifyProjectName(path.basename(projectRoot));
  return projectConfigSchema.parse({
    remote: {
      projectId,
      preferRemote: false,
    },
  });
}

export function getProjectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_CONFIG_FILE);
}

export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfig> {
  const configPath = getProjectConfigPath(projectRoot);
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    return projectConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createDefaultProjectConfig(projectRoot);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${PROJECT_CONFIG_FILE}`);
    }
    throw error;
  }
}

export async function saveProjectConfig(projectRoot: string, config: ProjectConfig): Promise<string> {
  const configPath = getProjectConfigPath(projectRoot);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return configPath;
}

export async function ensureProjectConfig(projectRoot: string): Promise<ProjectConfig> {
  const config = await loadProjectConfig(projectRoot);
  await saveProjectConfig(projectRoot, config);
  return config;
}
