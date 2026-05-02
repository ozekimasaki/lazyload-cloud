import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildIndex,
  findReferences,
  getClass,
  getModuleDependencies,
  getRelatedContext,
  listFiles,
  listFunctions,
  suggestRelated,
  traceTypes,
} from '../src/lib/indexer.js';
import { createDefaultProjectConfig } from '../src/lib/project-config.js';
import { InMemoryCloudStore } from '../src/lib/cloud-store.js';
import { handleWorkerRequest } from '../src/worker.js';

async function makeTempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lazyload-cloud-compat-'));
}

describe('13 tool compatibility helpers', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })));
  });

  it('supports the additional compatibility helpers locally and remotely', async () => {
    const root = await makeTempProject();
    tempDirs.push(root);

    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'src', 'models.ts'),
      `export interface UserRecord {
  id: string;
  name: string;
}

export class UserService {
  format(user: UserRecord) {
    return user.name.toUpperCase();
  }
}
`,
      'utf8'
    );
    await fs.writeFile(
      path.join(root, 'src', 'data.ts'),
      `import type { UserRecord } from './models';

export async function fetchUser(id: string): Promise<UserRecord> {
  return { id, name: 'Ada' };
}
`,
      'utf8'
    );
    await fs.writeFile(
      path.join(root, 'src', 'service.ts'),
      `import { fetchUser } from './data';
import { UserService } from './models';

export async function renderUser(id: string) {
  const service = new UserService();
  const user = await fetchUser(id);
  return service.format(user);
}
`,
      'utf8'
    );

    const artifact = await buildIndex(root, createDefaultProjectConfig(root));

    expect(listFiles(artifact).map((entry) => entry.path)).toContain('src/service.ts');
    expect(listFunctions(artifact).functions.some((symbol) => symbol.qualifiedName === 'renderUser')).toBe(true);
    expect(getClass(artifact, 'UserService')?.methods.map((method) => method.name)).toContain('format');
    expect(getRelatedContext(artifact, 'renderUser')?.relatedCalls.map((symbol) => symbol.name)).toContain('fetchUser');
    expect(findReferences(artifact, 'fetchUser').matches.some((match) => match.filePath === 'src/service.ts')).toBe(true);
    expect(traceTypes(artifact, 'UserRecord')?.nodes.some((node) => node.symbol.qualifiedName === 'fetchUser')).toBe(true);
    expect(getModuleDependencies(artifact, 'src/models.ts')?.importedBy).toContain('src/data.ts');
    expect(suggestRelated(artifact, 'renderUser').suggestions.some((entry) => entry.symbol.name === 'fetchUser')).toBe(true);

    const store = new InMemoryCloudStore();
    await store.putIndex('demo', artifact);

    const response = await handleWorkerRequest(
      new Request('https://example.com/api/v1/projects/demo/query/list-files', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ limit: 10 }),
      }),
      {},
      store
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Array<{ path: string }>;
    expect(payload.some((entry) => entry.path === 'src/models.ts')).toBe(true);
  });
});
