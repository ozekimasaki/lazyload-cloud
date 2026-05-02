import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import { Node, Project, SyntaxKind, ts } from 'ts-morph';
import type {
  ArchitectureOverview,
  CallGraphEdge,
  CallTrace,
  ClassQueryResult,
  FileListEntry,
  FunctionListResult,
  FunctionQueryResult,
  IndexedFile,
  IndexedReference,
  IndexedSymbol,
  IndexArtifact,
  IndexStats,
  LanguageStats,
  ModuleDependenciesResult,
  ProjectConfig,
  ReferenceKind,
  ReferenceMatch,
  ReferencesResult,
  RelatedContextResult,
  SearchOptions,
  SearchResult,
  SourceLanguage,
  SuggestedRelatedResult,
  SuggestionEntry,
  SymbolKind,
  TraceEdge,
  TypeRelationship,
  TypeRelationshipKind,
  TypeTrace,
} from '../types.js';

interface SymbolRecord {
  symbol: IndexedSymbol;
  nameNode?: Node | undefined;
}

interface PythonParseResult {
  file: IndexedFile;
  symbols: IndexedSymbol[];
  references: IndexedReference[];
  callGraph: CallGraphEdge[];
  typeRelationships: TypeRelationship[];
}

type TreeNode = Parser.SyntaxNode;

