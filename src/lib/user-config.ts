import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { UserConfig } from '../types.js';

const userConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  apiBaseUrl: z.string().url().optional(),
  apiToken: z.string().min(1).optional(),
  workerApiToken: z.string().min(1).optional(),
  cloudflareApiToken: z.string().min(1).optional(),
});

export function getUserConfigPath(): string {
  const xdgHome = process.env.XDG_CONFIG_HOME;
  const baseDir = xdgHome && xdgHome.length > 0 ? xdgHome : path.join(os.homedir(), '.config');
  return path.join(baseDir, 'lazyload-cloud', 'auth.json');
}

export async function loadUserConfig(): Promise<UserConfig> {
  const filePath = getUserConfigPath();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = userConfigSchema.parse(JSON.parse(raw));
    return {
      schemaVersion: 1,
      apiBaseUrl: parsed.apiBaseUrl,
      workerApiToken: parsed.workerApiToken ?? parsed.apiToken,
      cloudflareApiToken: parsed.cloudflareApiToken,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        schemaVersion: 1,
      };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}`);
    }
    throw error;
  }
}

export async function saveUserConfig(config: UserConfig): Promise<string> {
  const filePath = getUserConfigPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = userConfigSchema.parse({
    schemaVersion: 1,
    apiBaseUrl: config.apiBaseUrl,
    workerApiToken: config.workerApiToken,
    cloudflareApiToken: config.cloudflareApiToken,
  });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return filePath;
}

export async function clearUserConfig(): Promise<string> {
  const filePath = getUserConfigPath();
  try {
    await fs.rm(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  return filePath;
}
