import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import ts from 'typescript';
import type {
  ArchitectureOverview,
  CallTrace,
  ClassQueryResult,
  FileListEntry,
  FunctionQueryResult,
  FunctionListResult,
  IndexedFile,
  IndexedSymbol,
  IndexArtifact,
  ModuleDependenciesResult,
  ProjectConfig,
  ReferenceMatch,
  ReferencesResult,
  RelatedContextResult,
  SearchOptions,
  SearchResult,
  SourceLanguage,
  SuggestedRelatedResult,
  SymbolKind,
  TraceEdge,
  TypeTrace,
} from '../types.js';

function toPosix(input: string): string {
  return input.split(path.sep).join('/');
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath);
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function languageForPath(filePath: string): SourceLanguage {
  const ext = path.extname(filePath);
  return ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs' ? 'javascript' : 'typescript';
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return (modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function lineRange(sourceFile: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { startLine: start, endLine: end };
}

function signatureFromNode(sourceText: string, sourceFile: ts.SourceFile, node: ts.Node): string {
  const start = node.getStart(sourceFile);
  const firstLine = sourceText.slice(start, node.getEnd()).split('\n', 1)[0] ?? '';
  return firstLine.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function sourceFromNode(sourceText: string, sourceFile: ts.SourceFile, node: ts.Node): string {
  return sourceText.slice(node.getStart(sourceFile), node.getEnd()).trim();
}

function callNameFromExpression(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }

  if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text;
  }

  return null;
}

function collectCalls(node: ts.Node): string[] {
  const calls = new Set<string>();

  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current)) {
      const callName = callNameFromExpression(current.expression);
      if (callName) {
        calls.add(callName);
      }
    }
    ts.forEachChild(current, visit);
  };

  ts.forEachChild(node, visit);
  return [...calls].sort();
}

function createSymbolRecord(params: {
  id: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  language: SourceLanguage;
  filePath: string;
  exported: boolean;
  signature: string;
  startLine: number;
  endLine: number;
  source: string;
  calls: string[];
  imports: string[];
  containerName?: string;
}): IndexedSymbol {
  return params;
}

function collectImportSpecifiers(sourceFile: ts.SourceFile): string[] {
  const imports: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text);
    }
  }
  return imports.sort();
}

function parseFile(relPath: string, sourceText: string): { file: IndexedFile; symbols: IndexedSymbol[] } {
  const normalizedPath = toPosix(relPath);
  const language = languageForPath(relPath);
  const sourceFile = ts.createSourceFile(relPath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForPath(relPath));
  const imports = collectImportSpecifiers(sourceFile);
  const symbols: IndexedSymbol[] = [];

  const pushSymbol = (params: Omit<IndexedSymbol, 'imports' | 'language' | 'filePath'>): void => {
    symbols.push(
      createSymbolRecord({
        ...params,
        language,
        filePath: normalizedPath,
        imports,
      })
    );
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const { startLine, endLine } = lineRange(sourceFile, statement);
      const name = statement.name.text;
      pushSymbol({
        id: `${normalizedPath}#${name}`,
        name,
        qualifiedName: name,
        kind: 'function',
        exported: isExported(statement),
        signature: signatureFromNode(sourceText, sourceFile, statement),
        startLine,
        endLine,
        source: sourceFromNode(sourceText, sourceFile, statement),
        calls: collectCalls(statement),
      });
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      const className = statement.name.text;
      const classRange = lineRange(sourceFile, statement);
      pushSymbol({
        id: `${normalizedPath}#${className}`,
        name: className,
        qualifiedName: className,
        kind: 'class',
        exported: isExported(statement),
        signature: signatureFromNode(sourceText, sourceFile, statement),
        startLine: classRange.startLine,
        endLine: classRange.endLine,
        source: sourceFromNode(sourceText, sourceFile, statement),
        calls: collectCalls(statement),
      });

      for (const member of statement.members) {
        if ((ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) && member.name && ts.isIdentifier(member.name)) {
          const methodName = member.name.text;
          const range = lineRange(sourceFile, member);
          pushSymbol({
            id: `${normalizedPath}#${className}.${methodName}`,
            name: methodName,
            qualifiedName: `${className}.${methodName}`,
            kind: 'method',
            exported: isExported(statement),
            signature: signatureFromNode(sourceText, sourceFile, member),
            startLine: range.startLine,
            endLine: range.endLine,
            source: sourceFromNode(sourceText, sourceFile, member),
            calls: collectCalls(member),
            containerName: className,
          });
        }
      }
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      const range = lineRange(sourceFile, statement);
      pushSymbol({
        id: `${normalizedPath}#${statement.name.text}`,
        name: statement.name.text,
        qualifiedName: statement.name.text,
        kind: 'interface',
        exported: isExported(statement),
        signature: signatureFromNode(sourceText, sourceFile, statement),
        startLine: range.startLine,
        endLine: range.endLine,
        source: sourceFromNode(sourceText, sourceFile, statement),
        calls: [],
      });
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      const range = lineRange(sourceFile, statement);
      pushSymbol({
        id: `${normalizedPath}#${statement.name.text}`,
        name: statement.name.text,
        qualifiedName: statement.name.text,
        kind: 'type',
        exported: isExported(statement),
        signature: signatureFromNode(sourceText, sourceFile, statement),
        startLine: range.startLine,
        endLine: range.endLine,
        source: sourceFromNode(sourceText, sourceFile, statement),
        calls: [],
      });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue;
        }
        const initializer = declaration.initializer;
        const isFunctionLike = ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer);
        if (!isFunctionLike) {
          continue;
        }

        const name = declaration.name.text;
        const range = lineRange(sourceFile, declaration);
        pushSymbol({
          id: `${normalizedPath}#${name}`,
          name,
          qualifiedName: name,
          kind: 'function',
          exported: isExported(statement),
          signature: signatureFromNode(sourceText, sourceFile, declaration),
          startLine: range.startLine,
          endLine: range.endLine,
          source: sourceFromNode(sourceText, sourceFile, declaration),
          calls: collectCalls(initializer),
        });
      }
    }
  }

  return {
    file: {
      path: normalizedPath,
      language,
      imports,
      symbolIds: symbols.map((symbol) => symbol.id),
      hash: hashContent(sourceText),
    },
    symbols,
  };
}

