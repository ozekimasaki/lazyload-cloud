import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildIndex,
  findReferences,
  getArchitectureOverview,
  getFunction,
  getIndexStats,
  getRelatedContext,
  sanitizeForRemote,
  searchSymbols,
  traceCalls,
} from '../src/lib/indexer.js';
import { createDefaultProjectConfig } from '../src/lib/project-config.js';

async function makeTempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lazyload-cloud-indexer-'));
}

async function writeProjectFiles(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src', 'data.ts'),
    `export async function fetchUser(id: string) {
  return { id, name: 'Ada' };
}

export const formatUser = (name: string) => name.toUpperCase();
`,
    'utf8'
  );
  await fs.writeFile(
    path.join(root, 'src', 'service.ts'),
    `import { fetchUser, formatUser } from './data';

export async function renderUser(id: string) {
  const user = await fetchUser(id);
  return formatUser(user.name);
}
`,
    'utf8'
  );
}

async function removeTempDir(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { recursive: true, force: true });
}

describe('indexer', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(removeTempDir));
  });

  it('indexes symbols and traces calls', async () => {
    const root = await makeTempProject();
    tempDirs.push(root);
    await writeProjectFiles(root);

    const config = createDefaultProjectConfig(root);
    const artifact = await buildIndex(root, config);

    expect(artifact.files).toHaveLength(2);
    expect(artifact.symbols.some((symbol) => symbol.name === 'renderUser')).toBe(true);

    const results = searchSymbols(artifact, 'render');
    expect(results[0]?.symbol.qualifiedName).toBe('renderUser');

    const functionResult = getFunction(artifact, 'renderUser');
    expect(functionResult?.symbol.source).toContain('fetchUser');
    expect(functionResult?.resolvedCalls.map((symbol) => symbol.name)).toContain('fetchUser');

    const trace = traceCalls(artifact, 'renderUser', 2);
    expect(trace?.edges.some((edge) => edge.label === 'fetchUser')).toBe(true);
    expect(trace?.edges.some((edge) => edge.label === 'formatUser')).toBe(true);

    const overview = getArchitectureOverview(artifact);
    expect(overview.totalFiles).toBe(2);
    expect(overview.totalSymbols).toBeGreaterThanOrEqual(3);

    const sanitized = sanitizeForRemote(artifact, config);
    expect(sanitized.symbols.every((symbol) => symbol.source === '')).toBe(true);
  });

  it('indexes python files and exposes them through stats and related context', async () => {
    const root = await makeTempProject();
    tempDirs.push(root);
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'src', 'text_tools.py'),
      `def cleanup(value):
    return value.strip().lower()

def normalize_text(value):
    return cleanup(value)
`,
      'utf8'
    );

    const config = createDefaultProjectConfig(root);
    const artifact = await buildIndex(root, config);

    expect(artifact.files.some((file) => file.language === 'python' && file.path === 'src/text_tools.py')).toBe(true);
    expect(artifact.symbols.some((symbol) => symbol.language === 'python' && symbol.name === 'normalize_text')).toBe(true);
    expect(searchSymbols(artifact, 'normalize')[0]?.symbol.name).toBe('normalize_text');
    expect(getRelatedContext(artifact, 'normalize_text')?.relatedCalls.map((symbol) => symbol.name)).toContain('cleanup');
    expect(findReferences(artifact, 'cleanup').matches.some((match) => match.filePath === 'src/text_tools.py')).toBe(true);
    expect(getIndexStats(artifact).byLanguage.python.files).toBe(1);
  });
});
