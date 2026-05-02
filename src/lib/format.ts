import type {
  ArchitectureOverview,
  CallTrace,
  ClassQueryResult,
  FileListEntry,
  FunctionQueryResult,
  FunctionListResult,
  ModuleDependenciesResult,
  OutputFormat,
  ReferencesResult,
  RelatedContextResult,
  RemoteProjectStatus,
  SearchResult,
  SuggestedRelatedResult,
  TypeTrace,
} from '../types.js';

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function formatSearchResults(results: SearchResult[], format: OutputFormat): string {
  if (format === 'json') {
    return asJson(results);
  }

  if (format === 'markdown') {
    const lines = ['| Score | Name | Kind | File |', '| ---: | --- | --- | --- |'];
    for (const result of results) {
      lines.push(
        `| ${Math.round(result.score * 100)} | ${result.symbol.qualifiedName} | ${result.symbol.kind} | ${result.symbol.filePath}:${result.symbol.startLine} |`
      );
    }
    return `${lines.join('\n')}\n`;
  }

  const header = 'score\tkind\tname\tfile\tline\tsignature';
  const rows = results.map((result) =>
    [
      Math.round(result.score * 100),
      result.symbol.kind,
      result.symbol.qualifiedName,
      result.symbol.filePath,
      result.symbol.startLine,
      result.symbol.signature.replace(/\s+/g, ' ').trim(),
    ].join('\t')
  );
  return `${[header, ...rows].join('\n')}\n`;
}

export function formatFileList(files: FileListEntry[], format: OutputFormat): string {
  if (format === 'json') {
    return asJson(files);
  }

  if (format === 'markdown') {
    const lines = ['| File | Language | Symbols | Imports |', '| --- | --- | ---: | ---: |'];
    for (const file of files) {
      lines.push(`| ${file.path} | ${file.language} | ${file.symbolCount} | ${file.imports} |`);
    }
    return `${lines.join('\n')}\n`;
  }

  const header = 'path\tlanguage\tsymbols\timports';
  const rows = files.map((file) => [file.path, file.language, file.symbolCount, file.imports].join('\t'));
  return `${[header, ...rows].join('\n')}\n`;
}

export function formatFunctionList(result: FunctionListResult, format: OutputFormat): string {
  if (format === 'json') {
    return asJson(result);
  }

  if (format === 'markdown') {
    const lines = ['| Name | Kind | File | Exported |', '| --- | --- | --- | --- |'];
    for (const symbol of result.functions) {
      lines.push(`| ${symbol.qualifiedName} | ${symbol.kind} | ${symbol.filePath}:${symbol.startLine} | ${symbol.exported} |`);
    }
    return `${lines.join('\n')}\n`;
  }

  const header = 'name\tkind\tfile\tline\texported';
  const rows = result.functions.map((symbol) =>
    [symbol.qualifiedName, symbol.kind, symbol.filePath, symbol.startLine, symbol.exported].join('\t')
  );
  return `${[header, ...rows].join('\n')}\n`;
}

