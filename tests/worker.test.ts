import { describe, expect, it } from 'vitest';
import { InMemoryCloudStore } from '../src/lib/cloud-store.js';
import type { IndexArtifact } from '../src/types.js';
import { handleWorkerRequest } from '../src/worker.js';

const artifact: IndexArtifact = {
  schemaVersion: '1',
  generatedAt: '2026-05-02T00:00:00.000Z',
  rootDir: '/workspace',
  include: ['**/*.ts'],
  exclude: ['**/node_modules/**'],
  files: [
    {
      path: 'src/app.ts',
      language: 'typescript',
      imports: [],
      symbolIds: ['src/app.ts#hello'],
      hash: 'abc123',
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
      signature: 'export function hello(name: string) {',
      startLine: 1,
      endLine: 3,
      source: 'export function hello(name: string) { return `hi ${name}`; }',
      calls: [],
      imports: [],
    },
  ],
};

describe('worker handler', () => {
  it('stores and queries a project index', async () => {
    const store = new InMemoryCloudStore();
    const env = { API_TOKEN: 'secret' };

    const putResponse = await handleWorkerRequest(
      new Request('https://example.com/api/v1/projects/demo/index', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer secret',
        },
        body: JSON.stringify(artifact),
      }),
      env,
      store
    );
    expect(putResponse.status).toBe(200);

    const statusResponse = await handleWorkerRequest(
      new Request('https://example.com/api/v1/projects/demo/status'),
      env,
      store
    );
    expect(statusResponse.status).toBe(200);
    const status = (await statusResponse.json()) as { symbolCount: number };
    expect(status.symbolCount).toBe(1);

    const statsResponse = await handleWorkerRequest(
      new Request('https://example.com/api/v1/projects/demo/stats'),
      env,
      store
    );
    expect(statsResponse.status).toBe(200);
    const stats = (await statsResponse.json()) as { totalFiles: number; totalSymbols: number };
    expect(stats.totalFiles).toBe(1);
    expect(stats.totalSymbols).toBe(1);

    const queryResponse = await handleWorkerRequest(
      new Request('https://example.com/api/v1/projects/demo/query/symbols', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer secret',
        },
        body: JSON.stringify({ query: 'hello', limit: 5 }),
      }),
      env,
      store
    );
    expect(queryResponse.status).toBe(200);
    const results = (await queryResponse.json()) as Array<{ symbol: { name: string } }>;
    expect(results[0]?.symbol.name).toBe('hello');
  });
});
