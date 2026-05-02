import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
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
import type { OutputFormat, ProjectConfig, RuntimeOverrides } from './types.js';

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
    .option('--project-id <id>', 'Override the remote project id')
    .option('--prefer-remote <true|false>', 'Override remote preference');
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

function print(output: string): void {
  process.stdout.write(output);
}

export function createCli(): Command {
  const program = new Command();

  program
    .name('lazyload-cloud')
    .description('Cloudflare-backed code context CLI for Agent Skills')
    .version('0.1.0');

  program
    .command('init')
    .description('Create project config, skill assets, and Cloudflare scaffold')
    .option('--project-id <id>', 'Override the remote project id')
    .action(async (options: { projectId?: string }) => {
      const projectRoot = process.cwd();
      const config = createDefaultProjectConfig(projectRoot);
      if (options.projectId) {
        config.remote.projectId = options.projectId;
      }

      await saveProjectConfig(projectRoot, config);
      await updateGitignore(projectRoot);
      const skillFiles = await createSkillAssets(projectRoot, config);
      const cloudflareFiles = await createCloudflareScaffold(projectRoot, config);

      print(
        JSON.stringify(
          {
            configPath: getProjectConfigPath(projectRoot),
            skillFiles,
            cloudflareFiles,
          },
          null,
          2
        ) + '\n'
      );
    });

  const auth = program.command('auth').description('Manage user-level authentication settings');

  auth
    .command('login')
    .description('Store Cloudflare API credentials in user config')
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
        throw new Error('No API base URL resolved. Pass --api-base-url or set LAZYLOAD_API_BASE_URL.');
      }
      if (!resolved.workerApiToken.value && !resolved.cloudflareApiToken.value) {
        throw new Error(
          'No credential resolved. Pass --worker-token, --cloudflare-api-token, LAZYLOAD_API_TOKEN, or CLOUDFLARE_API_TOKEN.'
        );
      }

      const filePath = await saveUserConfig({
        schemaVersion: 1,
        apiBaseUrl: resolved.apiBaseUrl.value,
        workerApiToken: resolved.workerApiToken.value,
        cloudflareApiToken: resolved.cloudflareApiToken.value,
      });
      print(
        `${JSON.stringify(
          {
            saved: filePath,
            apiBaseUrlSource: resolved.apiBaseUrl.source,
            workerApiTokenSource: resolved.workerApiToken.source,
            cloudflareApiTokenSource: resolved.cloudflareApiToken.source,
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
        throw new Error('No API base URL resolved. Pass --api-base-url or set LAZYLOAD_API_BASE_URL.');
      }
      if (!resolved.workerApiToken.value && !resolved.cloudflareApiToken.value) {
        throw new Error(
          'No credential resolved. Pass --worker-token, --cloudflare-api-token, LAZYLOAD_API_TOKEN, or CLOUDFLARE_API_TOKEN.'
        );
      }

      const filePath = await saveUserConfig({
        schemaVersion: 1,
        apiBaseUrl: resolved.apiBaseUrl.value,
        workerApiToken: resolved.workerApiToken.value,
        cloudflareApiToken: resolved.cloudflareApiToken.value,
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
      .action(async (options: { limit: string; language?: 'typescript' | 'javascript'; pattern?: string; remote: boolean; format: string } & CommandRuntimeOptions) => {
        const projectRoot = process.cwd();
        const context = await loadContext(projectRoot, options);
        const config = context.projectConfig;
        const limit = Number.parseInt(options.limit, 10);
        const format = readFormat(options.format);

        if (options.remote || config.remote.preferRemote) {
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
            language?: 'typescript' | 'javascript';
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
        print(`${JSON.stringify(await syncRemoteIndex(remoteConfigFromResolvedContext(context), sanitized), null, 2)}\n`);
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
        print(formatOverview(await queryRemoteOverview(remoteConfigFromResolvedContext(context)), format));
        return;
      }

      const artifact = await resolveIndex(projectRoot, config);
      print(formatOverview(getArchitectureOverview(artifact), format));
    }));

  addSyncOptions(
    program
    .command('sync')
    .description('Upload the local index to the configured Cloudflare Worker')
    .action(async (options: CommandRuntimeOptions) => {
      const projectRoot = process.cwd();
      const context = await loadContext(projectRoot, options);
      const config = context.projectConfig;
      const artifact = await resolveIndex(projectRoot, config);
      const sanitized = sanitizeForRemote(artifact, config);
      print(`${JSON.stringify(await syncRemoteIndex(remoteConfigFromResolvedContext(context), sanitized), null, 2)}\n`);
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
      const remoteStatus = await fetchRemoteStatus(remoteConfigFromResolvedContext(context));

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
                  projectId: context.resolved.projectId.source,
                  apiBaseUrl: context.resolved.apiBaseUrl.source,
                  workerApiToken: context.resolved.workerApiToken.source,
                  cloudflareApiToken: context.resolved.cloudflareApiToken.source,
                  preferRemote: context.resolved.preferRemote.source,
                  uploadSource: context.resolved.uploadSource.source,
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
