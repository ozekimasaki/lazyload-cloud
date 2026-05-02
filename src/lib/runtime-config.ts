import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AuthInputOverrides,
  ConfigSource,
  ProjectConfig,
  ResolvedAuthInput,
  ResolvedRuntimeConfig,
  ResolvedValue,
  RuntimeOverrides,
  UserConfig,
} from '../types.js';
import { loadProjectConfig } from './project-config.js';
import { getUserConfigPath, loadUserConfig } from './user-config.js';

type EnvMap = Record<string, string>;

function parseEnvBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value "${value}"`);
}

function parseBooleanOverride(value: string | boolean | undefined): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return parseEnvBoolean(value);
  }
  return undefined;
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export async function loadExplicitEnvFile(filePath: string): Promise<EnvMap> {
  const absolutePath = path.resolve(filePath);
  const raw = await fs.readFile(absolutePath, 'utf8');
  const env: EnvMap = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const separatorIndex = withoutExport.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = withoutExport.slice(0, separatorIndex).trim();
    const value = withoutExport.slice(separatorIndex + 1).trim();
    env[key] = stripWrappingQuotes(value);
  }

  return env;
}

function resolvedValue<T>(value: T, source: ConfigSource): ResolvedValue<T> {
  return { value, source };
}

function pickOptionalString(
  ...candidates: Array<{ value: string | undefined; source: ConfigSource }>
): ResolvedValue<string | undefined> {
  for (const candidate of candidates) {
    if (typeof candidate.value === 'string' && candidate.value.length > 0) {
      return resolvedValue(candidate.value, candidate.source);
    }
  }
  return resolvedValue(undefined, 'absent');
}

function pickRequiredString(
  ...candidates: Array<{ value: string | undefined; source: ConfigSource }>
): ResolvedValue<string> {
  for (const candidate of candidates) {
    if (typeof candidate.value === 'string' && candidate.value.length > 0) {
      return resolvedValue(candidate.value, candidate.source);
    }
  }
  throw new Error('Expected a required string value to be resolved.');
}

function pickBoolean(
  ...candidates: Array<{ value: boolean | undefined; source: ConfigSource }>
): ResolvedValue<boolean> {
  for (const candidate of candidates) {
    if (typeof candidate.value === 'boolean') {
      return resolvedValue(candidate.value, candidate.source);
    }
  }
  return resolvedValue(false, 'default');
}

function buildResolvedProjectConfig(projectConfig: ProjectConfig, runtime: ResolvedRuntimeConfig['resolved']): ProjectConfig {
  return {
    ...projectConfig,
    remote: {
      ...projectConfig.remote,
      projectId: runtime.projectId.value,
      apiBaseUrl: runtime.apiBaseUrl.value,
      preferRemote: runtime.preferRemote.value,
    },
    privacy: {
      ...projectConfig.privacy,
      uploadSource: runtime.uploadSource.value,
    },
  };
}

function buildResolvedUserConfig(userConfig: UserConfig, runtime: ResolvedRuntimeConfig['resolved']): UserConfig {
  return {
    ...userConfig,
    apiBaseUrl: runtime.apiBaseUrl.value,
    workerApiToken: runtime.workerApiToken.value,
    cloudflareApiToken: runtime.cloudflareApiToken.value,
  };
}

export async function resolveRuntimeConfig(
  projectRoot: string,
  overrides: RuntimeOverrides = {}
): Promise<ResolvedRuntimeConfig> {
  const projectConfig = await loadProjectConfig(projectRoot);
  const userConfig = await loadUserConfig();
  const envFilePath = overrides.envFile ?? process.env.LAZYLOAD_ENV_FILE;
  const envFile = envFilePath ? await loadExplicitEnvFile(envFilePath) : {};

  const runtime = {
    projectId: pickRequiredString(
      { value: overrides.projectId, source: 'cli' },
      { value: envFile.LAZYLOAD_PROJECT_ID, source: 'env-file' },
      { value: process.env.LAZYLOAD_PROJECT_ID, source: 'env' },
      { value: projectConfig.remote.projectId, source: 'project-config' }
    ),
    apiBaseUrl: pickOptionalString(
      { value: overrides.apiBaseUrl, source: 'cli' },
      { value: envFile.LAZYLOAD_API_BASE_URL, source: 'env-file' },
      { value: process.env.LAZYLOAD_API_BASE_URL, source: 'env' },
      { value: userConfig.apiBaseUrl, source: 'user-config' },
      { value: projectConfig.remote.apiBaseUrl, source: 'project-config' }
    ),
    workerApiToken: pickOptionalString(
      { value: overrides.workerApiToken, source: 'cli' },
      { value: envFile.LAZYLOAD_API_TOKEN, source: 'env-file' },
      { value: process.env.LAZYLOAD_API_TOKEN, source: 'env' },
      { value: userConfig.workerApiToken, source: 'user-config' }
    ),
    cloudflareApiToken: pickOptionalString(
      { value: overrides.cloudflareApiToken, source: 'cli' },
      { value: envFile.LAZYLOAD_CLOUDFLARE_API_TOKEN ?? envFile.CLOUDFLARE_API_TOKEN, source: 'env-file' },
      { value: process.env.LAZYLOAD_CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN, source: 'env' },
      { value: userConfig.cloudflareApiToken, source: 'user-config' }
    ),
    preferRemote: pickBoolean(
      { value: overrides.preferRemote, source: 'cli' },
      { value: parseBooleanOverride(envFile.LAZYLOAD_PREFER_REMOTE), source: 'env-file' },
      { value: parseBooleanOverride(process.env.LAZYLOAD_PREFER_REMOTE), source: 'env' },
      { value: projectConfig.remote.preferRemote, source: 'project-config' }
    ),
    uploadSource: pickBoolean(
      { value: overrides.uploadSource, source: 'cli' },
      { value: parseBooleanOverride(envFile.LAZYLOAD_UPLOAD_SOURCE), source: 'env-file' },
      { value: parseBooleanOverride(process.env.LAZYLOAD_UPLOAD_SOURCE), source: 'env' },
      { value: projectConfig.privacy.uploadSource, source: 'project-config' }
    ),
  };

  return {
    projectConfig: buildResolvedProjectConfig(projectConfig, runtime),
    userConfig: buildResolvedUserConfig(userConfig, runtime),
    envFilePath,
    resolved: runtime,
  };
}

export async function resolveAuthInput(overrides: AuthInputOverrides = {}): Promise<ResolvedAuthInput> {
  const userConfig = await loadUserConfig();
  const envFilePath = overrides.envFile ?? process.env.LAZYLOAD_ENV_FILE;
  const envFile = envFilePath ? await loadExplicitEnvFile(envFilePath) : {};

  return {
    envFilePath,
    apiBaseUrl: pickOptionalString(
      { value: overrides.apiBaseUrl, source: 'cli' },
      { value: envFile.LAZYLOAD_API_BASE_URL, source: 'env-file' },
      { value: process.env.LAZYLOAD_API_BASE_URL, source: 'env' },
      { value: userConfig.apiBaseUrl, source: 'user-config' }
    ),
    workerApiToken: pickOptionalString(
      { value: overrides.workerApiToken, source: 'cli' },
      { value: envFile.LAZYLOAD_API_TOKEN, source: 'env-file' },
      { value: process.env.LAZYLOAD_API_TOKEN, source: 'env' },
      { value: userConfig.workerApiToken, source: 'user-config' }
    ),
    cloudflareApiToken: pickOptionalString(
      { value: overrides.cloudflareApiToken, source: 'cli' },
      { value: envFile.LAZYLOAD_CLOUDFLARE_API_TOKEN ?? envFile.CLOUDFLARE_API_TOKEN, source: 'env-file' },
      { value: process.env.LAZYLOAD_CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN, source: 'env' },
      { value: userConfig.cloudflareApiToken, source: 'user-config' }
    ),
  };
}

export function maskSecret(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.length <= 4) {
    return '****';
  }
  return `${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

export function getAuthPaths(): { authFilePath: string } {
  return {
    authFilePath: getUserConfigPath(),
  };
}