export async function buildIndex(projectRoot: string, config: ProjectConfig): Promise<IndexArtifact> {
  const files = await fg(config.include, {
    cwd: projectRoot,
    ignore: config.exclude,
    onlyFiles: true,
    absolute: false,
    unique: true,
    dot: false,
  });

  const indexedFiles: IndexedFile[] = [];
  const indexedSymbols: IndexedSymbol[] = [];

  for (const relPath of files.sort()) {
    const fullPath = path.join(projectRoot, relPath);
    const sourceText = await fs.readFile(fullPath, 'utf8');
    const parsed = parseFile(relPath, sourceText);
    indexedFiles.push(parsed.file);
    indexedSymbols.push(...parsed.symbols);
  }

  return {
    schemaVersion: '1',
    generatedAt: new Date().toISOString(),
    rootDir: projectRoot,
    include: [...config.include],
    exclude: [...config.exclude],
    files: indexedFiles,
    symbols: indexedSymbols,
  };
}

export async function writeIndexArtifact(projectRoot: string, config: ProjectConfig, artifact: IndexArtifact): Promise<string> {
  const outputPath = path.join(projectRoot, config.outputPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return outputPath;
}

export async function loadIndexArtifact(projectRoot: string, config: ProjectConfig): Promise<IndexArtifact> {
  const outputPath = path.join(projectRoot, config.outputPath);
  const raw = await fs.readFile(outputPath, 'utf8');
  return JSON.parse(raw) as IndexArtifact;
}

export function searchSymbols(index: IndexArtifact, query: string, options: SearchOptions = {}): SearchResult[] {
  const normalizedQuery = query.toLowerCase();
  const results = index.symbols
    .filter((symbol) => (options.kind ? symbol.kind === options.kind : true))
    .filter((symbol) => (options.language ? symbol.language === options.language : true))
    .filter((symbol) => (typeof options.exported === 'boolean' ? symbol.exported === options.exported : true))
    .map((symbol) => {
      const exact = symbol.qualifiedName.toLowerCase() === normalizedQuery || symbol.name.toLowerCase() === normalizedQuery;
      const startsWith = symbol.qualifiedName.toLowerCase().startsWith(normalizedQuery);
      const includes = symbol.qualifiedName.toLowerCase().includes(normalizedQuery) || symbol.signature.toLowerCase().includes(normalizedQuery);
      const score = exact ? 1 : startsWith ? 0.9 : includes ? 0.7 : 0;
      return { symbol, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.symbol.qualifiedName.localeCompare(right.symbol.qualifiedName));

  return results.slice(0, options.limit ?? 20);
}

function lookupMaps(index: IndexArtifact): {
  byId: Map<string, IndexedSymbol>;
  byName: Map<string, IndexedSymbol[]>;
} {
  const byId = new Map<string, IndexedSymbol>();
  const byName = new Map<string, IndexedSymbol[]>();

  for (const symbol of index.symbols) {
    byId.set(symbol.id, symbol);
    const keys = new Set([
      symbol.name.toLowerCase(),
      symbol.qualifiedName.toLowerCase(),
    ]);
    for (const key of keys) {
      const current = byName.get(key) ?? [];
      current.push(symbol);
      byName.set(key, current);
    }
  }

  return { byId, byName };
}

function resolveCallTargets(index: IndexArtifact, name: string): IndexedSymbol[] {
  const maps = lookupMaps(index);
  const normalizedName = name.toLowerCase();
  return maps.byName.get(normalizedName) ?? [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findExactSymbol(index: IndexArtifact, name: string, kinds?: SymbolKind[]): IndexedSymbol | null {
  const normalizedName = name.toLowerCase();
  const candidates = index.symbols.filter((symbol) => (kinds ? kinds.includes(symbol.kind) : true));

  return (
    candidates.find((symbol) => symbol.qualifiedName.toLowerCase() === normalizedName) ??
    candidates.find((symbol) => symbol.name.toLowerCase() === normalizedName) ??
    null
  );
}

function findFile(index: IndexArtifact, modulePath: string): IndexedFile | null {
  const normalized = modulePath.replace(/\\/g, '/');
  return (
    index.files.find((file) => file.path === normalized) ??
    index.files.find((file) => file.path.endsWith(normalized)) ??
    null
  );
}

function listReferencedTypeSymbols(index: IndexArtifact, symbol: IndexedSymbol): IndexedSymbol[] {
  const haystack = `${symbol.signature}\n${symbol.source}`.toLowerCase();
  return index.symbols
    .filter((candidate) => candidate.id !== symbol.id)
    .filter((candidate) => candidate.kind === 'class' || candidate.kind === 'interface' || candidate.kind === 'type')
    .filter((candidate) => haystack.includes(candidate.name.toLowerCase()) || haystack.includes(candidate.qualifiedName.toLowerCase()))
    .slice(0, 20);
}

function resolveModuleSpecifier(importingFilePath: string, specifier: string): string {
  const posixPath = path.posix;
  if (!specifier.startsWith('.')) {
    return specifier;
  }
  return posixPath.normalize(posixPath.join(posixPath.dirname(importingFilePath), specifier));
}

function possibleModuleIds(filePath: string): string[] {
  const posixPath = path.posix;
  const withoutExt = filePath.replace(/\.[^.]+$/, '');
  const result = new Set<string>([filePath, withoutExt]);

  if (withoutExt.endsWith('/index')) {
    result.add(withoutExt.slice(0, -'/index'.length));
  }

  result.add(posixPath.basename(filePath));
  result.add(posixPath.basename(withoutExt));
  return [...result];
}

function matchesModuleImport(importingFilePath: string, specifier: string, targetFilePath: string): boolean {
  const resolved = resolveModuleSpecifier(importingFilePath, specifier);
  const possible = new Set(possibleModuleIds(targetFilePath));
  return possible.has(resolved) || possible.has(specifier);
}

export function getFunction(index: IndexArtifact, name: string): FunctionQueryResult | null {
  const candidate = findExactSymbol(index, name, ['function', 'method']);

  if (!candidate) {
    return null;
  }

  const resolvedCalls = candidate.calls.flatMap((call) => resolveCallTargets(index, call)).slice(0, 20);
  return { symbol: candidate, resolvedCalls };
}

export function listFiles(
  index: IndexArtifact,
  options: { limit?: number | undefined; language?: SourceLanguage | undefined; pattern?: string | undefined } = {}
): FileListEntry[] {
  const normalizedPattern = options.pattern?.toLowerCase();
  return index.files
    .filter((file) => (options.language ? file.language === options.language : true))
    .filter((file) => (normalizedPattern ? file.path.toLowerCase().includes(normalizedPattern) : true))
    .map((file) => ({
      path: file.path,
      language: file.language,
      symbolCount: file.symbolIds.length,
      imports: file.imports.length,
    }))
    .sort((left, right) => right.symbolCount - left.symbolCount || left.path.localeCompare(right.path))
    .slice(0, options.limit ?? 50);
}

export function listFunctions(
  index: IndexArtifact,
  options: {
    limit?: number | undefined;
    language?: SourceLanguage | undefined;
    exported?: boolean | undefined;
    filePattern?: string | undefined;
  } = {}
): FunctionListResult {
  const filePattern = options.filePattern?.toLowerCase();
  return {
    functions: index.symbols
      .filter((symbol) => symbol.kind === 'function' || symbol.kind === 'method')
      .filter((symbol) => (options.language ? symbol.language === options.language : true))
      .filter((symbol) => (typeof options.exported === 'boolean' ? symbol.exported === options.exported : true))
      .filter((symbol) => (filePattern ? symbol.filePath.toLowerCase().includes(filePattern) : true))
      .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName))
      .slice(0, options.limit ?? 50),
  };
}

export function getClass(index: IndexArtifact, name: string): ClassQueryResult | null {
  const klass = findExactSymbol(index, name, ['class']);
  if (!klass) {
    return null;
  }

  return {
    symbol: klass,
    methods: index.symbols
      .filter((symbol) => symbol.kind === 'method' && symbol.containerName === klass.name)
      .filter((symbol) => symbol.filePath === klass.filePath)
      .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName)),
  };
}

export function findReferences(index: IndexArtifact, name: string): ReferencesResult {
  const escaped = escapeRegExp(name);
  const regex = new RegExp(`\\b${escaped}\\b`, 'i');
  const matches: ReferenceMatch[] = [];

  for (const symbol of index.symbols) {
    if (symbol.name === name || symbol.qualifiedName === name) {
      continue;
    }

    if (regex.test(symbol.source) || regex.test(symbol.signature)) {
      matches.push({
        filePath: symbol.filePath,
        line: symbol.startLine,
        kind: 'symbol',
        snippet: symbol.signature,
        symbolId: symbol.id,
      });
    }

    for (const imported of symbol.imports) {
      if (regex.test(imported)) {
        matches.push({
          filePath: symbol.filePath,
          line: symbol.startLine,
          kind: 'import',
          snippet: imported,
          symbolId: symbol.id,
        });
      }
    }
  }

  return {
    query: name,
    matches: matches.slice(0, 100),
  };
}

export function getRelatedContext(index: IndexArtifact, name: string): RelatedContextResult | null {
  const symbol = findExactSymbol(index, name);
  if (!symbol) {
    return null;
  }

  const relatedCalls = symbol.calls.flatMap((call) => resolveCallTargets(index, call)).slice(0, 10);
  const siblings = index.symbols
    .filter((candidate) => candidate.filePath === symbol.filePath && candidate.id !== symbol.id)
    .slice(0, 10);

  return {
    symbol,
    relatedCalls,
    siblings,
    references: findReferences(index, symbol.name).matches.slice(0, 10),
  };
}

export function traceCalls(index: IndexArtifact, name: string, depth = 2): CallTrace | null {
  const root = getFunction(index, name)?.symbol;
  if (!root) {
    return null;
  }

  const { byId } = lookupMaps(index);
  const seen = new Set<string>([root.id]);
  const nodes = [{ symbol: root, depth: 0 }];
  const edges = [];
  let frontier = [{ symbol: root, depth: 0 }];

  while (frontier.length > 0) {
    const next: Array<{ symbol: IndexedSymbol; depth: number }> = [];
    for (const entry of frontier) {
      if (entry.depth >= depth) {
        continue;
      }

      for (const call of entry.symbol.calls) {
        for (const target of resolveCallTargets(index, call)) {
          if (!byId.has(target.id)) {
            continue;
          }
          edges.push({
            from: entry.symbol.id,
            to: target.id,
            label: call,
          });
          if (!seen.has(target.id)) {
            seen.add(target.id);
            const targetEntry = { symbol: target, depth: entry.depth + 1 };
            nodes.push(targetEntry);
            next.push(targetEntry);
          }
        }
      }
    }
    frontier = next;
  }

  return { root, nodes, edges };
}

export function traceTypes(index: IndexArtifact, name: string, depth = 2): TypeTrace | null {
  const root = findExactSymbol(index, name, ['class', 'interface', 'type']);
  if (!root) {
    return null;
  }

  const seen = new Set<string>([root.id]);
  const nodes = [{ symbol: root, depth: 0 }];
  const edges: TraceEdge[] = [];
  let frontier = [{ symbol: root, depth: 0 }];

  while (frontier.length > 0) {
    const next: Array<{ symbol: IndexedSymbol; depth: number }> = [];
    for (const entry of frontier) {
      if (entry.depth >= depth) {
        continue;
      }

      for (const target of listReferencedTypeSymbols(index, entry.symbol)) {
        edges.push({
          from: entry.symbol.id,
          to: target.id,
          label: 'references-type',
        });
        if (!seen.has(target.id)) {
          seen.add(target.id);
          const targetEntry = { symbol: target, depth: entry.depth + 1 };
          nodes.push(targetEntry);
          next.push(targetEntry);
        }
      }

      for (const candidate of index.symbols) {
        if (candidate.id === entry.symbol.id || seen.has(candidate.id)) {
          continue;
        }
        const haystack = `${candidate.signature}\n${candidate.source}`.toLowerCase();
        if (haystack.includes(entry.symbol.name.toLowerCase())) {
          edges.push({
            from: candidate.id,
            to: entry.symbol.id,
            label: 'uses-type',
          });
          const candidateEntry = { symbol: candidate, depth: entry.depth + 1 };
          nodes.push(candidateEntry);
          seen.add(candidate.id);
          next.push(candidateEntry);
        }
      }
    }
    frontier = next;
  }

  return { root, nodes, edges };
}

export function getModuleDependencies(index: IndexArtifact, modulePath: string): ModuleDependenciesResult | null {
  const file = findFile(index, modulePath);
  if (!file) {
    return null;
  }

  const importedBy = index.files
    .filter((candidate) => candidate.path !== file.path)
    .filter((candidate) => candidate.imports.some((specifier) => matchesModuleImport(candidate.path, specifier, file.path)))
    .map((candidate) => candidate.path)
    .sort();

  return {
    modulePath: file.path,
    imports: [...file.imports],
    importedBy,
    symbols: index.symbols.filter((symbol) => symbol.filePath === file.path),
  };
}

export function suggestRelated(index: IndexArtifact, name: string, limit = 10): SuggestedRelatedResult {
  const symbol = findExactSymbol(index, name);
  if (!symbol) {
    return { query: name, suggestions: [] };
  }

  const scored = new Map<string, { symbol: IndexedSymbol; score: number; reasons: Set<string> }>();

  const add = (candidate: IndexedSymbol, score: number, reason: string): void => {
    if (candidate.id === symbol.id) {
      return;
    }
    const current = scored.get(candidate.id) ?? { symbol: candidate, score: 0, reasons: new Set<string>() };
    current.score += score;
    current.reasons.add(reason);
    scored.set(candidate.id, current);
  };

  for (const candidate of index.symbols) {
    if (candidate.filePath === symbol.filePath) {
      add(candidate, 2, 'same-file');
    }
    if (candidate.imports.some((item) => symbol.imports.includes(item))) {
      add(candidate, 1, 'shared-import');
    }
  }

  for (const call of symbol.calls) {
    for (const candidate of resolveCallTargets(index, call)) {
      add(candidate, 4, 'call-target');
    }
  }

  for (const match of findReferences(index, symbol.name).matches) {
    if (match.symbolId) {
      const referenced = index.symbols.find((candidate) => candidate.id === match.symbolId);
      if (referenced) {
        add(referenced, 3, 'reference');
      }
    }
  }

  const suggestions = [...scored.values()]
    .sort((left, right) => right.score - left.score || left.symbol.qualifiedName.localeCompare(right.symbol.qualifiedName))
    .slice(0, limit)
    .map((entry) => ({
      symbol: entry.symbol,
      score: entry.score,
      reasons: [...entry.reasons],
    }));

  return {
    query: name,
    suggestions,
  };
}

export function getArchitectureOverview(index: IndexArtifact): ArchitectureOverview {
  const byKind: Record<SymbolKind, number> = {
    function: 0,
    class: 0,
    interface: 0,
    method: 0,
    type: 0,
    variable: 0,
  };

  for (const symbol of index.symbols) {
    byKind[symbol.kind] += 1;
  }

  return {
    generatedAt: index.generatedAt,
    totalFiles: index.files.length,
    totalSymbols: index.symbols.length,
    exportedSymbols: index.symbols.filter((symbol) => symbol.exported).length,
    byKind,
    topFiles: [...index.files]
      .map((file) => ({
        path: file.path,
        symbolCount: file.symbolIds.length,
        imports: file.imports.length,
      }))
      .sort((left, right) => right.symbolCount - left.symbolCount || left.path.localeCompare(right.path))
      .slice(0, 10),
  };
}

export function sanitizeForRemote(index: IndexArtifact, config: ProjectConfig): IndexArtifact {
  if (config.privacy.uploadSource) {
    return index;
  }

  return {
    ...index,
    symbols: index.symbols.map((symbol) => ({
      ...symbol,
      source: '',
    })),
  };
}
