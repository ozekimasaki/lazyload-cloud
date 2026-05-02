import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Command } from 'commander';
import chokidar from 'chokidar';
import {
  fetchRemoteStatus,
  queryRemoteClass,
  queryRemoteListFiles,
  queryRemoteListFunctions,
  queryRemoteModuleDependencies,
  queryRemoteFunction,
  queryRemoteOverview,
  queryRemoteReferences,
  queryRemoteRelatedContext,
  queryRemoteStats,
  queryRemoteSymbols,
  queryRemoteSuggestRelated,
  queryRemoteTrace,
  queryRemoteTypeTrace,
  syncRemoteIndex,
} from './lib/cloud-store.js';
import {
  formatClassResult,
  formatFileList,
  formatFunctionResult,
  formatFunctionList,
  formatModuleDependencies,
  formatOverview,
  formatReferences,
  formatRelatedContext,
  formatSearchResults,
  formatIndexStats,
  formatStatus,
  formatSuggestedRelated,
  formatTrace,
  formatTypeTrace,
} from './lib/format.js';
import {
  buildIndex,
  findReferences,
  getArchitectureOverview,
  getClass,
  getFunction,
  getIndexStats,
  getModuleDependencies,
  getRelatedContext,
  listFiles,
  listFunctions,
  loadIndexArtifact,
  sanitizeForRemote,
  searchSymbols,
  suggestRelated,
  traceCalls,
  traceTypes,
  writeIndexArtifact,
} from './lib/indexer.js';
import { createDefaultProjectConfig, ensureProjectConfig, getProjectConfigPath, loadProjectConfig, saveProjectConfig } from './lib/project-config.js';
import { getAuthPaths, maskSecret, resolveAuthInput, resolveRuntimeConfig } from './lib/runtime-config.js';
import { createCloudflareScaffold, createSkillAssets, updateGitignore } from './lib/skills.js';
import { clearUserConfig, loadUserConfig, saveUserConfig } from './lib/user-config.js';
import { createCloudStoreForDirectMode, isDirectConfigComplete } from './lib/cloud-store-factory.js';
import type { IndexArtifact, OutputFormat, ProjectConfig, RemoteMode, RuntimeOverrides, SourceLanguage } from './types.js';

function readFormat(value: string | undefined): OutputFormat {
  if (!value) {
    return 'json';
  }
  if (value === 'json' || value === 'compact' || value === 'markdown') {
    return value;
  }
  throw new Error(`Unsupported format: ${value}`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

interface CommandRuntimeOptions {
  envFile?: string;
  apiBaseUrl?: string;
  workerApiToken?: string;
  cloudflareApiToken?: string;
  projectId?: string;
  preferRemote?: string;
  uploadSource?: string;
  remoteMode?: string;
  accountId?: string;
  d1DatabaseId?: string;
  r2Bucket?: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value "${value}"`);
}

function runtimeOverridesFromOptions(options: CommandRuntimeOptions): RuntimeOverrides {
  return {
    envFile: options.envFile,
    apiBaseUrl: options.apiBaseUrl,
    workerApiToken: options.workerApiToken,
    cloudflareApiToken: options.cloudflareApiToken,
    projectId: options.projectId,
    preferRemote: parseOptionalBoolean(options.preferRemote),
    uploadSource: parseOptionalBoolean(options.uploadSource),
    remoteMode: options.remoteMode as RemoteMode | undefined,
    accountId: options.accountId,
    d1DatabaseId: options.d1DatabaseId,
    r2Bucket: options.r2Bucket,
    r2AccessKeyId: options.r2AccessKeyId,
    r2SecretAccessKey: options.r2SecretAccessKey,
  };
}

async function loadContext(projectRoot: string, options: CommandRuntimeOptions = {}) {
  return resolveRuntimeConfig(projectRoot, runtimeOverridesFromOptions(options));
}

function remoteConfigFromResolvedContext(context: Awaited<ReturnType<typeof loadContext>>) {
  return {
    projectId: context.resolved.projectId.value,
    apiBaseUrl: context.resolved.apiBaseUrl.value,
    workerApiToken: context.resolved.workerApiToken.value,
    cloudflareApiToken: context.resolved.cloudflareApiToken.value,
  };
}

function addRuntimeOptions<T extends Command>(command: T): T {
  return command
    .option('--env-file <path>', 'Explicit env file to load before process env')
    .option('--api-base-url <url>', 'Override remote API base URL')
    .option('--worker-token <token>', 'Override the Worker bearer token')
    .option('--cloudflare-api-token <token>', 'Override the Cloudflare API Token')
    .option('--account-id <id>', 'Override the Cloudflare Account ID for direct mode')
    .option('--d1-database-id <id>', 'Override the D1 Database ID for direct mode')
    .option('--r2-bucket <name>', 'Override the R2 bucket for direct mode')
    .option('--r2-access-key-id <key>', 'Override the R2 Access Key ID for direct mode')
    .option('--r2-secret-access-key <secret>', 'Override the R2 Secret Access Key for direct mode')
    .option('--project-id <id>', 'Override the remote project id')
    .option('--prefer-remote <true|false>', 'Override remote preference')
    .option('--remote-mode <worker|direct>', 'Override remote mode (worker or direct)');
}

function addSyncOptions<T extends Command>(command: T): T {
  return addRuntimeOptions(command).option('--upload-source <true|false>', 'Override upload-source behavior');
}

async function resolveIndex(projectRoot: string, config: ProjectConfig) {
  try {
    return await loadIndexArtifact(projectRoot, config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Index not found at ${config.outputPath}. Run lazyload-cloud index first.`);
    }
    throw error;
  }
}

/** Fetch the remote artifact via R2 in direct mode; run local indexer helpers on the result. */
async function resolveRemoteArtifactForQuery(
  context: Awaited<ReturnType<typeof loadContext>>,
): Promise<IndexArtifact> {
  const projectId = context.resolved.projectId.value;
  const store = createCloudStoreForDirectMode(context.resolved);
  const artifact = await store.getIndex(projectId);
  if (!artifact) {
    throw new Error(
      `No remote index found for project "${projectId}". Run lazyload-cloud sync first.`,
    );
  }
  return artifact;
}

