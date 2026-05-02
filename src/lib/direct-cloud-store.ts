/**
 * Direct Cloudflare store: accesses D1 and R2 from the CLI without a deployed Worker.
 *
 * D1 is accessed via the Cloudflare REST API.
 * R2 is accessed via the S3-compatible API using @aws-sdk/client-s3.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { CloudStore, DirectCloudflareConfig, IndexArtifact, RemoteProjectStatus } from '../types.js';

const D1_API_BASE = 'https://api.cloudflare.com/client/v4';

interface D1QueryResult<T> {
  result: Array<{
    results: T[];
    success: boolean;
    meta: Record<string, unknown>;
  }>;
  success: boolean;
  errors: Array<{ message: string }>;
}

async function d1Query<T>(
  config: DirectCloudflareConfig,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const url = `${D1_API_BASE}/accounts/${config.accountId}/d1/database/${config.d1DatabaseId}/query`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.cloudflareApiToken}`,
    },
    body: JSON.stringify({ sql, params }),
  });

  if (!response.ok) {
    throw new Error(`D1 query failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as D1QueryResult<T>;

  if (!body.success) {
    const messages = body.errors.map((e) => e.message).join('; ');
    throw new Error(`D1 query returned errors: ${messages}`);
  }

  return body.result[0]?.results ?? [];
}

function latestKey(projectId: string): string {
  return `${projectId}/latest.json`;
}

function statusFromArtifact(projectId: string, artifact: IndexArtifact): RemoteProjectStatus {
  return {
    projectId,
    updatedAt: artifact.generatedAt,
    symbolCount: artifact.symbols.length,
    fileCount: artifact.files.length,
    schemaVersion: artifact.schemaVersion,
  };
}

export class DirectCloudflareStore implements CloudStore {
  private readonly s3: S3Client;

  public constructor(private readonly config: DirectCloudflareConfig) {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.r2AccessKeyId,
        secretAccessKey: config.r2SecretAccessKey,
      },
    });
  }

  async putIndex(projectId: string, artifact: IndexArtifact): Promise<RemoteProjectStatus> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.r2Bucket,
        Key: latestKey(projectId),
        Body: JSON.stringify(artifact),
        ContentType: 'application/json',
      })
    );

    if (this.config.cloudflareApiToken) {
      await d1Query(this.config,
        `INSERT INTO projects (id, updated_at, symbol_count, file_count, schema_version)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           updated_at = excluded.updated_at,
           symbol_count = excluded.symbol_count,
           file_count = excluded.file_count,
           schema_version = excluded.schema_version`,
        [projectId, artifact.generatedAt, artifact.symbols.length, artifact.files.length, artifact.schemaVersion]
      );

      await d1Query(this.config,
        `INSERT INTO project_snapshots (project_id, version, object_key, created_at)
         VALUES (?, ?, ?, ?)`,
        [projectId, artifact.generatedAt, latestKey(projectId), artifact.generatedAt]
      );
    }

    return statusFromArtifact(projectId, artifact);
  }

  async getIndex(projectId: string): Promise<IndexArtifact | null> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.config.r2Bucket,
          Key: latestKey(projectId),
        })
      );

      const body = response.Body;
      if (!body) {
        return null;
      }

      const text = await body.transformToString('utf-8');
      return JSON.parse(text) as IndexArtifact;
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  }

  async getStatus(projectId: string): Promise<RemoteProjectStatus | null> {
    if (this.config.cloudflareApiToken) {
      type ProjectRow = {
        projectId: string;
        updatedAt: string;
        symbolCount: number;
        fileCount: number;
        schemaVersion: string;
      };

      const rows = await d1Query<ProjectRow>(
        this.config,
        `SELECT id as projectId, updated_at as updatedAt, symbol_count as symbolCount,
                file_count as fileCount, schema_version as schemaVersion
         FROM projects
         WHERE id = ?`,
        [projectId]
      );

      if (rows.length > 0) {
        return rows[0]!;
      }
    }

    const artifact = await this.getIndex(projectId);
    return artifact ? statusFromArtifact(projectId, artifact) : null;
  }
}

/**
 * Creates a DirectCloudflareStore from a DirectCloudflareConfig.
 */
export function createDirectCloudStore(config: DirectCloudflareConfig): DirectCloudflareStore {
  return new DirectCloudflareStore(config);
}
