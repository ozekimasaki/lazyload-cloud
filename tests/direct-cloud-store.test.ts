import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => input),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => input),
}));

import { DirectCloudflareStore, createDirectCloudStore } from '../src/lib/direct-cloud-store.js';
import {
  isDirectConfigComplete,
  directConfigFromResolved,
  createCloudStoreForDirectMode,
} from '../src/lib/cloud-store-factory.js';
import type { DirectCloudflareConfig, IndexArtifact, ResolvedRuntimeConfig } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const minimalArtifact: IndexArtifact = {
  schemaVersion: '2',
  generatedAt: '2025-01-01T00:00:00.000Z',
  rootDir: '/workspace',
  directories: ['.'],
  include: ['**/*.ts'],
  exclude: ['**/node_modules/**'],
  files: [
    {
      path: 'src/app.ts',
      language: 'typescript',
      imports: [],
      symbolIds: ['src/app.ts#hello'],
      hash: 'abc123',
      size: 42,
    },
  ],
  symbols: [
    {
      id: 'src/app.ts#hello',
      name: 'hello',
      qualifiedName: 'hello',
      kind: 'function',
      language: 'typescript',
      filePath: 'src/app.ts',
      exported: true,
      signature: 'export function hello(): void',
      startLine: 1,
      endLine: 3,
      source: 'export function hello(): void {}',
      calls: [],
      imports: [],
      parameters: [],
      typeReferences: [],
      extendsTypes: [],
      implementsTypes: [],
    },
  ],
  references: [],
  callGraph: [],
  typeRelationships: [],
  stats: {
    totalFiles: 1,
    totalSymbols: 1,
    totalFunctions: 1,
    totalClasses: 0,
    totalInterfaces: 0,
    totalVariables: 0,
    totalTypes: 0,
    byLanguage: {
      typescript: { files: 1, functions: 1, classes: 0, interfaces: 0, typeAliases: 0, variables: 0 },
      javascript: { files: 0, functions: 0, classes: 0, interfaces: 0, typeAliases: 0, variables: 0 },
      python: { files: 0, functions: 0, classes: 0, interfaces: 0, typeAliases: 0, variables: 0 },
    },
    generatedAt: '2025-01-01T00:00:00.000Z',
    artifactSizeBytes: 500,
  },
};

const directConfig: DirectCloudflareConfig = {
  accountId: 'test-account-id',
  d1DatabaseId: 'test-d1-db-id',
  r2Bucket: 'test-r2-bucket',
  r2AccessKeyId: 'test-r2-key-id',
  r2SecretAccessKey: 'test-r2-secret',
};