export function formatFunctionResult(result: FunctionQueryResult | null, format: OutputFormat): string {
  if (!result) {
    return format === 'json' ? asJson(null) : 'No function found.\n';
  }

  if (format === 'json') {
    return asJson(result);
  }

  if (format === 'markdown') {
    return [
      `## ${result.symbol.qualifiedName}`,
      '',
      `- Kind: ${result.symbol.kind}`,
      `- File: ${result.symbol.filePath}:${result.symbol.startLine}`,
      `- Exported: ${result.symbol.exported ? 'yes' : 'no'}`,
      '',
      '```ts',
      result.symbol.source.trim(),
      '```',
      '',
      '### Resolved calls',
      '',
      ...result.resolvedCalls.map((call) => `- ${call.qualifiedName} (${call.filePath}:${call.startLine})`),
      '',
    ].join('\n');
  }

  const lines = [
    `name\t${result.symbol.qualifiedName}`,
    `kind\t${result.symbol.kind}`,
    `file\t${result.symbol.filePath}:${result.symbol.startLine}`,
    `exported\t${result.symbol.exported}`,
    'source',
    result.symbol.source.trim(),
  ];
  if (result.resolvedCalls.length > 0) {
    lines.push('calls');
    for (const call of result.resolvedCalls) {
      lines.push(`${call.qualifiedName}\t${call.filePath}:${call.startLine}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function formatClassResult(result: ClassQueryResult | null, format: OutputFormat): string {
  if (!result) {
    return format === 'json' ? asJson(null) : 'No class found.\n';
  }

  if (format === 'json') {
    return asJson(result);
  }

  if (format === 'markdown') {
    return [
      `## ${result.symbol.qualifiedName}`,
      '',
      `- File: ${result.symbol.filePath}:${result.symbol.startLine}`,
      '',
      '### Methods',
      '',
      ...result.methods.map((method) => `- ${method.qualifiedName} (${method.filePath}:${method.startLine})`),
      '',
    ].join('\n');
  }

  const lines = [
    `class\t${result.symbol.qualifiedName}`,
    `file\t${result.symbol.filePath}:${result.symbol.startLine}`,
    'methods',
    ...result.methods.map((method) => `${method.qualifiedName}\t${method.filePath}:${method.startLine}`),
  ];
  return `${lines.join('\n')}\n`;
}

export function formatRelatedContext(result: RelatedContextResult | null, format: OutputFormat): string {
  if (!result) {
    return format === 'json' ? asJson(null) : 'No related context found.\n';
  }

  if (format === 'json') {
    return asJson(result);
  }

  if (format === 'markdown') {
    return [
      `## ${result.symbol.qualifiedName}`,
      '',
      '### Related calls',
      '',
      ...result.relatedCalls.map((call) => `- ${call.qualifiedName}`),
      '',
      '### Siblings',
      '',
      ...result.siblings.map((sibling) => `- ${sibling.qualifiedName}`),
      '',
    ].join('\n');
  }

  const lines = [
    `symbol\t${result.symbol.qualifiedName}`,
    'relatedCalls',
    ...result.relatedCalls.map((call) => `${call.qualifiedName}\t${call.filePath}:${call.startLine}`),
    'siblings',
    ...result.siblings.map((sibling) => `${sibling.qualifiedName}\t${sibling.filePath}:${sibling.startLine}`),
    'references',
    ...result.references.map((ref) => `${ref.kind}\t${ref.filePath}:${ref.line}\t${ref.snippet}`),
  ];
  return `${lines.join('\n')}\n`;
}

export function formatReferences(result: ReferencesResult, format: OutputFormat): string {
  if (format === 'json') {
    return asJson(result);
  }

  if (format === 'markdown') {
    const lines = ['| Kind | File | Line | Snippet |', '| --- | --- | ---: | --- |'];
    for (const match of result.matches) {
      lines.push(`| ${match.kind} | ${match.filePath} | ${match.line} | ${match.snippet} |`);
    }
    return `${lines.join('\n')}\n`;
  }

  const header = 'kind\tfile\tline\tsnippet';
  const rows = result.matches.map((match) => [match.kind, match.filePath, match.line, match.snippet].join('\t'));
  return `${[`query\t${result.query}`, header, ...rows].join('\n')}\n`;
}

export function formatTrace(trace: CallTrace | null, format: OutputFormat): string {
  if (!trace) {
    return format === 'json' ? asJson(null) : 'No call trace found.\n';
  }

  if (format === 'json') {
    return asJson(trace);
  }

  if (format === 'markdown') {
    const lines = [`## Trace: ${trace.root.qualifiedName}`, '', '### Edges', ''];
    for (const edge of trace.edges) {
      lines.push(`- ${edge.from} -> ${edge.to} (${edge.label})`);
    }
    lines.push('');
    return lines.join('\n');
  }

  const header = 'depth\tfrom\tto\tlabel';
  const rows = trace.edges.map((edge) => {
    const toNode = trace.nodes.find((node) => node.symbol.id === edge.to);
    return [toNode?.depth ?? 0, edge.from, edge.to, edge.label].join('\t');
  });
  return `${[`root\t${trace.root.qualifiedName}`, header, ...rows].join('\n')}\n`;
}

export function formatTypeTrace(trace: TypeTrace | null, format: OutputFormat): string {
  if (!trace) {
    return format === 'json' ? asJson(null) : 'No type trace found.\n';
  }
  return formatTrace(trace, format);
}

export function formatOverview(overview: ArchitectureOverview, format: OutputFormat): string {
  if (format === 'json') {
    return asJson(overview);
  }

  if (format === 'markdown') {
    const lines = [
      '# Project overview',
      '',
      `- Generated: ${overview.generatedAt}`,
      `- Files: ${overview.totalFiles}`,
      `- Symbols: ${overview.totalSymbols}`,
      `- Exported symbols: ${overview.exportedSymbols}`,
      '',
      '## Top files',
      '',
      '| File | Symbols | Imports |',
      '| --- | ---: | ---: |',
      ...overview.topFiles.map((file) => `| ${file.path} | ${file.symbolCount} | ${file.imports} |`),
      '',
    ];
    return lines.join('\n');
  }

  const lines = [
    `generatedAt\t${overview.generatedAt}`,
    `totalFiles\t${overview.totalFiles}`,
    `totalSymbols\t${overview.totalSymbols}`,
    `exportedSymbols\t${overview.exportedSymbols}`,
  ];
  for (const [kind, count] of Object.entries(overview.byKind)) {
    lines.push(`kind:${kind}\t${count}`);
  }
  for (const file of overview.topFiles) {
    lines.push(`file\t${file.path}\t${file.symbolCount}\t${file.imports}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatModuleDependencies(result: ModuleDependenciesResult | null, format: OutputFormat): string {
  if (!result) {
    return format === 'json' ? asJson(null) : 'No module dependencies found.\n';
  }

  if (format === 'json') {
    return asJson(result);
  }

  if (format === 'markdown') {
    return [
      `## ${result.modulePath}`,
      '',
      '### Imports',
      '',
      ...result.imports.map((item) => `- ${item}`),
      '',
      '### Imported by',
      '',
      ...result.importedBy.map((item) => `- ${item}`),
      '',
    ].join('\n');
  }

  const lines = [
    `module\t${result.modulePath}`,
    'imports',
    ...result.imports,
    'importedBy',
    ...result.importedBy,
  ];
  return `${lines.join('\n')}\n`;
}

export function formatSuggestedRelated(result: SuggestedRelatedResult, format: OutputFormat): string {
  if (format === 'json') {
    return asJson(result);
  }

  if (format === 'markdown') {
    const lines = ['| Score | Symbol | Reasons |', '| ---: | --- | --- |'];
    for (const entry of result.suggestions) {
      lines.push(`| ${entry.score} | ${entry.symbol.qualifiedName} | ${entry.reasons.join(', ')} |`);
    }
    return `${lines.join('\n')}\n`;
  }

  const header = 'score\tname\tfile\treasons';
  const rows = result.suggestions.map((entry) =>
    [entry.score, entry.symbol.qualifiedName, `${entry.symbol.filePath}:${entry.symbol.startLine}`, entry.reasons.join(',')].join('\t')
  );
  return `${[`query\t${result.query}`, header, ...rows].join('\n')}\n`;
}

export function formatStatus(
  status: {
    localIndexExists: boolean;
    localSymbolCount: number;
    localFileCount: number;
    remoteStatus?: RemoteProjectStatus | null;
    configPath: string;
  },
  format: OutputFormat
): string {
  if (format === 'json') {
    return asJson(status);
  }

  if (format === 'markdown') {
    return [
      '# Status',
      '',
      `- Config: ${status.configPath}`,
      `- Local index: ${status.localIndexExists ? 'present' : 'missing'}`,
      `- Local files: ${status.localFileCount}`,
      `- Local symbols: ${status.localSymbolCount}`,
      status.remoteStatus
        ? `- Remote: ${status.remoteStatus.projectId} (${status.remoteStatus.fileCount} files / ${status.remoteStatus.symbolCount} symbols)`
        : '- Remote: not configured',
      '',
    ].join('\n');
  }

  const lines = [
    `config\t${status.configPath}`,
    `localIndexExists\t${status.localIndexExists}`,
    `localFiles\t${status.localFileCount}`,
    `localSymbols\t${status.localSymbolCount}`,
  ];
  if (status.remoteStatus) {
    lines.push(`remoteProjectId\t${status.remoteStatus.projectId}`);
    lines.push(`remoteFiles\t${status.remoteStatus.fileCount}`);
    lines.push(`remoteSymbols\t${status.remoteStatus.symbolCount}`);
  } else {
    lines.push('remote\tunconfigured');
  }
  return `${lines.join('\n')}\n`;
}
