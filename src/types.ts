export type SymbolKind = 'function' | 'class' | 'interface' | 'method' | 'type' | 'variable';
export type SourceLanguage = 'typescript' | 'javascript';
export type OutputFormat = 'json' | 'compact' | 'markdown';

export interface IndexedSymbol {
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
  containerName?: string;
  source: string;
  calls: string[];
  imports: string[];
}

export interface IndexedFile {
  path: string;
  language: SourceLanguage;
  imports: string[];
  symbolIds: string[];
  hash: string;
}

export interface IndexArtifact {
  schemaVersion: '1';
  generatedAt: string;
  rootDir: string;
  include: string[];
  exclude: string[];
  files: IndexedFile[];
  symbols: IndexedSymbol[];
}

export interface SearchOptions {
  kind?: SymbolKind;
  language?: SourceLanguage;
  exported?: boolean;
  limit?: number;
}

export interface SearchResult {
  symbol: IndexedSymbol;
  score: number;
}

export interface FunctionQueryResult {
  symbol: IndexedSymbol;
  resolvedCalls: IndexedSymbol[];
}

export interface ClassQueryResult {
  symbol: IndexedSymbol;
  methods: IndexedSymbol[];
}

export interface RelatedContextResult {
  symbol: IndexedSymbol;
  siblings: IndexedSymbol[];
  relatedCalls: IndexedSymbol[];
  references: ReferenceMatch[];
}

export interface ReferenceMatch {
  filePath: string;
  line: number;
  kind: 'symbol' | 'import';
  snippet: string;
  symbolId?: string;
}

export interface ReferencesResult {
  query: string;
  matches: ReferenceMatch[];
}

export interface TraceNode {
  symbol: IndexedSymbol;
  depth: number;
}

export interface TraceEdge {
  from: string;
  to: string;
  label: string;
}

export interface CallTrace {
  root: IndexedSymbol;
  nodes: TraceNode[];
  edges: TraceEdge[];
}

export interface TypeTrace {
  root: IndexedSymbol;
  nodes: TraceNode[];
  edges: TraceEdge[];
}

export interface ArchitectureOverview {
  generatedAt: string;
  totalFiles: number;
  totalSymbols: number;
  exportedSymbols: number;
  byKind: Record<SymbolKind, number>;
  topFiles: Array<{
    path: string;
    symbolCount: number;
    imports: number;
  }>;
}

export interface FileListEntry {
  path: string;
  language: SourceLanguage;
  symbolCount: number;
  imports: number;
}

export interface FunctionListResult {
  functions: IndexedSymbol[];
}

export interface ModuleDependenciesResult {
  modulePath: string;
  imports: string[];
  importedBy: string[];
  symbols: IndexedSymbol[];
}

export interface SuggestionEntry {
  symbol: IndexedSymbol;
  score: number;
  reasons: string[];
}

export interface SuggestedRelatedResult {
  query: string;
  suggestions: SuggestionEntry[];
}

export interface ProjectConfig {
  schemaVersion: 1;
  include: string[];
  exclude: string[];
  outputPath: string;
  remote: {
    projectId: string;
    apiBaseUrl?: string | undefined;
    preferRemote: boolean;
  };
  privacy: {
    uploadSource: boolean;
    redactPatterns: string[];
  };
  skill: {
    name: string;
    directory: string;
  };
  cloudflare: {
    directory: string;
  };
}

export interface UserConfig {
  schemaVersion: 1;
  apiBaseUrl?: string | undefined;
  workerApiToken?: string | undefined;
  cloudflareApiToken?: string | undefined;
}

export type ConfigSource =
  | 'cli'
  | 'env-file'
  | 'env'
  | 'user-config'
  | 'project-config'
  | 'default'
  | 'absent';

export interface ResolvedValue<T> {
  value: T;
  source: ConfigSource;
}

export interface RuntimeOverrides {
  envFile?: string | undefined;
  apiBaseUrl?: string | undefined;
  workerApiToken?: string | undefined;
  cloudflareApiToken?: string | undefined;
  projectId?: string | undefined;
  preferRemote?: boolean | undefined;
  uploadSource?: boolean | undefined;
}

export interface AuthInputOverrides {
  envFile?: string | undefined;
  apiBaseUrl?: string | undefined;
  workerApiToken?: string | undefined;
  cloudflareApiToken?: string | undefined;
}

export interface ResolvedRuntimeConfig {
  projectConfig: ProjectConfig;
  userConfig: UserConfig;
  envFilePath?: string | undefined;
  resolved: {
    projectId: ResolvedValue<string>;
    apiBaseUrl: ResolvedValue<string | undefined>;
    workerApiToken: ResolvedValue<string | undefined>;
    cloudflareApiToken: ResolvedValue<string | undefined>;
    preferRemote: ResolvedValue<boolean>;
    uploadSource: ResolvedValue<boolean>;
  };
}

export interface ResolvedAuthInput {
  envFilePath?: string | undefined;
  apiBaseUrl: ResolvedValue<string | undefined>;
  workerApiToken: ResolvedValue<string | undefined>;
  cloudflareApiToken: ResolvedValue<string | undefined>;
}

export interface RemoteAccessConfig {
  projectId: string;
  apiBaseUrl?: string | undefined;
  workerApiToken?: string | undefined;
  cloudflareApiToken?: string | undefined;
}

export interface RemoteProjectStatus {
  projectId: string;
  updatedAt: string;
  symbolCount: number;
  fileCount: number;
  schemaVersion: string;
}

export interface CloudStore {
  putIndex(projectId: string, artifact: IndexArtifact): Promise<RemoteProjectStatus>;
  getIndex(projectId: string): Promise<IndexArtifact | null>;
  getStatus(projectId: string): Promise<RemoteProjectStatus | null>;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run(): Promise<unknown>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export interface R2ObjectBodyLike {
  text(): Promise<string>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: string): Promise<void>;
}

export interface WorkerEnvLike {
  DB?: D1DatabaseLike;
  INDEX_BUCKET?: R2BucketLike;
  API_TOKEN?: string;
}
