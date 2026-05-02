import type {
  CloudStore,
  ClassQueryResult,
  FileListEntry,
  FunctionListResult,
  IndexArtifact,
  ModuleDependenciesResult,
  RemoteAccessConfig,
  RemoteProjectStatus,
  ReferencesResult,
  RelatedContextResult,
  R2BucketLike,
  SuggestedRelatedResult,
  WorkerEnvLike,
} from '../types.js';
import {
  getArchitectureOverview,
  getClass,
  getFunction,
  getModuleDependencies,
  getRelatedContext,
  listFiles,
  listFunctions,
  searchSymbols,
  suggestRelated,
  traceCalls,
  traceTypes,
  findReferences,
} from './indexer.js';

const latestKey = (projectId: string): string => `${projectId}/latest.json`;

function statusFromArtifact(projectId: string, artifact: IndexArtifact): RemoteProjectStatus {
  return {
    projectId,
    updatedAt: artifact.generatedAt,
    symbolCount: artifact.symbols.length,
    fileCount: artifact.files.length,
    schemaVersion: artifact.schemaVersion,
  };
}

async function readArtifact(bucket: R2BucketLike, key: string): Promise<IndexArtifact | null> {
  const object = await bucket.get(key);
  if (!object) {
    return null;
  }
  return JSON.parse(await object.text()) as IndexArtifact;
}

export class InMemoryCloudStore implements CloudStore {
  private readonly data = new Map<string, IndexArtifact>();

  async putIndex(projectId: string, artifact: IndexArtifact): Promise<RemoteProjectStatus> {
    this.data.set(projectId, artifact);
    return statusFromArtifact(projectId, artifact);
  }

  async getIndex(projectId: string): Promise<IndexArtifact | null> {
    return this.data.get(projectId) ?? null;
  }

  async getStatus(projectId: string): Promise<RemoteProjectStatus | null> {
    const artifact = this.data.get(projectId);
    return artifact ? statusFromArtifact(projectId, artifact) : null;
  }
}

export class R2D1CloudStore implements CloudStore {
  public constructor(private readonly env: WorkerEnvLike) {}

  private ensureBucket(): R2BucketLike {
    if (!this.env.INDEX_BUCKET) {
      throw new Error('INDEX_BUCKET binding is not configured');
    }
    return this.env.INDEX_BUCKET;
  }