/** Push an artifact to the right backend depending on resolved remote mode. */
async function syncToStore(
  context: Awaited<ReturnType<typeof loadContext>>,
  artifact: IndexArtifact,
) {
  if (context.resolved.remoteMode.value === 'direct') {
    const store = createCloudStoreForDirectMode(context.resolved);
    return store.putIndex(context.resolved.projectId.value, artifact);
  }
  return syncRemoteIndex(remoteConfigFromResolvedContext(context), artifact);
}

/** Fetch remote project status from the right backend. */
async function getRemoteProjectStatus(context: Awaited<ReturnType<typeof loadContext>>) {
  if (context.resolved.remoteMode.value === 'direct') {
    if (!isDirectConfigComplete(context.resolved)) {
      return null;
    }
    const store = createCloudStoreForDirectMode(context.resolved);
    return store.getStatus(context.resolved.projectId.value);
  }
  return fetchRemoteStatus(remoteConfigFromResolvedContext(context));
}

function buildIncludePatterns(config: ProjectConfig): string[] {
  const directories = config.directories.length > 0 ? config.directories : ['.'];
  return directories.flatMap((directory) => {
    const normalizedDir = directory === '.' ? '' : directory.replace(/\\/g, '/').replace(/\/+$/, '');
    return config.include.map((pattern) => (normalizedDir ? `${normalizedDir}/${pattern}` : pattern));
  });
}

function print(output: string): void {
  process.stdout.write(output);
}

async function promptInput(question: string, defaultValue: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return defaultValue;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await rl.question(`${question} (${defaultValue}): `)).trim();
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

async function promptConfirm(question: string, defaultYes = true): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return defaultYes;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (!answer) {
      return defaultYes;
    }
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function renderClaudeMd(config: ProjectConfig): string {
  return `# lazyload-cloud Code Exploration

Use \`lazyload-cloud\` when you need compact code context instead of reading many files.

Recommended pipeline:

1. Run \`lazyload-cloud overview --format compact\`
2. Run \`lazyload-cloud search-symbols <query> --format compact\`
3. Run \`lazyload-cloud get-function <name> --format compact\` or \`lazyload-cloud get-class <name> --format compact\`
4. Run \`lazyload-cloud get-related-context <name> --format compact\` or \`lazyload-cloud trace-calls <name> --format compact\`
5. Run \`lazyload-cloud sync\` when remote Cloudflare-backed results must be current

Project id: \`${config.remote.projectId}\`
`;
}

function renderAgentsMd(config: ProjectConfig): string {
  return `## lazyload-cloud Code Exploration

- Prefer compact CLI queries before loading entire files.
- Local index path: \`${config.outputPath}\`
- Project id: \`${config.remote.projectId}\`
- If remote sync is configured, refresh with \`lazyload-cloud sync\`
`;
}

async function writeOnboardingDocs(projectRoot: string, config: ProjectConfig): Promise<string[]> {
  const files = [
    { path: path.join(projectRoot, 'CLAUDE.md'), content: renderClaudeMd(config) },
    { path: path.join(projectRoot, 'AGENTS.md'), content: renderAgentsMd(config) },
  ];

  for (const file of files) {
    await fs.writeFile(file.path, `${file.content.trimEnd()}\n`, 'utf8');
  }

  return files.map((file) => file.path);
}