function toPosix(input: string): string {
  return input.split(path.sep).join('/');
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function simplifyName(input: string): string {
  const match = input.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
  return match ? match[1]! : input;
}

function cleanTypeName(input: string): string {
  return input.replace(/<.*?>/g, '').replace(/\[\]/g, '').replace(/[|&?,]/g, ' ').trim();
}

function extractTypeNamesFromText(input: string | undefined): string[] {
  if (!input) {
    return [];
  }

  const builtins = new Set([
    'Promise',
    'string',
    'number',
    'boolean',
    'void',
    'unknown',
    'never',
    'undefined',
    'null',
    'any',
    'Record',
    'Array',
    'ReadonlyArray',
    'Map',
    'Set',
    'Date',
    'Error',
    'Request',
    'Response',
    'Object',
    'String',
    'Number',
    'Boolean',
    'Void',
    'None',
    'Optional',
    'list',
    'dict',
    'set',
    'tuple',
    'str',
    'int',
    'float',
    'self',
  ]);

  const matches = input.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
  return [...new Set(matches.map((entry) => cleanTypeName(entry)).filter((entry) => entry && !builtins.has(entry)))];
}

function normalizeSnippet(input: string): string {
  return input.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function emptyLanguageStats(): LanguageStats {
  return {
    files: 0,
    functions: 0,
    classes: 0,
    interfaces: 0,
    typeAliases: 0,
    variables: 0,
  };
}

function computeArtifactSize(files: IndexedFile[], symbols: IndexedSymbol[]): number {
  return Buffer.byteLength(
    JSON.stringify({
      files,
      symbols,
    })
  );
}

function computeStats(files: IndexedFile[], symbols: IndexedSymbol[], generatedAt: string): IndexStats {
  const byLanguage: Record<SourceLanguage, LanguageStats> = {
    typescript: emptyLanguageStats(),
    javascript: emptyLanguageStats(),
    python: emptyLanguageStats(),
  };

  for (const file of files) {
    byLanguage[file.language].files += 1;
  }

  let totalFunctions = 0;
  let totalClasses = 0;
  let totalInterfaces = 0;
  let totalVariables = 0;
  let totalTypes = 0;

  for (const symbol of symbols) {
    const bucket = byLanguage[symbol.language];
    if (symbol.kind === 'function' || symbol.kind === 'method' || symbol.kind === 'callback') {
      bucket.functions += 1;
      totalFunctions += 1;
    } else if (symbol.kind === 'class') {
      bucket.classes += 1;
      totalClasses += 1;
    } else if (symbol.kind === 'interface') {
      bucket.interfaces += 1;
      totalInterfaces += 1;
    } else if (symbol.kind === 'type') {
      bucket.typeAliases += 1;
      totalTypes += 1;
    } else if (symbol.kind === 'variable') {
      bucket.variables += 1;
      totalVariables += 1;
    }
  }

  return {
    totalFiles: files.length,
    totalSymbols: symbols.length,
    totalFunctions,
    totalClasses,
    totalInterfaces,
    totalVariables,
    totalTypes,
    byLanguage,
    generatedAt,
    artifactSizeBytes: computeArtifactSize(files, symbols),
  };
}

function buildIncludePatterns(config: ProjectConfig): string[] {
  const patterns = new Set<string>();
  for (const directory of config.directories) {
    const normalizedDirectory = toPosix(directory).replace(/^\.\/+/, '').replace(/\/+$/, '');
    for (const includePattern of config.include) {
      const normalizedPattern = includePattern.replace(/^\.\/+/, '');
      if (!normalizedDirectory || normalizedDirectory === '.') {
        patterns.add(normalizedPattern);
      } else if (normalizedPattern.startsWith('**/')) {
        patterns.add(`${normalizedDirectory}/${normalizedPattern.slice(3)}`);
      } else {
        patterns.add(`${normalizedDirectory}/${normalizedPattern}`);
      }
    }
  }
  return [...patterns];
}

function buildSnippetFromLine(sourceText: string, line: number): string {
  const lines = sourceText.split(/\r?\n/);
  return normalizeSnippet(lines[line - 1] ?? '');
}

function isConditionalNode(node: Node): boolean {
  return !!node.getFirstAncestor((ancestor) =>
    [
      SyntaxKind.IfStatement,
      SyntaxKind.TryStatement,
      SyntaxKind.ConditionalExpression,
      SyntaxKind.CaseClause,
      SyntaxKind.CatchClause,
    ].includes(ancestor.getKind())
  );
}

function tsLanguageForPath(filePath: string): SourceLanguage {
  const ext = path.extname(filePath);
  return ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs' ? 'javascript' : 'typescript';
}

function createSymbol(params: IndexedSymbol): IndexedSymbol {
  return params;
}

function createReference(params: IndexedReference): IndexedReference {
  return params;
}

function createTypeRelationship(params: TypeRelationship): TypeRelationship {
  return params;
}

function createCallEdge(params: CallGraphEdge): CallGraphEdge {
  return params;
}

function classifyReferenceKind(node: Node): ReferenceKind {
  const parent = node.getParent();
  if (!parent) {
    return 'read';
  }
  const kind = parent.getKind();
  if (kind === SyntaxKind.CallExpression) {
    return 'call';
  }
  if (kind === SyntaxKind.ImportSpecifier || kind === SyntaxKind.ImportClause || kind === SyntaxKind.NamespaceImport) {
    return 'import';
  }
  if (kind === SyntaxKind.TypeReference || kind === SyntaxKind.ExpressionWithTypeArguments) {
    return 'type';
  }
  if (kind === SyntaxKind.BinaryExpression) {
    const binary = parent.asKind(SyntaxKind.BinaryExpression);
    if (binary?.getOperatorToken().getKind() === SyntaxKind.EqualsToken && binary.getLeft() === node) {
      return 'write';
    }
  }
  return 'read';
}

function makeReferenceId(filePath: string, line: number, column: number, symbolName: string, kind: ReferenceKind): string {
  return `${filePath}:${line}:${column}:${symbolName}:${kind}`;
}

function makeCallEdgeId(callerSymbolId: string, calleeName: string): string {
  return `${callerSymbolId}:${calleeName}`;
}

function makeTypeRelationshipId(sourceSymbolId: string, targetName: string, relationshipKind: TypeRelationshipKind): string {
  return `${sourceSymbolId}:${relationshipKind}:${targetName}`;
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

function buildLookupMaps(index: IndexArtifact): {
  byId: Map<string, IndexedSymbol>;
  byName: Map<string, IndexedSymbol[]>;
} {
  const byId = new Map<string, IndexedSymbol>();
  const byName = new Map<string, IndexedSymbol[]>();

  for (const symbol of index.symbols) {
    byId.set(symbol.id, symbol);
    const keys = new Set([symbol.name.toLowerCase(), symbol.qualifiedName.toLowerCase()]);
    for (const key of keys) {
      const current = byName.get(key) ?? [];
      current.push(symbol);
      byName.set(key, current);
    }
  }

  return { byId, byName };
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
  return index.files.find((file) => file.path === normalized) ?? index.files.find((file) => file.path.endsWith(normalized)) ?? null;
}

function findReferencingSymbol(symbols: IndexedSymbol[], filePath: string, line: number): IndexedSymbol | undefined {
  return symbols
    .filter((symbol) => symbol.filePath === filePath)
    .filter((symbol) => symbol.startLine <= line && symbol.endLine >= line)
    .sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine))[0];
}

function collectTsImports(sourceFile: import('ts-morph').SourceFile): string[] {
  return sourceFile
    .getImportDeclarations()
    .map((declaration) => declaration.getModuleSpecifierValue())
    .sort();
}

function collectTsCalls(node: Node): Map<string, { count: number; isAsync: boolean; isConditional: boolean }> {
  const calls = new Map<string, { count: number; isAsync: boolean; isConditional: boolean }>();
  for (const callExpression of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const calleeName = simplifyName(callExpression.getExpression().getText());
    const current = calls.get(calleeName) ?? { count: 0, isAsync: false, isConditional: false };
    current.count += 1;
    current.isAsync ||= !!callExpression.getFirstAncestorByKind(SyntaxKind.AwaitExpression);
    current.isConditional ||= isConditionalNode(callExpression);
    calls.set(calleeName, current);
  }
  return calls;
}

function tsNodeRange(node: Node): { startLine: number; endLine: number } {
  return {
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
  };
}

function tsDocumentation(node: Node): string | undefined {
  if (!('getJsDocs' in node) || typeof (node as { getJsDocs?: () => Array<{ getInnerText(): string }> }).getJsDocs !== 'function') {
    return undefined;
  }
  const docs = (node as { getJsDocs(): Array<{ getInnerText(): string }> }).getJsDocs();
  const text = docs.map((doc) => doc.getInnerText().trim()).filter(Boolean).join('\n\n').trim();
  return text || undefined;
}

function extractTsSymbolRecords(relPath: string, sourceFile: import('ts-morph').SourceFile): {
  file: IndexedFile;
  symbols: SymbolRecord[];
  callGraph: CallGraphEdge[];
  typeRelationships: TypeRelationship[];
} {
  const normalizedRelPath = toPosix(relPath);
  const language = tsLanguageForPath(normalizedRelPath);
  const sourceText = sourceFile.getFullText();
  const imports = collectTsImports(sourceFile);
  const symbolRecords: SymbolRecord[] = [];
  const callGraph: CallGraphEdge[] = [];
  const typeRelationships: TypeRelationship[] = [];

  const pushSymbol = (
    symbol: IndexedSymbol,
    nameNode: Node | undefined,
    callInfo: Map<string, { count: number; isAsync: boolean; isConditional: boolean }>
  ): void => {
    symbolRecords.push({ symbol, nameNode });
    for (const [calleeName, metadata] of callInfo) {
      callGraph.push(
        createCallEdge({
          id: makeCallEdgeId(symbol.id, calleeName),
          callerSymbolId: symbol.id,
          callerName: symbol.qualifiedName,
          calleeName,
          callCount: metadata.count,
          isAsync: metadata.isAsync,
          isConditional: metadata.isConditional,
        })
      );
    }
    for (const typeName of symbol.extendsTypes) {
      typeRelationships.push(
        createTypeRelationship({
          id: makeTypeRelationshipId(symbol.id, typeName, 'extends'),
          sourceSymbolId: symbol.id,
          sourceName: symbol.qualifiedName,
          targetName: typeName,
          relationshipKind: 'extends',
        })
      );
    }
    for (const typeName of symbol.implementsTypes) {
      typeRelationships.push(
        createTypeRelationship({
          id: makeTypeRelationshipId(symbol.id, typeName, 'implements'),
          sourceSymbolId: symbol.id,
          sourceName: symbol.qualifiedName,
          targetName: typeName,
          relationshipKind: 'implements',
        })
      );
    }
    for (const typeName of symbol.typeReferences) {
      typeRelationships.push(
        createTypeRelationship({
          id: makeTypeRelationshipId(symbol.id, typeName, 'references-type'),
          sourceSymbolId: symbol.id,
          sourceName: symbol.qualifiedName,
          targetName: typeName,
          relationshipKind: 'references-type',
        })
      );
    }
  };

  for (const func of sourceFile.getFunctions()) {
    const name = func.getName();
    if (!name) continue;
    const range = tsNodeRange(func);
    const returnType = func.getReturnType().getText(func);
    const parameters = func.getParameters().map((parameter) => normalizeSnippet(parameter.getText()));
    const typeReferences = [...new Set([...extractTypeNamesFromText(returnType), ...parameters.flatMap(extractTypeNamesFromText)])];
    pushSymbol(
      createSymbol({
        id: `${normalizedRelPath}#${name}`,
        name,
        qualifiedName: name,
        kind: 'function',
        language,
        filePath: normalizedRelPath,
        exported: func.isExported(),
        signature: normalizeSnippet(func.getText().split('\n', 1)[0] ?? ''),
        startLine: range.startLine,
        endLine: range.endLine,
        source: func.getText(),
        calls: [...collectTsCalls(func).keys()].sort(),
        imports,
        documentation: tsDocumentation(func),
        parameters,
        returnType,
        typeReferences,
        extendsTypes: [],
        implementsTypes: [],
      }),
      func.getNameNode(),
      collectTsCalls(func)
    );
  }

  for (const declaration of sourceFile.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (!initializer || !(Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      continue;
    }
    const name = declaration.getName();
    const range = tsNodeRange(declaration);
    const returnType = initializer.getReturnType().getText(initializer);
    const parameters = initializer.getParameters().map((parameter) => normalizeSnippet(parameter.getText()));
    const typeReferences = [...new Set([...extractTypeNamesFromText(returnType), ...parameters.flatMap(extractTypeNamesFromText)])];
    pushSymbol(
      createSymbol({
        id: `${normalizedRelPath}#${name}`,
        name,
        qualifiedName: name,
        kind: 'function',
        language,
        filePath: normalizedRelPath,
        exported: declaration.isExported(),
        signature: normalizeSnippet(declaration.getText().split('\n', 1)[0] ?? ''),
        startLine: range.startLine,
        endLine: range.endLine,
        source: declaration.getText(),
        calls: [...collectTsCalls(initializer).keys()].sort(),
        imports,
        documentation: tsDocumentation(initializer),
        parameters,
        returnType,
        typeReferences,
        extendsTypes: [],
        implementsTypes: [],
      }),
      declaration.getNameNode(),
      collectTsCalls(initializer)
    );
  }

  for (const klass of sourceFile.getClasses()) {
    const name = klass.getName();
    if (!name) continue;
    const range = tsNodeRange(klass);
    const extendsTypes = klass.getExtends() ? [cleanTypeName(klass.getExtends()!.getText())] : [];
    const implementsTypes = klass.getImplements().map((item) => cleanTypeName(item.getText()));
    const classSymbol = createSymbol({
      id: `${normalizedRelPath}#${name}`,
      name,
      qualifiedName: name,
      kind: 'class',
      language,
      filePath: normalizedRelPath,
      exported: klass.isExported(),
      signature: normalizeSnippet(klass.getText().split('\n', 1)[0] ?? ''),
      startLine: range.startLine,
      endLine: range.endLine,
      source: klass.getText(),
      calls: [...collectTsCalls(klass).keys()].sort(),
      imports,
      documentation: tsDocumentation(klass),
      parameters: [],
      returnType: undefined,
      typeReferences: [...new Set(extractTypeNamesFromText(klass.getText()))],
      extendsTypes,
      implementsTypes,
    });
    pushSymbol(classSymbol, klass.getNameNode(), collectTsCalls(klass));

    for (const ctor of klass.getConstructors()) {
      const ctorRange = tsNodeRange(ctor);
      const parameters = ctor.getParameters().map((parameter) => normalizeSnippet(parameter.getText()));
      const typeReferences = [...new Set(parameters.flatMap(extractTypeNamesFromText))];
      pushSymbol(
        createSymbol({
          id: `${normalizedRelPath}#${name}.constructor`,
          name: 'constructor',
          qualifiedName: `${name}.constructor`,
          kind: 'constructor',
          language,
          filePath: normalizedRelPath,
          exported: klass.isExported(),
          signature: normalizeSnippet(ctor.getText().split('\n', 1)[0] ?? ''),
          startLine: ctorRange.startLine,
          endLine: ctorRange.endLine,
          containerName: name,
          source: ctor.getText(),
          calls: [...collectTsCalls(ctor).keys()].sort(),
          imports,
          documentation: tsDocumentation(ctor),
          parameters,
          returnType: undefined,
          typeReferences,
          extendsTypes: [],
          implementsTypes: [],
        }),
        ctor.getFirstDescendantByKind(SyntaxKind.ConstructorKeyword),
        collectTsCalls(ctor)
      );
    }

    for (const method of klass.getMethods()) {
      const methodName = method.getName();
      const methodRange = tsNodeRange(method);
      const returnType = method.getReturnType().getText(method);
      const parameters = method.getParameters().map((parameter) => normalizeSnippet(parameter.getText()));
      const typeReferences = [...new Set([...extractTypeNamesFromText(returnType), ...parameters.flatMap(extractTypeNamesFromText)])];
      pushSymbol(
        createSymbol({
          id: `${normalizedRelPath}#${name}.${methodName}`,
          name: methodName,
          qualifiedName: `${name}.${methodName}`,
          kind: 'method',
          language,
          filePath: normalizedRelPath,
          exported: klass.isExported(),
          signature: normalizeSnippet(method.getText().split('\n', 1)[0] ?? ''),
          startLine: methodRange.startLine,
          endLine: methodRange.endLine,
          containerName: name,
          source: method.getText(),
          calls: [...collectTsCalls(method).keys()].sort(),
          imports,
          documentation: tsDocumentation(method),
          parameters,
          returnType,
          typeReferences,
          extendsTypes: [],
          implementsTypes: [],
        }),
        method.getNameNode(),
        collectTsCalls(method)
      );
    }
  }

  for (const iface of sourceFile.getInterfaces()) {
    const name = iface.getName();
    const range = tsNodeRange(iface);
    const extendsTypes = iface.getExtends().map((item) => cleanTypeName(item.getText()));
    pushSymbol(
      createSymbol({
        id: `${normalizedRelPath}#${name}`,
        name,
        qualifiedName: name,
        kind: 'interface',
        language,
        filePath: normalizedRelPath,
        exported: iface.isExported(),
        signature: normalizeSnippet(iface.getText().split('\n', 1)[0] ?? ''),
        startLine: range.startLine,
        endLine: range.endLine,
        source: iface.getText(),
        calls: [],
        imports,
        documentation: tsDocumentation(iface),
        parameters: [],
        returnType: undefined,
        typeReferences: [...new Set(extractTypeNamesFromText(iface.getText()))],
        extendsTypes,
        implementsTypes: [],
      }),
      iface.getNameNode(),
      new Map()
    );
  }

  for (const typeAlias of sourceFile.getTypeAliases()) {
    const name = typeAlias.getName();
    const range = tsNodeRange(typeAlias);
    const aliasType = typeAlias.getType().getText(typeAlias);
    pushSymbol(
      createSymbol({
        id: `${normalizedRelPath}#${name}`,
        name,
        qualifiedName: name,
        kind: 'type',
        language,
        filePath: normalizedRelPath,
        exported: typeAlias.isExported(),
        signature: normalizeSnippet(typeAlias.getText().split('\n', 1)[0] ?? ''),
        startLine: range.startLine,
        endLine: range.endLine,
        source: typeAlias.getText(),
        calls: [],
        imports,
        documentation: tsDocumentation(typeAlias),
        parameters: [],
        returnType: aliasType,
        typeReferences: [...new Set(extractTypeNamesFromText(aliasType))],
        extendsTypes: [],
        implementsTypes: [],
      }),
      typeAlias.getNameNode(),
      new Map()
    );
  }

  return {
    file: {
      path: normalizedRelPath,
      language,
      imports,
      symbolIds: symbolRecords.map((record) => record.symbol.id),
      hash: hashContent(sourceText),
      size: Buffer.byteLength(sourceText),
    },
    symbols: symbolRecords,
    callGraph,
    typeRelationships,
  };
}

function pythonFieldText(sourceText: string, node: TreeNode | null): string | undefined {
  if (!node) {
    return undefined;
  }
  return sourceText.slice(node.startIndex, node.endIndex);
}

function pythonChildrenForField(node: TreeNode, fieldName: string): TreeNode[] {
  return node.childrenForFieldName(fieldName) as unknown as TreeNode[];
}

function pythonNodeText(sourceText: string, node: TreeNode): string {
  return sourceText.slice(node.startIndex, node.endIndex);
}

function parsePythonImports(sourceText: string, root: TreeNode): string[] {
  const imports = new Set<string>();
  for (const child of root.namedChildren as unknown as TreeNode[]) {
    if (child.type === 'import_statement' || child.type === 'import_from_statement') {
      const text = pythonNodeText(sourceText, child);
      const match = text.match(/from\s+([A-Za-z0-9_\.]+)/) ?? text.match(/import\s+([A-Za-z0-9_\.]+)/);
      if (match?.[1]) {
        imports.add(match[1]);
      }
    }
  }
  return [...imports].sort();
}

function parsePythonDocstring(sourceText: string, bodyNode: TreeNode | null): string | undefined {
  if (!bodyNode) {
    return undefined;
  }
  const first = (bodyNode.namedChildren as unknown as TreeNode[])[0];
  if (!first || first.type !== 'expression_statement') {
    return undefined;
  }
  const firstNamed = (first.namedChildren as unknown as TreeNode[])[0];
  if (!firstNamed || firstNamed.type !== 'string') {
    return undefined;
  }
  return pythonNodeText(sourceText, firstNamed).replace(/^['"]+|['"]+$/g, '').trim() || undefined;
}

function collectPythonCalls(node: TreeNode, sourceText: string): Map<string, { count: number; isAsync: boolean; isConditional: boolean }> {
  const calls = new Map<string, { count: number; isAsync: boolean; isConditional: boolean }>();

  const visit = (current: TreeNode, conditional = false, asyncContext = false): void => {
    const nextConditional = conditional || ['if_statement', 'try_statement', 'conditional_expression'].includes(current.type);
    const nextAsync = asyncContext || current.type === 'await';

    if (current.type === 'call') {
      const functionNode = current.childForFieldName('function') as unknown as TreeNode | null;
      if (functionNode) {
        const calleeName = simplifyName(pythonNodeText(sourceText, functionNode));
        const entry = calls.get(calleeName) ?? { count: 0, isAsync: false, isConditional: false };
        entry.count += 1;
        entry.isAsync ||= nextAsync;
        entry.isConditional ||= nextConditional;
        calls.set(calleeName, entry);
      }
    }

    for (const child of current.namedChildren as unknown as TreeNode[]) {
      visit(child, nextConditional, nextAsync);
    }
  };

  visit(node);
  return calls;
}

function parsePythonParameters(sourceText: string, parametersNode: TreeNode | null): string[] {
  if (!parametersNode) {
    return [];
  }
  return (parametersNode.namedChildren as unknown as TreeNode[]).map((child) => normalizeSnippet(pythonNodeText(sourceText, child)));
}

function extractPythonReferences(
  sourceText: string,
  relPath: string,
  node: TreeNode,
  symbolName: string,
  referencingSymbolName: string | undefined
): IndexedReference[] {
  const references: IndexedReference[] = [];

  const visit = (current: TreeNode): void => {
    if (current.type === 'identifier') {
      const name = pythonNodeText(sourceText, current);
      const parent = current.parent;
      let kind: ReferenceKind = 'read';
      if (parent?.type === 'call') {
        kind = 'call';
      } else if (parent?.type === 'import_statement' || parent?.type === 'import_from_statement') {
        kind = 'import';
      } else if (parent?.type.includes('type')) {
        kind = 'type';
      }
      references.push(
        createReference({
          id: makeReferenceId(relPath, current.startPosition.row + 1, current.startPosition.column + 1, name, kind),
          symbolName: name,
          referencingFile: relPath,
          referencingSymbolName,
          line: current.startPosition.row + 1,
          column: current.startPosition.column + 1,
          kind,
          snippet: buildSnippetFromLine(sourceText, current.startPosition.row + 1),
        })
      );
    }

    for (const child of current.namedChildren as unknown as TreeNode[]) {
      visit(child);
    }
  };

  visit(node);
  return references.filter((reference) => !(reference.symbolName === symbolName && reference.kind === 'read'));
}

function parsePythonFile(relPath: string, sourceText: string, parser: Parser): PythonParseResult {
  const tree = parser.parse(sourceText);
  const root = tree.rootNode as unknown as TreeNode;
  const imports = parsePythonImports(sourceText, root);
  const symbols: IndexedSymbol[] = [];
  const references: IndexedReference[] = [];
  const callGraph: CallGraphEdge[] = [];
  const typeRelationships: TypeRelationship[] = [];

  const pushSymbol = (symbol: IndexedSymbol, callInfo: Map<string, { count: number; isAsync: boolean; isConditional: boolean }>): void => {
    symbols.push(symbol);
    for (const [calleeName, metadata] of callInfo) {
      callGraph.push(
        createCallEdge({
          id: makeCallEdgeId(symbol.id, calleeName),
          callerSymbolId: symbol.id,
          callerName: symbol.qualifiedName,
          calleeName,
          callCount: metadata.count,
          isAsync: metadata.isAsync,
          isConditional: metadata.isConditional,
        })
      );
    }
    for (const typeName of symbol.extendsTypes) {
      typeRelationships.push(
        createTypeRelationship({
          id: makeTypeRelationshipId(symbol.id, typeName, 'extends'),
          sourceSymbolId: symbol.id,
          sourceName: symbol.qualifiedName,
          targetName: typeName,
          relationshipKind: 'extends',
        })
      );
    }
    for (const typeName of symbol.implementsTypes) {
      typeRelationships.push(
        createTypeRelationship({
          id: makeTypeRelationshipId(symbol.id, typeName, 'mixin'),
          sourceSymbolId: symbol.id,
          sourceName: symbol.qualifiedName,
          targetName: typeName,
          relationshipKind: 'mixin',
        })
      );
    }
    for (const typeName of symbol.typeReferences) {
      typeRelationships.push(
        createTypeRelationship({
          id: makeTypeRelationshipId(symbol.id, typeName, 'references-type'),
          sourceSymbolId: symbol.id,
          sourceName: symbol.qualifiedName,
          targetName: typeName,
          relationshipKind: 'references-type',
        })
      );
    }
  };

  const handleFunction = (node: TreeNode, decorated = false, containerName?: string): void => {
    const functionNode = decorated ? ((node.namedChildren as unknown as TreeNode[]).find((child) => child.type.endsWith('function_definition')) ?? node) : node;
    const nameNode = functionNode.childForFieldName('name') as unknown as TreeNode | null;
    if (!nameNode) {
      return;
    }
    const name = pythonNodeText(sourceText, nameNode);
    const parameters = parsePythonParameters(sourceText, functionNode.childForFieldName('parameters') as unknown as TreeNode | null);
    const returnType = pythonFieldText(sourceText, functionNode.childForFieldName('return_type') as unknown as TreeNode | null);
    const body = functionNode.childForFieldName('body') as unknown as TreeNode | null;
    const callInfo = collectPythonCalls(functionNode, sourceText);
    const qualifiedName = containerName ? `${containerName}.${name}` : name;
    const kind: SymbolKind = containerName ? 'method' : 'function';
    const symbol = createSymbol({
      id: `${relPath}#${qualifiedName}`,
      name,
      qualifiedName,
      kind,
      language: 'python',
      filePath: relPath,
      exported: !name.startsWith('_'),
      signature: normalizeSnippet(pythonNodeText(sourceText, functionNode).split('\n', 1)[0] ?? ''),
      startLine: functionNode.startPosition.row + 1,
      endLine: functionNode.endPosition.row + 1,
      containerName,
      source: pythonNodeText(sourceText, functionNode),
      calls: [...callInfo.keys()].sort(),
      imports,
      documentation: parsePythonDocstring(sourceText, body),
      parameters,
      returnType,
      typeReferences: [...new Set([...parameters.flatMap(extractTypeNamesFromText), ...extractTypeNamesFromText(returnType)])],
      extendsTypes: [],
      implementsTypes: [],
    });
    pushSymbol(symbol, callInfo);
    references.push(...extractPythonReferences(sourceText, relPath, functionNode, name, qualifiedName));
  };

  const handleClass = (node: TreeNode, decorated = false): void => {
    const classNode = decorated ? ((node.namedChildren as unknown as TreeNode[]).find((child) => child.type === 'class_definition') ?? node) : node;
    const nameNode = classNode.childForFieldName('name') as unknown as TreeNode | null;
    if (!nameNode) {
      return;
    }
    const className = pythonNodeText(sourceText, nameNode);
    const body = classNode.childForFieldName('body') as unknown as TreeNode | null;
    const superclassesNode = classNode.childForFieldName('superclasses') as unknown as TreeNode | null;
    const superclasses = superclassesNode
      ? (superclassesNode.namedChildren as unknown as TreeNode[]).map((child) => cleanTypeName(pythonNodeText(sourceText, child)))
      : [];
    const [firstBase, ...mixins] = superclasses;
    const callInfo = collectPythonCalls(classNode, sourceText);
    const symbol = createSymbol({
      id: `${relPath}#${className}`,
      name: className,
      qualifiedName: className,
      kind: 'class',
      language: 'python',
      filePath: relPath,
      exported: !className.startsWith('_'),
      signature: normalizeSnippet(pythonNodeText(sourceText, classNode).split('\n', 1)[0] ?? ''),
      startLine: classNode.startPosition.row + 1,
      endLine: classNode.endPosition.row + 1,
      source: pythonNodeText(sourceText, classNode),
      calls: [...callInfo.keys()].sort(),
      imports,
      documentation: parsePythonDocstring(sourceText, body),
      parameters: [],
      returnType: undefined,
      typeReferences: [...new Set(extractTypeNamesFromText(pythonNodeText(sourceText, classNode)))],
      extendsTypes: firstBase ? [firstBase] : [],
      implementsTypes: mixins,
    });
    pushSymbol(symbol, callInfo);
    references.push(...extractPythonReferences(sourceText, relPath, classNode, className, className));

    for (const child of body?.namedChildren ?? []) {
      const typedChild = child as unknown as TreeNode;
      if (typedChild.type === 'function_definition' || typedChild.type === 'async_function_definition' || typedChild.type === 'decorated_definition') {
        handleFunction(typedChild, typedChild.type === 'decorated_definition', className);
      }
    }
  };

  for (const child of root.namedChildren as unknown as TreeNode[]) {
    if (child.type === 'function_definition' || child.type === 'async_function_definition') {
      handleFunction(child);
    } else if (child.type === 'class_definition') {
      handleClass(child);
    } else if (child.type === 'decorated_definition') {
      const decoratedChild = (child.namedChildren as unknown as TreeNode[]).find(
        (entry) => entry.type === 'class_definition' || entry.type.endsWith('function_definition')
      );
      if (!decoratedChild) continue;
      if (decoratedChild.type === 'class_definition') {
        handleClass(child, true);
      } else {
        handleFunction(child, true);
      }
    }
  }

  return {
    file: {
      path: relPath,
      language: 'python',
      imports,
      symbolIds: symbols.map((symbol) => symbol.id),
      hash: hashContent(sourceText),
      size: Buffer.byteLength(sourceText),
    },
    symbols,
    references,
    callGraph,
    typeRelationships,
  };
}

function resolveGraph(index: IndexArtifact): IndexArtifact {
  const { byName } = buildLookupMaps(index);

  const references = index.references.map((reference) => {
    const resolved = byName.get(reference.symbolName.toLowerCase())?.[0];
    return {
      ...reference,
      symbolId: resolved?.id,
      referencingSymbolId: reference.referencingSymbolId ?? findReferencingSymbol(index.symbols, reference.referencingFile, reference.line)?.id,
      referencingSymbolName:
        reference.referencingSymbolName ?? findReferencingSymbol(index.symbols, reference.referencingFile, reference.line)?.qualifiedName,
    };
  });

  const callGraph = index.callGraph.map((edge) => ({
    ...edge,
    calleeSymbolId: byName.get(edge.calleeName.toLowerCase())?.[0]?.id,
  }));

  const typeRelationships = index.typeRelationships.map((relationship) => ({
    ...relationship,
    targetSymbolId: byName.get(relationship.targetName.toLowerCase())?.[0]?.id,
  }));

  return {
    ...index,
    references,
    callGraph,
    typeRelationships,
  };
}

async function extractTsReferences(
  records: SymbolRecord[],
  sourceFileTexts: Map<string, string>,
  canonicalPaths: Map<string, string>
): Promise<IndexedReference[]> {
  const references: IndexedReference[] = [];

  for (const record of records) {
    if (!record.nameNode || typeof (record.nameNode as unknown as { findReferencesAsNodes?: () => Node[] }).findReferencesAsNodes !== 'function') {
      continue;
    }

    const refNodes = (record.nameNode as unknown as { findReferencesAsNodes(): Node[] }).findReferencesAsNodes();
    for (const refNode of refNodes) {
      const sourceFile = refNode.getSourceFile();
      const filePath = canonicalPaths.get(toPosix(sourceFile.getFilePath())) ?? toPosix(sourceFile.getFilePath());
      if (filePath === record.symbol.filePath && refNode.getStartLineNumber() === record.symbol.startLine) {
        continue;
      }
      const sourceText = sourceFileTexts.get(filePath) ?? sourceFile.getFullText();
      references.push(
        createReference({
          id: makeReferenceId(filePath, refNode.getStartLineNumber(), refNode.getNonWhitespaceStart(), record.symbol.name, classifyReferenceKind(refNode)),
          symbolName: record.symbol.name,
          referencingFile: filePath,
          line: refNode.getStartLineNumber(),
          column: refNode.getNonWhitespaceStart(),
          kind: classifyReferenceKind(refNode),
          snippet: buildSnippetFromLine(sourceText, refNode.getStartLineNumber()),
        })
      );
    }
  }

  return references;
}

export async function buildIndex(projectRoot: string, config: ProjectConfig): Promise<IndexArtifact> {
  const includePatterns = buildIncludePatterns(config);
  const files = await fg(includePatterns, {
    cwd: projectRoot,
    ignore: config.exclude,
    onlyFiles: true,
    absolute: false,
    unique: true,
    dot: false,
  });

  const sortedFiles = files.map((file) => toPosix(file)).sort();
  const tsFiles = sortedFiles.filter((file) => /\.(tsx?|jsx?|mjs|cjs)$/.test(file));
  const pyFiles = sortedFiles.filter((file) => file.endsWith('.py'));

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
      strict: false,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  });
  const pythonParser = new Parser();
  pythonParser.setLanguage(Python as unknown as Parser.Language);

  const indexedFiles: IndexedFile[] = [];
  const indexedSymbols: SymbolRecord[] = [];
  const references: IndexedReference[] = [];
  const callGraph: CallGraphEdge[] = [];
  const typeRelationships: TypeRelationship[] = [];
  const sourceFileTexts = new Map<string, string>();
  const canonicalPaths = new Map<string, string>();

  for (const relPath of tsFiles) {
    const fullPath = path.join(projectRoot, relPath);
    const sourceText = await fs.readFile(fullPath, 'utf8');
    sourceFileTexts.set(toPosix(relPath), sourceText);
    const sourceFile = project.createSourceFile(toPosix(relPath), sourceText, { overwrite: true });
    canonicalPaths.set(toPosix(sourceFile.getFilePath()), toPosix(relPath));
    const parsed = extractTsSymbolRecords(toPosix(relPath), sourceFile);
    indexedFiles.push(parsed.file);
    indexedSymbols.push(...parsed.symbols);
    callGraph.push(...parsed.callGraph);
    typeRelationships.push(...parsed.typeRelationships);
  }

  references.push(...(await extractTsReferences(indexedSymbols, sourceFileTexts, canonicalPaths)));

  for (const relPath of pyFiles) {
    const fullPath = path.join(projectRoot, relPath);
    const sourceText = await fs.readFile(fullPath, 'utf8');
    const parsed = parsePythonFile(toPosix(relPath), sourceText, pythonParser);
    indexedFiles.push(parsed.file);
    indexedSymbols.push(...parsed.symbols.map((symbol) => ({ symbol })));
    references.push(...parsed.references);
    callGraph.push(...parsed.callGraph);
    typeRelationships.push(...parsed.typeRelationships);
  }

  const generatedAt = new Date().toISOString();
  const artifact: IndexArtifact = {
    schemaVersion: '2',
    generatedAt,
    rootDir: projectRoot,
    directories: [...config.directories],
    include: [...config.include],
    exclude: [...config.exclude],
    files: indexedFiles.sort((left, right) => left.path.localeCompare(right.path)),
    symbols: indexedSymbols.map((record) => record.symbol).sort((left, right) => left.id.localeCompare(right.id)),
    references,
    callGraph,
    typeRelationships,
    stats: computeStats(
      indexedFiles.sort((left, right) => left.path.localeCompare(right.path)),
      indexedSymbols.map((record) => record.symbol).sort((left, right) => left.id.localeCompare(right.id)),
      generatedAt
    ),
  };

  return resolveGraph(artifact);
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
  const parsed = JSON.parse(raw) as IndexArtifact;
  return parsed.schemaVersion === '2'
    ? parsed
    : ({
        ...parsed,
        schemaVersion: '2',
        directories: parsed.directories ?? ['.'],
        references: parsed.references ?? [],
        callGraph: parsed.callGraph ?? [],
        typeRelationships: parsed.typeRelationships ?? [],
        stats:
          parsed.stats ??
          computeStats(parsed.files, parsed.symbols, parsed.generatedAt),
      } as IndexArtifact);
}

export function searchSymbols(index: IndexArtifact, query: string, options: SearchOptions = {}): SearchResult[] {
  const normalizedQuery = query.toLowerCase();
  const results = index.symbols
    .filter((symbol) => (options.kind ? symbol.kind === options.kind : true))
    .filter((symbol) => (options.language ? symbol.language === options.language : true))
    .filter((symbol) => (typeof options.exported === 'boolean' ? symbol.exported === options.exported : true))
    .map((symbol) => {
      const exact = symbol.qualifiedName.toLowerCase() === normalizedQuery || symbol.name.toLowerCase() === normalizedQuery;
      const startsWith = symbol.qualifiedName.toLowerCase().startsWith(normalizedQuery) || symbol.name.toLowerCase().startsWith(normalizedQuery);
      const includes =
        symbol.qualifiedName.toLowerCase().includes(normalizedQuery) ||
        symbol.signature.toLowerCase().includes(normalizedQuery) ||
        symbol.source.toLowerCase().includes(normalizedQuery) ||
        symbol.typeReferences.some((entry) => entry.toLowerCase().includes(normalizedQuery));
      const score = exact ? 1 : startsWith ? 0.92 : includes ? 0.72 : 0;
      return { symbol, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.symbol.qualifiedName.localeCompare(right.symbol.qualifiedName));
  return results.slice(0, options.limit ?? 20);
}

function resolveCallTargets(index: IndexArtifact, name: string): IndexedSymbol[] {
  const { byName } = buildLookupMaps(index);
  return byName.get(name.toLowerCase()) ?? [];
}

function listReferencedTypeSymbols(index: IndexArtifact, symbol: IndexedSymbol): IndexedSymbol[] {
  const referencedNames = new Set([
    ...symbol.typeReferences,
    ...symbol.extendsTypes,
    ...symbol.implementsTypes,
    ...index.typeRelationships.filter((relationship) => relationship.sourceSymbolId === symbol.id).map((relationship) => relationship.targetName),
  ]);

  return index.symbols.filter((candidate) => referencedNames.has(candidate.name) || referencedNames.has(candidate.qualifiedName));
}

export function getFunction(index: IndexArtifact, name: string): FunctionQueryResult | null {
  const candidate = findExactSymbol(index, name, ['function', 'method', 'callback', 'constructor']);
  if (!candidate) {
    return null;
  }

  const resolvedCalls = index.callGraph
    .filter((edge) => edge.callerSymbolId === candidate.id)
    .map((edge) => edge.calleeSymbolId)
    .filter((edge): edge is string => Boolean(edge))
    .map((calleeId) => index.symbols.find((symbol) => symbol.id === calleeId))
    .filter((symbol): symbol is IndexedSymbol => Boolean(symbol));

  return {
    symbol: candidate,
    resolvedCalls,
  };
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
      .filter((symbol) => ['function', 'method', 'callback', 'constructor'].includes(symbol.kind))
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
      .filter((symbol) => ['method', 'constructor'].includes(symbol.kind))
      .filter((symbol) => symbol.containerName === klass.name)
      .filter((symbol) => symbol.filePath === klass.filePath)
      .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName)),
  };
}

export function findReferences(index: IndexArtifact, name: string): ReferencesResult {
  const symbol = findExactSymbol(index, name);
  const names = new Set([name.toLowerCase()]);
  if (symbol) {
    names.add(symbol.name.toLowerCase());
    names.add(symbol.qualifiedName.toLowerCase());
  }

  return {
    query: name,
    matches: index.references
      .filter((reference) => names.has(reference.symbolName.toLowerCase()))
      .map((reference) => ({
        filePath: reference.referencingFile,
        line: reference.line,
        kind: reference.kind,
        snippet: reference.snippet,
        symbolId: reference.referencingSymbolId,
      }))
      .sort((left, right) => left.filePath.localeCompare(right.filePath) || left.line - right.line)
      .slice(0, 100),
  };
}

export function getRelatedContext(index: IndexArtifact, name: string): RelatedContextResult | null {
  const symbol = findExactSymbol(index, name);
  if (!symbol) {
    return null;
  }

  const relatedCalls = index.callGraph
    .filter((edge) => edge.callerSymbolId === symbol.id)
    .map((edge) => edge.calleeSymbolId)
    .filter((calleeId): calleeId is string => Boolean(calleeId))
    .map((calleeId) => index.symbols.find((candidate) => candidate.id === calleeId))
    .filter((candidate): candidate is IndexedSymbol => Boolean(candidate))
    .slice(0, 12);

  const siblings = index.symbols.filter((candidate) => candidate.filePath === symbol.filePath && candidate.id !== symbol.id).slice(0, 12);
  const relatedTypes = listReferencedTypeSymbols(index, symbol).slice(0, 12);
  const references = findReferences(index, symbol.name).matches.slice(0, 12);
  const tests = references.filter((reference) => /(?:^|\/)(?:test|tests|__tests__|spec)/i.test(reference.filePath)).slice(0, 8);

  return {
    symbol,
    relatedCalls,
    siblings,
    relatedTypes,
    references,
    tests,
  };
}

export function traceCalls(index: IndexArtifact, name: string, depth = 2): CallTrace | null {
  const root = getFunction(index, name)?.symbol;
  if (!root) {
    return null;
  }

  const nodes = [{ symbol: root, depth: 0 }];
  const edges: TraceEdge[] = [];
  const seen = new Set<string>([root.id]);
  let frontier = [{ symbol: root, depth: 0 }];

  while (frontier.length > 0) {
    const next: Array<{ symbol: IndexedSymbol; depth: number }> = [];
    for (const entry of frontier) {
      if (entry.depth >= depth) continue;
      for (const edge of index.callGraph.filter((candidate) => candidate.callerSymbolId === entry.symbol.id)) {
        const target = edge.calleeSymbolId ? index.symbols.find((candidate) => candidate.id === edge.calleeSymbolId) : undefined;
        if (!target) continue;
        edges.push({ from: entry.symbol.id, to: target.id, label: edge.calleeName });
        if (!seen.has(target.id)) {
          seen.add(target.id);
          const nextEntry = { symbol: target, depth: entry.depth + 1 };
          nodes.push(nextEntry);
          next.push(nextEntry);
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

  const nodes = [{ symbol: root, depth: 0 }];
  const edges: TraceEdge[] = [];
  const seen = new Set<string>([root.id]);
  let frontier = [{ symbol: root, depth: 0 }];

  while (frontier.length > 0) {
    const next: Array<{ symbol: IndexedSymbol; depth: number }> = [];
    for (const entry of frontier) {
      if (entry.depth >= depth) continue;

      const outgoing = index.typeRelationships.filter((relationship) => relationship.sourceSymbolId === entry.symbol.id);
      const incoming = index.typeRelationships.filter((relationship) => relationship.targetSymbolId === entry.symbol.id);

      for (const relationship of [...outgoing, ...incoming]) {
        const targetId = relationship.sourceSymbolId === entry.symbol.id ? relationship.targetSymbolId : relationship.sourceSymbolId;
        if (!targetId) continue;
        const target = index.symbols.find((candidate) => candidate.id === targetId);
        if (!target) continue;
        edges.push({
          from: relationship.sourceSymbolId,
          to: target.id,
          label: relationship.relationshipKind,
        });
        if (!seen.has(target.id)) {
          seen.add(target.id);
          const nextEntry = { symbol: target, depth: entry.depth + 1 };
          nodes.push(nextEntry);
          next.push(nextEntry);
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

function addSuggestion(
  scored: Map<string, { symbol: IndexedSymbol; score: number; reasons: Set<string> }>,
  origin: IndexedSymbol,
  candidate: IndexedSymbol,
  score: number,
  reason: string
): void {
  if (candidate.id === origin.id) {
    return;
  }
  const current = scored.get(candidate.id) ?? { symbol: candidate, score: 0, reasons: new Set<string>() };
  current.score += score;
  current.reasons.add(reason);
  scored.set(candidate.id, current);
}

export function suggestRelated(index: IndexArtifact, name: string, limit = 10): SuggestedRelatedResult {
  const symbol = findExactSymbol(index, name);
  if (!symbol) {
    return { query: name, suggestions: [] };
  }

  const scored = new Map<string, { symbol: IndexedSymbol; score: number; reasons: Set<string> }>();

  for (const edge of index.callGraph.filter((candidate) => candidate.callerSymbolId === symbol.id)) {
    const target = edge.calleeSymbolId ? index.symbols.find((candidate) => candidate.id === edge.calleeSymbolId) : undefined;
    if (target) {
      addSuggestion(scored, symbol, target, 0.7 * Math.max(1, edge.callCount), 'callee');
    }
  }

  for (const edge of index.callGraph.filter((candidate) => candidate.calleeSymbolId === symbol.id)) {
    const caller = index.symbols.find((candidate) => candidate.id === edge.callerSymbolId);
    if (caller) {
      addSuggestion(scored, symbol, caller, 0.8 * Math.max(1, edge.callCount), 'caller');
      for (const siblingEdge of index.callGraph.filter((candidate) => candidate.callerSymbolId === edge.callerSymbolId)) {
        if (!siblingEdge.calleeSymbolId) continue;
        const sibling = index.symbols.find((candidate) => candidate.id === siblingEdge.calleeSymbolId);
        if (sibling) {
          addSuggestion(scored, symbol, sibling, 0.5, 'shared-caller');
        }
      }
    }
  }

  for (const candidate of index.symbols) {
    if (candidate.filePath === symbol.filePath) {
      addSuggestion(scored, symbol, candidate, candidate.containerName === symbol.containerName ? 0.8 : 0.4, 'cooccurrence');
    }
    if (candidate.imports.some((item) => symbol.imports.includes(item))) {
      addSuggestion(scored, symbol, candidate, 0.25, 'shared-import');
    }
  }

  for (const relationship of index.typeRelationships) {
    if (relationship.sourceSymbolId === symbol.id && relationship.targetSymbolId) {
      const target = index.symbols.find((candidate) => candidate.id === relationship.targetSymbolId);
      if (target) {
        addSuggestion(scored, symbol, target, relationship.relationshipKind === 'references-type' ? 0.3 : 0.6, relationship.relationshipKind);
      }
    } else if (relationship.targetSymbolId === symbol.id) {
      const source = index.symbols.find((candidate) => candidate.id === relationship.sourceSymbolId);
      if (source) {
        addSuggestion(scored, symbol, source, relationship.relationshipKind === 'references-type' ? 0.25 : 0.55, `reverse-${relationship.relationshipKind}`);
      }
    }
  }

  for (const reference of findReferences(index, symbol.name).matches) {
    if (reference.symbolId) {
      const referencedBy = index.symbols.find((candidate) => candidate.id === reference.symbolId);
      if (referencedBy) {
        addSuggestion(scored, symbol, referencedBy, 0.5, 'reference');
      }
    }
  }

  const suggestions: SuggestionEntry[] = [...scored.values()]
    .sort((left, right) => right.score - left.score || left.symbol.qualifiedName.localeCompare(right.symbol.qualifiedName))
    .slice(0, limit)
    .map((entry) => ({
      symbol: entry.symbol,
      score: Number(entry.score.toFixed(3)),
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
    constructor: 0,
    callback: 0,
  };

  const byLanguage: Record<SourceLanguage, LanguageStats> = {
    typescript: emptyLanguageStats(),
    javascript: emptyLanguageStats(),
    python: emptyLanguageStats(),
  };

  for (const file of index.files) {
    byLanguage[file.language].files += 1;
  }

  for (const symbol of index.symbols) {
    byKind[symbol.kind] += 1;
    const bucket = byLanguage[symbol.language];
    if (symbol.kind === 'class') {
      bucket.classes += 1;
    } else if (symbol.kind === 'interface') {
      bucket.interfaces += 1;
    } else if (symbol.kind === 'type') {
      bucket.typeAliases += 1;
    } else if (symbol.kind === 'variable') {
      bucket.variables += 1;
    } else {
      bucket.functions += 1;
    }
  }

  return {
    generatedAt: index.generatedAt,
    totalFiles: index.files.length,
    totalSymbols: index.symbols.length,
    exportedSymbols: index.symbols.filter((symbol) => symbol.exported).length,
    byKind,
    byLanguage,
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

export function getIndexStats(index: IndexArtifact): IndexStats {
  return index.stats ?? computeStats(index.files, index.symbols, index.generatedAt);
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
      documentation: undefined,
    })),
  };
}