// Builds a fully-populated resolved config for testing factory helpers.
function makeResolved(
  overrides: Partial<ResolvedRuntimeConfig['resolved']> = {}
): ResolvedRuntimeConfig['resolved'] {
  return {
    projectId: { value: 'my-project', source: 'default' },
    apiBaseUrl: { value: undefined, source: 'absent' },
    workerApiToken: { value: undefined, source: 'absent' },
    cloudflareApiToken: { value: undefined, source: 'absent' },
    preferRemote: { value: false, source: 'default' },
    uploadSource: { value: false, source: 'default' },
    remoteMode: { value: 'direct', source: 'default' },
    accountId: { value: 'acct-123', source: 'env' },
    d1DatabaseId: { value: 'db-abc', source: 'env' },
    r2Bucket: { value: 'my-bucket', source: 'env' },
    r2AccessKeyId: { value: 'key-id-xyz', source: 'env' },
    r2SecretAccessKey: { value: 'secret-xyz', source: 'env' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isDirectConfigComplete
// ---------------------------------------------------------------------------

describe('isDirectConfigComplete', () => {
  it('returns true when all required direct credentials are present', () => {
    expect(isDirectConfigComplete(makeResolved())).toBe(true);
  });

  it('returns false when accountId is missing', () => {
    expect(isDirectConfigComplete(makeResolved({ accountId: { value: undefined, source: 'absent' } }))).toBe(false);
  });

  it('returns false when d1DatabaseId is missing', () => {
    expect(isDirectConfigComplete(makeResolved({ d1DatabaseId: { value: undefined, source: 'absent' } }))).toBe(false);
  });

  it('returns false when r2Bucket is missing', () => {
    expect(isDirectConfigComplete(makeResolved({ r2Bucket: { value: undefined, source: 'absent' } }))).toBe(false);
  });

  it('returns false when r2AccessKeyId is missing', () => {
    expect(isDirectConfigComplete(makeResolved({ r2AccessKeyId: { value: undefined, source: 'absent' } }))).toBe(false);
  });

  it('returns false when r2SecretAccessKey is missing', () => {
    expect(isDirectConfigComplete(makeResolved({ r2SecretAccessKey: { value: undefined, source: 'absent' } }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// directConfigFromResolved
// ---------------------------------------------------------------------------

describe('directConfigFromResolved', () => {
  it('returns a DirectCloudflareConfig with all fields when complete', () => {
    const cfg = directConfigFromResolved(makeResolved({ cloudflareApiToken: { value: 'cf-token', source: 'env' } }));
    expect(cfg.accountId).toBe('acct-123');
    expect(cfg.d1DatabaseId).toBe('db-abc');
    expect(cfg.r2Bucket).toBe('my-bucket');
    expect(cfg.r2AccessKeyId).toBe('key-id-xyz');
    expect(cfg.r2SecretAccessKey).toBe('secret-xyz');
    expect(cfg.cloudflareApiToken).toBe('cf-token');
  });

  it('sets cloudflareApiToken to undefined when absent', () => {
    const cfg = directConfigFromResolved(makeResolved());
    expect(cfg.cloudflareApiToken).toBeUndefined();
  });

  it('throws a descriptive error listing every missing field', () => {
    const incomplete = makeResolved({
      accountId: { value: undefined, source: 'absent' },
      d1DatabaseId: { value: undefined, source: 'absent' },
      r2SecretAccessKey: { value: undefined, source: 'absent' },
    });
    expect(() => directConfigFromResolved(incomplete)).toThrowError(/accountId.*LAZYLOAD_ACCOUNT_ID/);
    expect(() => directConfigFromResolved(incomplete)).toThrowError(/d1DatabaseId.*LAZYLOAD_D1_DATABASE_ID/);
    expect(() => directConfigFromResolved(incomplete)).toThrowError(/r2SecretAccessKey.*LAZYLOAD_R2_SECRET_ACCESS_KEY/);
  });
});

// ---------------------------------------------------------------------------
// createCloudStoreForDirectMode
// ---------------------------------------------------------------------------

describe('createCloudStoreForDirectMode', () => {
  beforeEach(() => {
    vi.mocked(S3Client).mockImplementation(() => ({ send: vi.fn() }) as unknown as S3Client);
  });

  it('creates a DirectCloudflareStore from resolved config', () => {
    const store = createCloudStoreForDirectMode(makeResolved());
    expect(store).toBeInstanceOf(DirectCloudflareStore);
  });

  it('throws when credentials are incomplete', () => {
    const incomplete = makeResolved({ accountId: { value: undefined, source: 'absent' } });
    expect(() => createCloudStoreForDirectMode(incomplete)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createDirectCloudStore
// ---------------------------------------------------------------------------

describe('createDirectCloudStore factory', () => {
  beforeEach(() => {
    vi.mocked(S3Client).mockImplementation(() => ({ send: vi.fn() }) as unknown as S3Client);
  });

  it('creates a DirectCloudflareStore instance', () => {
    const store = createDirectCloudStore(directConfig);
    expect(store).toBeInstanceOf(DirectCloudflareStore);
  });
});

// ---------------------------------------------------------------------------
// DirectCloudflareStore – putIndex
// ---------------------------------------------------------------------------

describe('DirectCloudflareStore.putIndex', () => {
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSend = vi.fn();
    vi.mocked(S3Client).mockImplementation(() => ({ send: mockSend }) as unknown as S3Client);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads artifact to R2 and returns correct status', async () => {
    mockSend.mockResolvedValueOnce({});
    const store = new DirectCloudflareStore({ ...directConfig });
    const status = await store.putIndex('my-project', minimalArtifact);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(status.projectId).toBe('my-project');
    expect(status.symbolCount).toBe(1);
    expect(status.fileCount).toBe(1);
    expect(status.schemaVersion).toBe('2');
    expect(status.updatedAt).toBe(minimalArtifact.generatedAt);
  });

  it('skips D1 writes when cloudflareApiToken is absent', async () => {
    mockSend.mockResolvedValueOnce({});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const store = new DirectCloudflareStore({ ...directConfig }); // no cloudflareApiToken
    await store.putIndex('my-project', minimalArtifact);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('writes to D1 when cloudflareApiToken is set', async () => {
    mockSend.mockResolvedValueOnce({});
    const d1Success = { success: true, result: [{ results: [], success: true, meta: {} }], errors: [] };
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => d1Success })
      .mockResolvedValueOnce({ ok: true, json: async () => d1Success });
    vi.stubGlobal('fetch', fetchSpy);

    const store = new DirectCloudflareStore({ ...directConfig, cloudflareApiToken: 'cf-token' });
    await store.putIndex('my-project', minimalArtifact);

    expect(mockSend).toHaveBeenCalledTimes(1);
    // projects upsert + project_snapshots insert
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws when D1 API returns a non-ok HTTP status', async () => {
    mockSend.mockResolvedValueOnce({});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden' }));

    const store = new DirectCloudflareStore({ ...directConfig, cloudflareApiToken: 'cf-token' });
    await expect(store.putIndex('my-project', minimalArtifact)).rejects.toThrow('D1 query failed: 403 Forbidden');
  });
});

// ---------------------------------------------------------------------------
// DirectCloudflareStore – getIndex
// ---------------------------------------------------------------------------

describe('DirectCloudflareStore.getIndex', () => {
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSend = vi.fn();
    vi.mocked(S3Client).mockImplementation(() => ({ send: mockSend }) as unknown as S3Client);
  });

  it('returns parsed artifact when found in R2', async () => {
    mockSend.mockResolvedValueOnce({
      Body: { transformToString: async () => JSON.stringify(minimalArtifact) },
    });

    const store = new DirectCloudflareStore(directConfig);
    const result = await store.getIndex('my-project');

    expect(result).not.toBeNull();
    expect(result!.symbols).toHaveLength(1);
    expect(result!.symbols[0]!.name).toBe('hello');
  });

  it('returns null when key does not exist in R2', async () => {
    const noSuchKeyError = Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    mockSend.mockRejectedValueOnce(noSuchKeyError);

    const store = new DirectCloudflareStore(directConfig);
    const result = await store.getIndex('nonexistent-project');

    expect(result).toBeNull();
  });

  it('returns null when R2 response has no Body', async () => {
    mockSend.mockResolvedValueOnce({ Body: null });

    const store = new DirectCloudflareStore(directConfig);
    const result = await store.getIndex('my-project');

    expect(result).toBeNull();
  });

  it('re-throws non-NoSuchKey S3 errors', async () => {
    mockSend.mockRejectedValueOnce(new Error('Network connection reset'));

    const store = new DirectCloudflareStore(directConfig);
    await expect(store.getIndex('my-project')).rejects.toThrow('Network connection reset');
  });
});

// ---------------------------------------------------------------------------
// DirectCloudflareStore – getStatus
// ---------------------------------------------------------------------------

describe('DirectCloudflareStore.getStatus', () => {
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSend = vi.fn();
    vi.mocked(S3Client).mockImplementation(() => ({ send: mockSend }) as unknown as S3Client);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('queries D1 when cloudflareApiToken is set and returns status', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        result: [{
          results: [{
            projectId: 'my-project',
            updatedAt: '2025-01-01T00:00:00.000Z',
            symbolCount: 5,
            fileCount: 3,
            schemaVersion: '2',
          }],
          success: true,
          meta: {},
        }],
        errors: [],
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const store = new DirectCloudflareStore({ ...directConfig, cloudflareApiToken: 'cf-token' });
    const status = await store.getStatus('my-project');

    expect(status).not.toBeNull();
    expect(status!.symbolCount).toBe(5);
    expect(status!.fileCount).toBe(3);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('falls back to R2 when D1 returns no rows', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        result: [{ results: [], success: true, meta: {} }],
        errors: [],
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    mockSend.mockResolvedValueOnce({
      Body: { transformToString: async () => JSON.stringify(minimalArtifact) },
    });

    const store = new DirectCloudflareStore({ ...directConfig, cloudflareApiToken: 'cf-token' });
    const status = await store.getStatus('my-project');

    expect(status).not.toBeNull();
    expect(status!.symbolCount).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('falls back to R2 when no cloudflareApiToken is set', async () => {
    mockSend.mockResolvedValueOnce({
      Body: { transformToString: async () => JSON.stringify(minimalArtifact) },
    });

    const store = new DirectCloudflareStore(directConfig); // no token
    const status = await store.getStatus('my-project');

    expect(status).not.toBeNull();
    expect(status!.symbolCount).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('returns null when no cloudflareApiToken and R2 returns NoSuchKey', async () => {
    const noSuchKeyError = Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    mockSend.mockRejectedValueOnce(noSuchKeyError);

    const store = new DirectCloudflareStore(directConfig);
    const status = await store.getStatus('my-project');

    expect(status).toBeNull();
  });
});