export function createCli(): Command {
  const program = new Command();

  program
    .name('lazyload-cloud')
    .description('Cloudflare-backed code context CLI for Agent Skills')
    .version('0.1.4');

  program
    .command('init')
    .description('Create project config, skill assets, and Cloudflare scaffold')
    .option('-y, --yes', 'Accept defaults without interactive prompts', false)
    .option('--skip-index', 'Skip the initial index build', false)
    .option('-d, --directories <dirs...>', 'Directories to index')
    .option('--project-id <id>', 'Override the remote project id')
    .action(async (options: { yes: boolean; skipIndex: boolean; directories?: string[]; projectId?: string }) => {
      const projectRoot = process.cwd();
      const config = createDefaultProjectConfig(projectRoot);
      const selectedDirectories =
        options.directories?.length
          ? options.directories
          : options.yes
            ? config.directories
            : (await promptInput('Directories to index (comma separated)', config.directories.join(',')))
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean);
      config.directories = selectedDirectories.length > 0 ? selectedDirectories : ['.'];
      if (options.projectId) {
        config.remote.projectId = options.projectId;
      }

      const shouldCreateSkills = options.yes ? true : await promptConfirm('Generate Agent Skills assets?', true);
      const shouldCreateCloudflare = options.yes ? true : await promptConfirm('Generate Cloudflare scaffold?', true);
      const shouldCreateDocs = options.yes ? true : await promptConfirm('Generate CLAUDE.md and AGENTS.md?', true);
      const shouldIndex = options.skipIndex ? false : options.yes ? true : await promptConfirm('Run initial indexing now?', true);

      await saveProjectConfig(projectRoot, config);
      await updateGitignore(projectRoot);
      const skillFiles = shouldCreateSkills ? await createSkillAssets(projectRoot, config) : [];
      const cloudflareFiles = shouldCreateCloudflare ? await createCloudflareScaffold(projectRoot, config) : [];
      const onboardingFiles = shouldCreateDocs ? await writeOnboardingDocs(projectRoot, config) : [];
      const artifact = shouldIndex ? await buildIndex(projectRoot, config) : null;
      const outputPath = artifact ? await writeIndexArtifact(projectRoot, config, artifact) : null;

      print(
        JSON.stringify(
          {
            configPath: getProjectConfigPath(projectRoot),
            skillFiles,
            cloudflareFiles,
            onboardingFiles,
            outputPath,
          },
          null,
          2
        ) + '\n'
      );
    });

  const auth = program.command('auth').description('Manage user-level authentication settings');

  auth
    .command('login')
    .description('Store Cloudflare API credentials in user config (worker or direct mode)')
    .option('--env-file <path>', 'Explicit env file to load before process env')
    .option('--api-base-url <url>', 'Worker API base URL')
    .option('--token <token>', 'Worker bearer token (legacy alias)')
    .option('--worker-token <token>', 'Worker bearer token')
    .option('--cloudflare-api-token <token>', 'Cloudflare API Token (also used for D1 access in direct mode)')
    .option('--account-id <id>', 'Cloudflare Account ID (direct mode)')
    .option('--d1-database-id <id>', 'D1 Database ID (direct mode)')
    .option('--r2-bucket <name>', 'R2 Bucket name (direct mode)')
    .option('--r2-access-key-id <key>', 'R2 Access Key ID (direct mode)')
    .option('--r2-secret-access-key <key>', 'R2 Secret Access Key (direct mode)')
    .action(async (options: {
      envFile?: string;
      apiBaseUrl?: string;
      token?: string;
      workerToken?: string;
      cloudflareApiToken?: string;
      accountId?: string;
      d1DatabaseId?: string;
      r2Bucket?: string;
      r2AccessKeyId?: string;
      r2SecretAccessKey?: string;
    }) => {
      const resolved = await resolveAuthInput({
        envFile: options.envFile,
        apiBaseUrl: options.apiBaseUrl,
        workerApiToken: options.workerToken ?? options.token,
        cloudflareApiToken: options.cloudflareApiToken,
        accountId: options.accountId,
        d1DatabaseId: options.d1DatabaseId,
        r2Bucket: options.r2Bucket,
        r2AccessKeyId: options.r2AccessKeyId,
        r2SecretAccessKey: options.r2SecretAccessKey,
      });

      // Merge with existing stored config so partial updates don't wipe unrelated fields.
      const existing = await loadUserConfig();
      const mergedAccountId = resolved.accountId.value ?? existing.accountId;
      const mergedD1DatabaseId = resolved.d1DatabaseId.value ?? existing.d1DatabaseId;
      const mergedR2Bucket = resolved.r2Bucket.value ?? existing.r2Bucket;
      const mergedR2AccessKeyId = resolved.r2AccessKeyId.value ?? existing.r2AccessKeyId;
      const mergedR2SecretAccessKey = resolved.r2SecretAccessKey.value ?? existing.r2SecretAccessKey;

      const hasDirectCreds = !!(
        mergedAccountId && mergedD1DatabaseId && mergedR2Bucket &&
        mergedR2AccessKeyId && mergedR2SecretAccessKey
      );

      if (!hasDirectCreds) {
        if (!resolved.apiBaseUrl.value) {
          throw new Error(
            'No API base URL resolved. Pass --api-base-url or set LAZYLOAD_API_BASE_URL.\n' +
            'For direct Cloudflare access without a Worker, pass --account-id, --d1-database-id,\n' +
            '--r2-bucket, --r2-access-key-id, and --r2-secret-access-key instead.'
          );
        }
        if (!resolved.workerApiToken.value) {
          throw new Error(
            'No worker credential resolved. Pass --worker-token or set LAZYLOAD_API_TOKEN for Worker mode.'
          );
        }
      }

      const mergedApiBaseUrl = resolved.apiBaseUrl.value ?? existing.apiBaseUrl;
      const mergedWorkerApiToken = resolved.workerApiToken.value ?? existing.workerApiToken;
      const mergedCloudflareApiToken = resolved.cloudflareApiToken.value ?? existing.cloudflareApiToken;

      const filePath = await saveUserConfig({
        schemaVersion: 1,
        apiBaseUrl: mergedApiBaseUrl,
        workerApiToken: mergedWorkerApiToken,
        cloudflareApiToken: mergedCloudflareApiToken,
        accountId: mergedAccountId,
        d1DatabaseId: mergedD1DatabaseId,
        r2Bucket: mergedR2Bucket,
        r2AccessKeyId: mergedR2AccessKeyId,
        r2SecretAccessKey: mergedR2SecretAccessKey,
      });
      print(
        `${JSON.stringify(
          {
            saved: filePath,
            mode: hasDirectCreds ? 'direct' : 'worker',
            apiBaseUrlSource: resolved.apiBaseUrl.source,
            workerApiTokenSource: resolved.workerApiToken.source,
            cloudflareApiTokenSource: resolved.cloudflareApiToken.source,
            accountIdSet: Boolean(mergedAccountId),
            d1DatabaseIdSet: Boolean(mergedD1DatabaseId),
            r2BucketSet: Boolean(mergedR2Bucket),
            r2AccessKeyIdSet: Boolean(mergedR2AccessKeyId),
            r2SecretAccessKeySet: Boolean(mergedR2SecretAccessKey),
          },
          null,
          2
        )}\n`
      );
    });

  auth
    .command('logout')
    .description('Remove the stored auth file')
    .action(async () => {
      const filePath = await clearUserConfig();
      print(`${JSON.stringify({ removed: filePath }, null, 2)}\n`);
    });

  auth
    .command('status')
    .description('Show the current auth resolution state')
    .option('--env-file <path>', 'Explicit env file to load before process env')
    .action(async (options: { envFile?: string }) => {
      const resolved = await resolveAuthInput({ envFile: options.envFile });
      const { authFilePath } = getAuthPaths();
      const stored = await loadUserConfig();

      print(
        `${JSON.stringify(
          {
            authFilePath,
            envFilePath: resolved.envFilePath,
            storedApiBaseUrl: stored.apiBaseUrl ?? null,
            storedWorkerTokenPresent: Boolean(stored.workerApiToken),
            storedCloudflareApiTokenPresent: Boolean(stored.cloudflareApiToken),
            storedAccountIdPresent: Boolean(stored.accountId),
            storedD1DatabaseIdPresent: Boolean(stored.d1DatabaseId),
            storedR2BucketPresent: Boolean(stored.r2Bucket),
            storedR2AccessKeyIdPresent: Boolean(stored.r2AccessKeyId),
            storedR2SecretAccessKeyPresent: Boolean(stored.r2SecretAccessKey),
            resolvedAccountIdPresent: Boolean(resolved.accountId.value),
            resolvedAccountIdSource: resolved.accountId.source,
            resolvedD1DatabaseIdPresent: Boolean(resolved.d1DatabaseId.value),
            resolvedD1DatabaseIdSource: resolved.d1DatabaseId.source,
            resolvedR2BucketPresent: Boolean(resolved.r2Bucket.value),
            resolvedR2BucketSource: resolved.r2Bucket.source,
            resolvedR2AccessKeyIdPresent: Boolean(resolved.r2AccessKeyId.value),
            resolvedR2AccessKeyIdSource: resolved.r2AccessKeyId.source,
            resolvedR2AccessKeyIdMasked: maskSecret(resolved.r2AccessKeyId.value) ?? null,
            resolvedR2SecretAccessKeyPresent: Boolean(resolved.r2SecretAccessKey.value),
            resolvedR2SecretAccessKeySource: resolved.r2SecretAccessKey.source,
            resolvedR2SecretAccessKeyMasked: maskSecret(resolved.r2SecretAccessKey.value) ?? null,
            resolvedApiBaseUrl: resolved.apiBaseUrl.value ?? null,
            resolvedApiBaseUrlSource: resolved.apiBaseUrl.source,
            resolvedWorkerApiTokenPresent: Boolean(resolved.workerApiToken.value),
            resolvedWorkerApiTokenSource: resolved.workerApiToken.source,
            resolvedWorkerApiTokenMasked: maskSecret(resolved.workerApiToken.value) ?? null,
            resolvedCloudflareApiTokenPresent: Boolean(resolved.cloudflareApiToken.value),
            resolvedCloudflareApiTokenSource: resolved.cloudflareApiToken.source,
            resolvedCloudflareApiTokenMasked: maskSecret(resolved.cloudflareApiToken.value) ?? null,
          },
          null,
          2
        )}\n`
      );
    });

  program
    .command('login')
    .description('Deprecated alias for auth login')
    .option('--env-file <path>', 'Explicit env file to load before process env')
    .option('--api-base-url <url>', 'Worker API base URL')
    .option('--token <token>', 'Worker bearer token (legacy alias)')
    .option('--worker-token <token>', 'Worker bearer token')
    .option('--cloudflare-api-token <token>', 'Cloudflare API Token')
    .action(async (options: { envFile?: string; apiBaseUrl?: string; token?: string; workerToken?: string; cloudflareApiToken?: string }) => {
      const resolved = await resolveAuthInput({
        envFile: options.envFile,
        apiBaseUrl: options.apiBaseUrl,
        workerApiToken: options.workerToken ?? options.token,
        cloudflareApiToken: options.cloudflareApiToken,
      });

      if (!resolved.apiBaseUrl.value) {
        throw new Error(
          'No API base URL resolved. Pass --api-base-url or set LAZYLOAD_API_BASE_URL.\n' +
          'For direct Cloudflare access without a Worker, use `auth login` with --account-id and related flags.'
        );
      }
      if (!resolved.workerApiToken.value) {
        throw new Error(
          'No worker credential resolved. Pass --worker-token or set LAZYLOAD_API_TOKEN for Worker mode.'
        );
      }

      const existing = await loadUserConfig();
      const filePath = await saveUserConfig({
        schemaVersion: 1,
        apiBaseUrl: resolved.apiBaseUrl.value ?? existing.apiBaseUrl,
        workerApiToken: resolved.workerApiToken.value ?? existing.workerApiToken,
        cloudflareApiToken: resolved.cloudflareApiToken.value ?? existing.cloudflareApiToken,
        accountId: existing.accountId,
        d1DatabaseId: existing.d1DatabaseId,
        r2Bucket: existing.r2Bucket,
        r2AccessKeyId: existing.r2AccessKeyId,
        r2SecretAccessKey: existing.r2SecretAccessKey,
      });
      print(`${JSON.stringify({ saved: filePath, alias: 'login' }, null, 2)}\n`);
    });

  program
    .command('index')
    .description('Build the local index for the current project')
    .action(async () => {
      const projectRoot = process.cwd();
      const config = await ensureProjectConfig(projectRoot);
      const artifact = await buildIndex(projectRoot, config);
      const outputPath = await writeIndexArtifact(projectRoot, config, artifact);
      print(
        JSON.stringify(
          {
            outputPath,
            files: artifact.files.length,
            symbols: artifact.symbols.length,
            generatedAt: artifact.generatedAt,
          },
          null,
          2
        ) + '\n'
      );
    });

  addRuntimeOptions(
    program
      .command('stats')
      .description('Show local or remote index statistics')
      .option('--remote', 'Force remote stats query', false)
      .option('--format <format>', 'json | compact | markdown', 'json')
      .action(async (options: { remote: boolean; format: string } & CommandRuntimeOptions) => {
        const projectRoot = process.cwd();
        const context = await loadContext(projectRoot, options);
        const config = context.projectConfig;
        const format = readFormat(options.format);

        if (options.remote || config.remote.preferRemote) {
          if (context.resolved.remoteMode.value === 'direct') {
            const artifact = await resolveRemoteArtifactForQuery(context);
            print(formatIndexStats(getIndexStats(artifact), format));
            return;
          }
          print(formatIndexStats(await queryRemoteStats(remoteConfigFromResolvedContext(context)), format));
          return;
        }

        const artifact = await resolveIndex(projectRoot, config);
        print(formatIndexStats(getIndexStats(artifact), format));
      })
  );

  addSyncOptions(
    program
      .command('watch')
      .description('Watch indexed files and rebuild on changes')
      .option('--debounce <ms>', 'Debounce rebuild window in milliseconds', '300')
      .option('--once', 'Run one index pass and exit', false)
      .option('--verbose', 'Log all rebuild events', false)
      .option('--remote-sync', 'Sync to Cloudflare after rebuilds', false)
      .action(
        async (
          options: { debounce: string; once: boolean; verbose: boolean; remoteSync: boolean } & CommandRuntimeOptions
        ) => {
          const projectRoot = process.cwd();
          const context = await loadContext(projectRoot, options);
          const config = context.projectConfig;
          const debounceMs = Number.parseInt(options.debounce, 10);
          if (Number.isNaN(debounceMs) || debounceMs < 0) {
            throw new Error(`Invalid debounce value: ${options.debounce}`);
          }

          const rebuild = async (): Promise<{ outputPath: string; files: number; symbols: number }> => {
            const artifact = await buildIndex(projectRoot, config);
            const outputPath = await writeIndexArtifact(projectRoot, config, artifact);
            if (options.remoteSync) {
              const sanitized = sanitizeForRemote(artifact, config);
              await syncToStore(context, sanitized);
            }
            return { outputPath, files: artifact.files.length, symbols: artifact.symbols.length };
          };

          const initial = await rebuild();
          if (options.once) {
            print(`${JSON.stringify({ mode: 'once', ...initial }, null, 2)}\n`);
            return;
          }

          print(`Watching ${projectRoot}\n`);
          let timer: NodeJS.Timeout | undefined;

          const watcher = chokidar.watch(buildIncludePatterns(config), {
            cwd: projectRoot,
            ignored: config.exclude,
            ignoreInitial: true,
            awaitWriteFinish: {
              stabilityThreshold: 200,
              pollInterval: 100,
            },
          });

          const schedule = (event: string, filePath: string): void => {
            const relPath = filePath.replace(/\\/g, '/');
            if (options.verbose || event === 'add' || event === 'unlink') {
              print(`${event}:${relPath}\n`);
            }
            if (timer) {
              clearTimeout(timer);
            }
            timer = setTimeout(async () => {
              try {
                const result = await rebuild();
                print(`reindexed\t${result.files}\t${result.symbols}\t${result.outputPath}\n`);
              } catch (error) {
                print(`error\t${error instanceof Error ? error.message : String(error)}\n`);
              }
            }, debounceMs);
          };

          watcher.on('add', (filePath) => schedule('add', filePath));
          watcher.on('change', (filePath) => schedule('change', filePath));
          watcher.on('unlink', (filePath) => schedule('unlink', filePath));
          watcher.on('ready', () => print('ready\n'));
          watcher.on('error', (error) => print(`error\t${error instanceof Error ? error.message : String(error)}\n`));

          const closeWatcher = async (): Promise<void> => {
            if (timer) {
              clearTimeout(timer);
              timer = undefined;
            }
            await watcher.close();
          };

          process.once('SIGINT', () => {
            void closeWatcher().finally(() => process.exit(130));
          });
          process.once('SIGTERM', () => {
            void closeWatcher().finally(() => process.exit(143));
          });
        }
      )
  );

  const query = program.command('query').description('Query the local or remote index');

  addRuntimeOptions(
    query
    .command('symbols <query>')
    .description('Search indexed symbols')
    .option('--limit <number>', 'Result limit', '20')
    .option('--remote', 'Force remote query', false)
    .option('--format <format>', 'json | compact | markdown', 'json')
    .action(async (queryText: string, options: { limit: string; remote: boolean; format: string } & CommandRuntimeOptions) => {
      const projectRoot = process.cwd();
      const context = await loadContext(projectRoot, options);
      const config = context.projectConfig;
      const format = readFormat(options.format);
      const limit = Number.parseInt(options.limit, 10);

      if (options.remote || config.remote.preferRemote) {
        if (context.resolved.remoteMode.value === 'direct') {
          const artifact = await resolveRemoteArtifactForQuery(context);
          print(formatSearchResults(searchSymbols(artifact, queryText, { limit }), format));
          return;
        }
        const results = await queryRemoteSymbols(remoteConfigFromResolvedContext(context), queryText, limit);
        print(formatSearchResults(results, format));
        return;
      }

      const artifact = await resolveIndex(projectRoot, config);
      print(formatSearchResults(searchSymbols(artifact, queryText, { limit }), format));
    }));

  addRuntimeOptions(
    program
      .command('list-files')
      .description('Compatibility command for list_files')
      .option('--limit <number>', 'Result limit', '50')
      .option('--language <language>', 'Filter by language')
      .option('--pattern <pattern>', 'Filter by file path substring')
      .option('--remote', 'Force remote query', false)
      .option('--format <format>', 'json | compact | markdown', 'json')
      .action(async (options: { limit: string; language?: SourceLanguage; pattern?: string; remote: boolean; format: string } & CommandRuntimeOptions) => {
        const projectRoot = process.cwd();
        const context = await loadContext(projectRoot, options);
        const config = context.projectConfig;
        const limit = Number.parseInt(options.limit, 10);
        const format = readFormat(options.format);

        if (options.remote || config.remote.preferRemote) {
          if (context.resolved.remoteMode.value === 'direct') {
            const artifact = await resolveRemoteArtifactForQuery(context);
            print(formatFileList(listFiles(artifact, { limit, language: options.language, pattern: options.pattern }), format));
            return;
          }
          print(
            formatFileList(
              await queryRemoteListFiles(remoteConfigFromResolvedContext(context), {
                limit,
                language: options.language,
                pattern: options.pattern,
              }),
              format
            )
          );
          return;
        }

        const artifact = await resolveIndex(projectRoot, config);
        print(formatFileList(listFiles(artifact, { limit, language: options.language, pattern: options.pattern }), format));
      })
  );

  addRuntimeOptions(
    program
      .command('list-functions')
      .description('Compatibility command for list_functions')
      .option('--limit <number>', 'Result limit', '50')
      .option('--language <language>', 'Filter by language')
      .option('--file-pattern <pattern>', 'Filter by file path substring')
      .option('--exported <true|false>', 'Filter by exported flag')
      .option('--remote', 'Force remote query', false)
      .option('--format <format>', 'json | compact | markdown', 'json')
      .action(
        async (
          options: {
            limit: string;
              language?: SourceLanguage;
            filePattern?: string;
            exported?: string;
            remote: boolean;
            format: string;
          } & CommandRuntimeOptions
        ) => {
          const projectRoot = process.cwd();
          const context = await loadContext(projectRoot, options);
          const config = context.projectConfig;
          const limit = Number.parseInt(options.limit, 10);
          const format = readFormat(options.format);
          const exported = parseOptionalBoolean(options.exported);

          if (options.remote || config.remote.preferRemote) {
            if (context.resolved.remoteMode.value === 'direct') {
              const artifact = await resolveRemoteArtifactForQuery(context);
              print(formatFunctionList(listFunctions(artifact, { limit, language: options.language, exported, filePattern: options.filePattern }), format));
              return;
            }
            print(
              formatFunctionList(
                await queryRemoteListFunctions(remoteConfigFromResolvedContext(context), {
                  limit,
                  language: options.language,
                  exported,
                  filePattern: options.filePattern,
                }),
                format
              )
            );
            return;
          }

          const artifact = await resolveIndex(projectRoot, config);
          print(
            formatFunctionList(
              listFunctions(artifact, {
                limit,
                language: options.language,
                exported,
                filePattern: options.filePattern,
              }),
              format
            )
          );
        }
      )
  );

  addRuntimeOptions(
    program
      .command('search-symbols <queryText>')
      .description('Compatibility command for search_symbols')
      .option('--limit <number>', 'Result limit', '20')
      .option('--remote', 'Force remote query', false)
      .option('--format <format>', 'json | compact | markdown', 'json')
      .action(async (queryText: string, options: { limit: string; remote: boolean; format: string } & CommandRuntimeOptions) => {
        const projectRoot = process.cwd();
        const context = await loadContext(projectRoot, options);
        const config = context.projectConfig;
        const format = readFormat(options.format);
        const limit = Number.parseInt(options.limit, 10);

        if (options.remote || config.remote.preferRemote) {
          if (context.resolved.remoteMode.value === 'direct') {
            const artifact = await resolveRemoteArtifactForQuery(context);
            print(formatSearchResults(searchSymbols(artifact, queryText, { limit }), format));
            return;
          }
          print(formatSearchResults(await queryRemoteSymbols(remoteConfigFromResolvedContext(context), queryText, limit), format));
          return;
        }

        const artifact = await resolveIndex(projectRoot, config);
        print(formatSearchResults(searchSymbols(artifact, queryText, { limit }), format));
      })
  );

  addRuntimeOptions(
    program
      .command('get-function <name>')
      .description('Compatibility command for get_function')
      .option('--remote', 'Force remote query', false)
      .option('--format <format>', 'json | compact | markdown', 'json')
      .action(async (name: string, options: { remote: boolean; format: string } & CommandRuntimeOptions) => {
        const projectRoot = process.cwd();
        const context = await loadContext(projectRoot, options);
        const config = context.projectConfig;
        const format = readFormat(options.format);

        if (options.remote || config.remote.preferRemote) {
          if (context.resolved.remoteMode.value === 'direct') {
            const artifact = await resolveRemoteArtifactForQuery(context);
            print(formatFunctionResult(getFunction(artifact, name), format));
            return;
          }
          print(formatFunctionResult(await queryRemoteFunction(remoteConfigFromResolvedContext(context), name), format));
          return;
        }

        const artifact = await resolveIndex(projectRoot, config);
        print(formatFunctionResult(getFunction(artifact, name), format));
      })
  );

  addRuntimeOptions(
    program
      .command('get-class <name>')
      .description('Compatibility command for get_class')
      .option('--remote', 'Force remote query', false)
      .option('--format <format>', 'json | compact | markdown', 'json')
      .action(async (name: string, options: { remote: boolean; format: string } & CommandRuntimeOptions) => {
        const projectRoot = process.cwd();
        const context = await loadContext(projectRoot, options);
        const config = context.projectConfig;
        const format = readFormat(options.format);

        if (options.remote || config.remote.preferRemote) {
          if (context.resolved.remoteMode.value === 'direct') {
            const artifact = await resolveRemoteArtifactForQuery(context);
            print(formatClassResult(getClass(artifact, name), format));
            return;
          }
          print(formatClassResult(await queryRemoteClass(remoteConfigFromResolvedContext(context), name), format));
          return;
        }

        const artifact = await resolveIndex(projectRoot, config);
        print(formatClassResult(getClass(artifact, name), format));
      })
  );

  addRuntimeOptions(
    program
      .command('get-related-context <name>')
      .description('Compatibility command for get_related_context')
      .option('--remote', 'Force remote query', false)
      .option('--format <format>', 'json | compact | markdown', 'json')
      .action(async (name: string, options: { remote: boolean; format: string } & CommandRuntimeOptions) => {
        const projectRoot = process.cwd();
        const context = await loadContext(projectRoot, options);
        const config = context.projectConfig;
        const format = readFormat(options.format);

        if (options.remote || config.remote.preferRemote) {
          if (context.resolved.remoteMode.value === 'direct') {
            const artifact = await resolveRemoteArtifactForQuery(context);
            print(formatRelatedContext(getRelatedContext(artifact, name), format));
            return;
          }
          print(formatRelatedContext(await queryRemoteRelatedContext(remoteConfigFromResolvedContext(context), name), format));
          return;
        }

        const artifact = await resolveIndex(projectRoot, config);
        print(formatRelatedContext(getRelatedContext(artifact, name), format));
      })
  );

  addRuntimeOptions(
    program
      .command('find-references <name>')
      .description('Compatibility command for find_references')
      .option('--remote', 'Force remote query', false)
      .option('--format <format>', 'json | compact | markdown', 'json')
      .action(async (name: string, options: { remote: boolean; format: string } & CommandRuntimeOptions) => {
        const projectRoot = process.cwd();
        const context = await loadContext(projectRoot, options);
        const config = context.projectConfig;
        const format = readFormat(options.format);

        if (options.remote || config.remote.preferRemote) {
          if (context.resolved.remoteMode.value === 'direct') {
            const artifact = await resolveRemoteArtifactForQuery(context);
            print(formatReferences(findReferences(artifact, name), format));
            return;
          }
          print(formatReferences(await queryRemoteReferences(remoteConfigFromResolvedContext(context), name), format));
          return;
        }

        const artifact = await resolveIndex(projectRoot, config);
        print(formatReferences(findReferences(artifact, name), format));
      })
  );

  addRuntimeOptions(
    program
      .command('trace-calls <name>')
      .description('Compatibility command for trace_calls')
      .option('--depth <number>', 'Traversal depth', '2')
      .option('--remote', 'Force remote query', false)
      .option('--format <format>', 'json | compact | markdown', 'json')
      .action(async (name: string, options: { depth: string; remote: boolean; format: string } & CommandRuntimeOptions) => {
        const projectRoot = process.cwd();
        const context = await loadContext(projectRoot, options);
        const config = context.projectConfig;
        const format = readFormat(options.format);
        const depth = Number.parseInt(options.depth, 10);

        if (options.remote || config.remote.preferRemote) {
          if (context.resolved.remoteMode.value === 'direct') {
            const artifact = await resolveRemoteArtifactForQuery(context);
            print(formatTrace(traceCalls(artifact, name, depth), format));
            return;
          }
          print(formatTrace(await queryRemoteTrace(remoteConfigFromResolvedContext(context), name, depth), format));
          return;
        }

        const artifact = await resolveIndex(projectRoot, config);
        print(formatTrace(traceCalls(artifact, name, depth), format));
      })
  );

  addRuntimeOptions(
    program
      .command('trace-types <name>')
      .description('Compatibility command for trace_types')
      .option('--depth <number>', 'Traversal depth', '2')
      .option('--remote', 'Force remote query', false)
      .option('--format <format>', 'json | compact | markdown', 'json')
      .action(async (name: string, options: { depth: string; remote: boolean; format: string } & CommandRuntimeOptions) => {
        const projectRoot = process.cwd();
        const context = await loadContext(projectRoot, options);
        const config = context.projectConfig;
        const format = readFormat(options.format);
        const depth = Number.parseInt(options.depth, 10);

        if (options.remote || config.remote.preferRemote) {
          if (context.resolved.remoteMode.value === 'direct') {
            const artifact = await resolveRemoteArtifactForQuery(context);
            print(formatTypeTrace(traceTypes(artifact, name, depth), format));
            return;
          }
          print(formatTypeTrace(await queryRemoteTypeTrace(remoteConfigFromResolvedContext(context), name, depth), format));
          return;
        }

        const artifact = await resolveIndex(projectRoot, config);
        print(formatTypeTrace(traceTypes(artifact, name, depth), format));
      })
  );

  addRuntimeOptions(
    program
      .command('get-module-dependencies <modulePath>')
      .description('Compatibility command for get_module_dependencies')
      .option('--remote', 'Force remote query', false)
      .option('--format <format>', 'json | compact | markdown', 'json')
      .action(async (modulePath: string, options: { remote: boolean; format: string } & CommandRuntimeOptions) => {
        const projectRoot = process.cwd();
        const context = await loadContext(projectRoot, options);
        const config = context.projectConfig;
        const format = readFormat(options.format);

        if (options.remote || config.remote.preferRemote) {
          if (context.resolved.remoteMode.value === 'direct') {
            const artifact = await resolveRemoteArtifactForQuery(context);
            print(formatModuleDependencies(getModuleDependencies(artifact, modulePath), format));
            return;
          }
          print(
            formatModuleDependencies(
              await queryRemoteModuleDependencies(remoteConfigFromResolvedContext(context), modulePath),
              format
            )
          );
          return;
        }

        const artifact = await resolveIndex(projectRoot, config);
        print(formatModuleDependencies(getModuleDependencies(artifact, modulePath), format));
      })
  );

  addRuntimeOptions(
    program
      .command('get-architecture-overview')
      .description('Compatibility command for get_architecture_overview')
      .option('--remote', 'Force remote overview', false)
      .option('--format <format>', 'json | compact | markdown', 'json')
      .action(async (options: { remote: boolean; format: string } & CommandRuntimeOptions) => {
        const projectRoot = process.cwd();
        const context = await loadContext(projectRoot, options);
        const config = context.projectConfig;
        const format = readFormat(options.format);

        if (options.remote || config.remote.preferRemote) {
          if (context.resolved.remoteMode.value === 'direct') {
            const artifact = await resolveRemoteArtifactForQuery(context);
            print(formatOverview(getArchitectureOverview(artifact), format));
            return;
          }
          print(formatOverview(await queryRemoteOverview(remoteConfigFromResolvedContext(context)), format));
          return;
        }

        const artifact = await resolveIndex(projectRoot, config);
        print(formatOverview(getArchitectureOverview(artifact), format));
      })
  );

  addRuntimeOptions(
    program
      .command('suggest-related <name>')
      .description('Compatibility command for suggest_related')
      .option('--limit <number>', 'Result limit', '10')
      .option('--remote', 'Force remote query', false)
      .option('--format <format>', 'json | compact | markdown', 'json')
      .action(async (name: string, options: { limit: string; remote: boolean; format: string } & CommandRuntimeOptions) => {
        const projectRoot = process.cwd();
        const context = await loadContext(projectRoot, options);
        const config = context.projectConfig;
        const format = readFormat(options.format);
        const limit = Number.parseInt(options.limit, 10);

        if (options.remote || config.remote.preferRemote) {
          if (context.resolved.remoteMode.value === 'direct') {
            const artifact = await resolveRemoteArtifactForQuery(context);
            print(formatSuggestedRelated(suggestRelated(artifact, name, limit), format));
            return;
          }
          print(formatSuggestedRelated(await queryRemoteSuggestRelated(remoteConfigFromResolvedContext(context), name, limit), format));
          return;
        }

        const artifact = await resolveIndex(projectRoot, config);
        print(formatSuggestedRelated(suggestRelated(artifact, name, limit), format));
      })
  );

  addSyncOptions(
    program
      .command('sync-index')
      .description('Compatibility command for sync_index')
      .action(async (options: CommandRuntimeOptions) => {
        const projectRoot = process.cwd();
        const context = await loadContext(projectRoot, options);
        const config = context.projectConfig;
        const artifact = await resolveIndex(projectRoot, config);
        const sanitized = sanitizeForRemote(artifact, config);
        print(`${JSON.stringify(await syncToStore(context, sanitized), null, 2)}\n`);
      })
  );

  addRuntimeOptions(
    query
    .command('function <name>')
    .description('Fetch one function or method')
    .option('--remote', 'Force remote query', false)
    .option('--format <format>', 'json | compact | markdown', 'json')
    .action(async (name: string, options: { remote: boolean; format: string } & CommandRuntimeOptions) => {
      const projectRoot = process.cwd();
      const context = await loadContext(projectRoot, options);
      const config = context.projectConfig;
      const format = readFormat(options.format);

      if (options.remote || config.remote.preferRemote) {
        if (context.resolved.remoteMode.value === 'direct') {
          const artifact = await resolveRemoteArtifactForQuery(context);
          print(formatFunctionResult(getFunction(artifact, name), format));
          return;
        }
        print(formatFunctionResult(await queryRemoteFunction(remoteConfigFromResolvedContext(context), name), format));
        return;
      }

      const artifact = await resolveIndex(projectRoot, config);
      print(formatFunctionResult(getFunction(artifact, name), format));
    }));

  addRuntimeOptions(
    query
    .command('calls <name>')
    .description('Trace calls from one function or method')
    .option('--depth <number>', 'Traversal depth', '2')
    .option('--remote', 'Force remote query', false)
    .option('--format <format>', 'json | compact | markdown', 'json')
    .action(async (name: string, options: { depth: string; remote: boolean; format: string } & CommandRuntimeOptions) => {
      const projectRoot = process.cwd();
      const context = await loadContext(projectRoot, options);
      const config = context.projectConfig;
      const format = readFormat(options.format);
      const depth = Number.parseInt(options.depth, 10);

      if (options.remote || config.remote.preferRemote) {
        if (context.resolved.remoteMode.value === 'direct') {
          const artifact = await resolveRemoteArtifactForQuery(context);
          print(formatTrace(traceCalls(artifact, name, depth), format));
          return;
        }
        print(formatTrace(await queryRemoteTrace(remoteConfigFromResolvedContext(context), name, depth), format));
        return;
      }

      const artifact = await resolveIndex(projectRoot, config);
      print(formatTrace(traceCalls(artifact, name, depth), format));
    }));

  addRuntimeOptions(
    program
    .command('overview')
    .description('Summarize the project architecture')
    .option('--remote', 'Force remote overview', false)
    .option('--format <format>', 'json | compact | markdown', 'json')
    .action(async (options: { remote: boolean; format: string } & CommandRuntimeOptions) => {
      const projectRoot = process.cwd();
      const context = await loadContext(projectRoot, options);
      const config = context.projectConfig;
      const format = readFormat(options.format);

      if (options.remote || config.remote.preferRemote) {
        if (context.resolved.remoteMode.value === 'direct') {
          const artifact = await resolveRemoteArtifactForQuery(context);
          print(formatOverview(getArchitectureOverview(artifact), format));
          return;
        }
        print(formatOverview(await queryRemoteOverview(remoteConfigFromResolvedContext(context)), format));
        return;
      }

      const artifact = await resolveIndex(projectRoot, config);
      print(formatOverview(getArchitectureOverview(artifact), format));
    }));

  addSyncOptions(
    program
    .command('sync')
    .description('Upload the local index to the configured Cloudflare backend (Worker or direct)')
    .action(async (options: CommandRuntimeOptions) => {
      const projectRoot = process.cwd();
      const context = await loadContext(projectRoot, options);
      const config = context.projectConfig;
      const artifact = await resolveIndex(projectRoot, config);
      const sanitized = sanitizeForRemote(artifact, config);
      print(`${JSON.stringify(await syncToStore(context, sanitized), null, 2)}\n`);
    }));

  addSyncOptions(
    program
    .command('status')
    .description('Show local and remote project status')
    .option('--format <format>', 'json | compact | markdown', 'json')
    .action(async (options: { format: string } & CommandRuntimeOptions) => {
      const projectRoot = process.cwd();
      const context = await loadContext(projectRoot, options);
      const config = context.projectConfig;
      const configPath = getProjectConfigPath(projectRoot);
      const localIndexPath = path.join(projectRoot, config.outputPath);
      const localIndexExists = await fileExists(localIndexPath);
      const artifact = localIndexExists ? await resolveIndex(projectRoot, config) : null;
      const remoteStatus = await getRemoteProjectStatus(context);

      print(
        formatStatus(
          {
            localIndexExists,
            localFileCount: artifact?.files.length ?? 0,
            localSymbolCount: artifact?.symbols.length ?? 0,
            remoteStatus,
            configPath,
          },
          readFormat(options.format)
        )
      );
    }));

  addSyncOptions(
    program
      .command('config')
      .description('Inspect resolved runtime configuration')
      .command('inspect')
      .description('Show effective runtime configuration and value sources')
      .action(async (options: CommandRuntimeOptions) => {
        const projectRoot = process.cwd();
        const context = await loadContext(projectRoot, options);
        const { authFilePath } = getAuthPaths();
        const configPath = getProjectConfigPath(projectRoot);

        print(
          `${JSON.stringify(
            {
              configPath,
              authFilePath,
              envFilePath: context.envFilePath ?? null,
              resolved: {
                remoteMode: context.resolved.remoteMode,
                projectId: context.resolved.projectId,
                apiBaseUrl: context.resolved.apiBaseUrl,
                workerApiToken: {
                  source: context.resolved.workerApiToken.source,
                  value: maskSecret(context.resolved.workerApiToken.value) ?? null,
                },
                cloudflareApiToken: {
                  source: context.resolved.cloudflareApiToken.source,
                  value: maskSecret(context.resolved.cloudflareApiToken.value) ?? null,
                },
                preferRemote: context.resolved.preferRemote,
                uploadSource: context.resolved.uploadSource,
                accountId: context.resolved.accountId,
                d1DatabaseId: context.resolved.d1DatabaseId,
                r2Bucket: context.resolved.r2Bucket,
                r2AccessKeyId: {
                  source: context.resolved.r2AccessKeyId.source,
                  value: maskSecret(context.resolved.r2AccessKeyId.value) ?? null,
                },
                r2SecretAccessKey: {
                  source: context.resolved.r2SecretAccessKey.source,
                  value: maskSecret(context.resolved.r2SecretAccessKey.value) ?? null,
                },
              },
            },
            null,
            2
          )}\n`
        );
      }));

  addSyncOptions(
    program
    .command('doctor')
    .description('Diagnose common setup issues')
    .action(async (options: CommandRuntimeOptions) => {
      const projectRoot = process.cwd();
      const configPath = getProjectConfigPath(projectRoot);
      const configExists = await fileExists(configPath);
      const skillPath = path.join(projectRoot, '.claude/skills/lazyload-cloud/SKILL.md');
      const skillExists = await fileExists(skillPath);
      const cloudflareWorkerPath = path.join(projectRoot, 'cloudflare/worker.ts');
      const cloudflareExists = await fileExists(cloudflareWorkerPath);
      const context = configExists ? await loadContext(projectRoot, options) : null;
      const config = context?.projectConfig ?? createDefaultProjectConfig(projectRoot);
      const indexExists = await fileExists(path.join(projectRoot, config.outputPath));
      const { authFilePath } = getAuthPaths();

      print(
        JSON.stringify(
          {
            nodeVersion: process.version,
            configExists,
            skillExists,
            cloudflareExists,
            indexExists,
            authFilePath,
            envFilePath: context?.envFilePath ?? null,
            resolvedSources: context
              ? {
                  remoteMode: context.resolved.remoteMode.source,
                  remoteModeValue: context.resolved.remoteMode.value,
                  projectId: context.resolved.projectId.source,
                  apiBaseUrl: context.resolved.apiBaseUrl.source,
                  workerApiToken: context.resolved.workerApiToken.source,
                  cloudflareApiToken: context.resolved.cloudflareApiToken.source,
                  preferRemote: context.resolved.preferRemote.source,
                  uploadSource: context.resolved.uploadSource.source,
                  accountId: context.resolved.accountId.source,
                  d1DatabaseId: context.resolved.d1DatabaseId.source,
                  r2Bucket: context.resolved.r2Bucket.source,
                  r2AccessKeyId: context.resolved.r2AccessKeyId.source,
                  r2SecretAccessKey: context.resolved.r2SecretAccessKey.source,
                  directCredsComplete: isDirectConfigComplete(context.resolved),
                }
              : null,
          },
          null,
          2
        ) + '\n'
      );
    }));

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  await createCli().parseAsync(argv);
}