  async putIndex(projectId: string, artifact: IndexArtifact): Promise<RemoteProjectStatus> {
    const bucket = this.ensureBucket();
    await bucket.put(latestKey(projectId), JSON.stringify(artifact));

    if (this.env.DB) {
      await this.env.DB
        .prepare(
          `INSERT INTO projects (id, updated_at, symbol_count, file_count, schema_version)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             updated_at = excluded.updated_at,
             symbol_count = excluded.symbol_count,
             file_count = excluded.file_count,
             schema_version = excluded.schema_version`
        )
        .bind(projectId, artifact.generatedAt, artifact.symbols.length, artifact.files.length, artifact.schemaVersion)
        .run();

      await this.env.DB
        .prepare(
          `INSERT INTO project_snapshots (project_id, version, object_key, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .bind(projectId, artifact.generatedAt, latestKey(projectId), artifact.generatedAt)
        .run();
    }

    return statusFromArtifact(projectId, artifact);
  }

  async getIndex(projectId: string): Promise<IndexArtifact | null> {
    return readArtifact(this.ensureBucket(), latestKey(projectId));
  }

  async getStatus(projectId: string): Promise<RemoteProjectStatus | null> {
    if (this.env.DB) {
      const row = await this.env.DB
        .prepare(
          `SELECT id as projectId, updated_at as updatedAt, symbol_count as symbolCount, file_count as fileCount, schema_version as schemaVersion
           FROM projects
           WHERE id = ?`
        )
        .bind(projectId)
        .first<RemoteProjectStatus>();

      if (row) {
        return row;
      }
    }

    const artifact = await this.getIndex(projectId);
    return artifact ? statusFromArtifact(projectId, artifact) : null;
  }
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Remote request failed with ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function syncRemoteIndex(
  remote: RemoteAccessConfig,
  artifact: IndexArtifact
): Promise<RemoteProjectStatus> {
  const apiBaseUrl = remote.apiBaseUrl;
  if (!apiBaseUrl) {
    throw new Error('No remote API base URL configured. Use lazyload-cloud auth login or set LAZYLOAD_API_BASE_URL.');
  }

  return fetchJson<RemoteProjectStatus>(`${apiBaseUrl}/api/v1/projects/${remote.projectId}/index`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(remote.workerApiToken ? { authorization: `Bearer ${remote.workerApiToken}` } : {}),
    },
    body: JSON.stringify(artifact),
  });
}

export async function fetchRemoteStatus(remote: RemoteAccessConfig): Promise<RemoteProjectStatus | null> {
  const apiBaseUrl = remote.apiBaseUrl;
  if (!apiBaseUrl) {
    return null;
  }

  return fetchJson<RemoteProjectStatus | null>(`${apiBaseUrl}/api/v1/projects/${remote.projectId}/status`, {
    method: 'GET',
    headers: remote.workerApiToken ? { authorization: `Bearer ${remote.workerApiToken}` } : {},
  });
}

export async function queryRemoteSymbols(
  remote: RemoteAccessConfig,
  query: string,
  limit: number
) {
  const apiBaseUrl = remote.apiBaseUrl;
  if (!apiBaseUrl) {
    throw new Error('No remote API base URL configured.');
  }

  return fetchJson<ReturnType<typeof searchSymbols>>(
    `${apiBaseUrl}/api/v1/projects/${remote.projectId}/query/symbols`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(remote.workerApiToken ? { authorization: `Bearer ${remote.workerApiToken}` } : {}),
      },
      body: JSON.stringify({ query, limit }),
    }
  );
}

export async function queryRemoteFunction(
  remote: RemoteAccessConfig,
  name: string
): Promise<ReturnType<typeof getFunction>> {
  const apiBaseUrl = remote.apiBaseUrl;
  if (!apiBaseUrl) {
    throw new Error('No remote API base URL configured.');
  }

  return fetchJson<ReturnType<typeof getFunction>>(
    `${apiBaseUrl}/api/v1/projects/${remote.projectId}/query/function`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(remote.workerApiToken ? { authorization: `Bearer ${remote.workerApiToken}` } : {}),
      },
      body: JSON.stringify({ name }),
    }
  );
}

export async function queryRemoteTrace(
  remote: RemoteAccessConfig,
  name: string,
  depth: number
): Promise<ReturnType<typeof traceCalls>> {
  const apiBaseUrl = remote.apiBaseUrl;
  if (!apiBaseUrl) {
    throw new Error('No remote API base URL configured.');
  }

  return fetchJson<ReturnType<typeof traceCalls>>(
    `${apiBaseUrl}/api/v1/projects/${remote.projectId}/query/calls`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(remote.workerApiToken ? { authorization: `Bearer ${remote.workerApiToken}` } : {}),
      },
      body: JSON.stringify({ name, depth }),
    }
  );
}

export async function queryRemoteOverview(remote: RemoteAccessConfig) {
  const apiBaseUrl = remote.apiBaseUrl;
  if (!apiBaseUrl) {
    throw new Error('No remote API base URL configured.');
  }

  return fetchJson<ReturnType<typeof getArchitectureOverview>>(
    `${apiBaseUrl}/api/v1/projects/${remote.projectId}/overview`,
    {
      method: 'GET',
      headers: remote.workerApiToken ? { authorization: `Bearer ${remote.workerApiToken}` } : {},
    }
  );
}

export async function queryRemoteListFiles(
  remote: RemoteAccessConfig,
  options: { limit: number; language?: string | undefined; pattern?: string | undefined }
): Promise<FileListEntry[]> {
  if (!remote.apiBaseUrl) {
    throw new Error('No remote API base URL configured.');
  }

  return fetchJson<FileListEntry[]>(`${remote.apiBaseUrl}/api/v1/projects/${remote.projectId}/query/list-files`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(remote.workerApiToken ? { authorization: `Bearer ${remote.workerApiToken}` } : {}),
    },
    body: JSON.stringify(options),
  });
}

export async function queryRemoteListFunctions(
  remote: RemoteAccessConfig,
  options: {
    limit: number;
    language?: string | undefined;
    exported?: boolean | undefined;
    filePattern?: string | undefined;
  }
): Promise<FunctionListResult> {
  if (!remote.apiBaseUrl) {
    throw new Error('No remote API base URL configured.');
  }

  return fetchJson<FunctionListResult>(`${remote.apiBaseUrl}/api/v1/projects/${remote.projectId}/query/list-functions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(remote.workerApiToken ? { authorization: `Bearer ${remote.workerApiToken}` } : {}),
    },
    body: JSON.stringify(options),
  });
}

