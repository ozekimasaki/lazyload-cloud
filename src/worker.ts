import type { CloudStore, IndexArtifact, SourceLanguage, WorkerEnvLike } from './types.js';
import { InMemoryCloudStore, R2D1CloudStore } from './lib/cloud-store.js';
import {
  findReferences,
  getArchitectureOverview,
  getClass,
  getFunction,
  getIndexStats,
  getModuleDependencies,
  getRelatedContext,
  listFiles,
  listFunctions,
  searchSymbols,
  suggestRelated,
  traceCalls,
  traceTypes,
} from './lib/indexer.js';

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

function unauthorized(): Response {
  return json({ error: 'Unauthorized' }, { status: 401 });
}

function notFound(): Response {
  return json({ error: 'Not found' }, { status: 404 });
}

async function parseBody<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

function requiresAuth(request: Request, env: WorkerEnvLike): boolean {
  return request.method !== 'GET' && typeof env.API_TOKEN === 'string' && env.API_TOKEN.length > 0;
}

function isAuthorized(request: Request, env: WorkerEnvLike): boolean {
  if (!requiresAuth(request, env)) {
    return true;
  }
  return request.headers.get('authorization') === `Bearer ${env.API_TOKEN}`;
}

function resolveStore(env: WorkerEnvLike, store?: CloudStore): CloudStore {
  if (store) {
    return store;
  }
  if (env.INDEX_BUCKET) {
    return new R2D1CloudStore(env);
  }
  return new InMemoryCloudStore();
}

export async function handleWorkerRequest(request: Request, env: WorkerEnvLike, store?: CloudStore): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return unauthorized();
  }

  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter(Boolean);
  const activeStore = resolveStore(env, store);

  if (segments.length >= 4 && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'projects') {
    const projectId = segments[3]!;
    const action = segments[4];

    if (request.method === 'POST' && action === 'index') {
      const artifact = await parseBody<IndexArtifact>(request);
      return json(await activeStore.putIndex(projectId, artifact));
    }

    if (request.method === 'GET' && action === 'status') {
      return json(await activeStore.getStatus(projectId));
    }

    if (request.method === 'GET' && action === 'overview') {
      const artifact = await activeStore.getIndex(projectId);
      if (!artifact) {
        return notFound();
      }
      return json(getArchitectureOverview(artifact));
    }

    if (request.method === 'GET' && action === 'stats') {
      const artifact = await activeStore.getIndex(projectId);
      if (!artifact) {
        return notFound();
      }
      return json(getIndexStats(artifact));
    }

    if (request.method === 'POST' && action === 'query') {
      const artifact = await activeStore.getIndex(projectId);
      if (!artifact) {
        return notFound();
      }

      const mode = segments[5];
      if (mode === 'symbols') {
        const body = await parseBody<{ query: string; limit?: number }>(request);
        return json(searchSymbols(artifact, body.query, { limit: body.limit ?? 20 }));
      }
      if (mode === 'list-files') {
        const body = await parseBody<{ limit?: number; language?: SourceLanguage; pattern?: string }>(request);
        return json(listFiles(artifact, { limit: body.limit ?? 50, language: body.language, pattern: body.pattern }));
      }
      if (mode === 'list-functions') {
        const body = await parseBody<{ limit?: number; language?: SourceLanguage; exported?: boolean; filePattern?: string }>(
          request
        );
        return json(
          listFunctions(artifact, {
            limit: body.limit ?? 50,
            language: body.language,
            exported: body.exported,
            filePattern: body.filePattern,
          })
        );
      }
      if (mode === 'function') {
        const body = await parseBody<{ name: string }>(request);
        return json(getFunction(artifact, body.name));
      }
      if (mode === 'class') {
        const body = await parseBody<{ name: string }>(request);
        return json(getClass(artifact, body.name));
      }
      if (mode === 'related-context') {
        const body = await parseBody<{ name: string }>(request);
        return json(getRelatedContext(artifact, body.name));
      }
      if (mode === 'references') {
        const body = await parseBody<{ name: string }>(request);
        return json(findReferences(artifact, body.name));
      }
      if (mode === 'calls') {
        const body = await parseBody<{ name: string; depth?: number }>(request);
        return json(traceCalls(artifact, body.name, body.depth ?? 2));
      }
      if (mode === 'types') {
        const body = await parseBody<{ name: string; depth?: number }>(request);
        return json(traceTypes(artifact, body.name, body.depth ?? 2));
      }
      if (mode === 'module-dependencies') {
        const body = await parseBody<{ modulePath: string }>(request);
        return json(getModuleDependencies(artifact, body.modulePath));
      }
      if (mode === 'suggest-related') {
        const body = await parseBody<{ name: string; limit?: number }>(request);
        return json(suggestRelated(artifact, body.name, body.limit ?? 10));
      }
    }
  }

  return notFound();
}

const worker = {
  fetch(request: Request, env: WorkerEnvLike): Promise<Response> {
    return handleWorkerRequest(request, env);
  },
};

export default worker;