export async function queryRemoteClass(remote: RemoteAccessConfig, name: string): Promise<ClassQueryResult | null> {
  if (!remote.apiBaseUrl) {
    throw new Error('No remote API base URL configured.');
  }

  return fetchJson<ClassQueryResult | null>(`${remote.apiBaseUrl}/api/v1/projects/${remote.projectId}/query/class`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(remote.workerApiToken ? { authorization: `Bearer ${remote.workerApiToken}` } : {}),
    },
    body: JSON.stringify({ name }),
  });
}

export async function queryRemoteRelatedContext(
  remote: RemoteAccessConfig,
  name: string
): Promise<RelatedContextResult | null> {
  if (!remote.apiBaseUrl) {
    throw new Error('No remote API base URL configured.');
  }

  return fetchJson<RelatedContextResult | null>(`${remote.apiBaseUrl}/api/v1/projects/${remote.projectId}/query/related-context`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(remote.workerApiToken ? { authorization: `Bearer ${remote.workerApiToken}` } : {}),
    },
    body: JSON.stringify({ name }),
  });
}

export async function queryRemoteReferences(remote: RemoteAccessConfig, name: string): Promise<ReferencesResult> {
  if (!remote.apiBaseUrl) {
    throw new Error('No remote API base URL configured.');
  }

  return fetchJson<ReferencesResult>(`${remote.apiBaseUrl}/api/v1/projects/${remote.projectId}/query/references`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(remote.workerApiToken ? { authorization: `Bearer ${remote.workerApiToken}` } : {}),
    },
    body: JSON.stringify({ name }),
  });
}

export async function queryRemoteTypeTrace(
  remote: RemoteAccessConfig,
  name: string,
  depth: number
): Promise<ReturnType<typeof traceTypes>> {
  if (!remote.apiBaseUrl) {
    throw new Error('No remote API base URL configured.');
  }

  return fetchJson<ReturnType<typeof traceTypes>>(`${remote.apiBaseUrl}/api/v1/projects/${remote.projectId}/query/types`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(remote.workerApiToken ? { authorization: `Bearer ${remote.workerApiToken}` } : {}),
    },
    body: JSON.stringify({ name, depth }),
  });
}

export async function queryRemoteModuleDependencies(
  remote: RemoteAccessConfig,
  modulePath: string
): Promise<ModuleDependenciesResult | null> {
  if (!remote.apiBaseUrl) {
    throw new Error('No remote API base URL configured.');
  }

  return fetchJson<ModuleDependenciesResult | null>(
    `${remote.apiBaseUrl}/api/v1/projects/${remote.projectId}/query/module-dependencies`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(remote.workerApiToken ? { authorization: `Bearer ${remote.workerApiToken}` } : {}),
      },
      body: JSON.stringify({ modulePath }),
    }
  );
}

export async function queryRemoteSuggestRelated(
  remote: RemoteAccessConfig,
  name: string,
  limit: number
): Promise<SuggestedRelatedResult> {
  if (!remote.apiBaseUrl) {
    throw new Error('No remote API base URL configured.');
  }

  return fetchJson<SuggestedRelatedResult>(`${remote.apiBaseUrl}/api/v1/projects/${remote.projectId}/query/suggest-related`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(remote.workerApiToken ? { authorization: `Bearer ${remote.workerApiToken}` } : {}),
    },
    body: JSON.stringify({ name, limit }),
  });
}
