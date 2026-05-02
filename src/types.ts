export type SymbolKind = 'function' | 'class' | 'interface' | 'method' | 'type' | 'variable' | 'constructor' | 'callback';
export type SourceLanguage = 'typescript' | 'javascript' | 'python';
export type OutputFormat = 'json' | 'compact' | 'markdown';

export type ReferenceKind = 'call' | 'read' | 'write' | 'type' | 'import';
export type TypeRelationshipKind = 'extends' | 'implements' | 'mixin' | 'references-type';

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
  containerName?: string | undefined;
  source: string;
  calls: string[];
  imports: string[];
  documentation?: string | undefined;
  parameters: string[];
  returnType?: string | undefined;
  typeReferences: string[];
  extendsTypes: string[];
  implementsTypes: string[];
}

export interface IndexedFile {
  path: string;
  language: SourceLanguage;
  imports: string[];
  symbolIds: string[];
  hash: string;
  size: number;
}

export interface IndexedReference {
  id: string;
  symbolId?: string | undefined;
  symbolName: string;
  referencingFile: string;
  referencingSymbolId?: string | undefined;
  referencingSymbolName?: string | undefined;
  line: number;
  column: number;
  kind: ReferenceKind;
  snippet: string;
}

export interface CallGraphEdge {
  id: string;
  callerSymbolId: string;
  callerName: string;
  calleeName: string;
  calleeSymbolId?: string | undefined;
  callCount: number;
  isAsync: boolean;
  isConditional: boolean;
}

export interface TypeRelationship {
  id: string;
  sourceSymbolId: string;
  sourceName: string;
  targetName: string;
  targetSymbolId?: string | undefined;
  relationshipKind: TypeRelationshipKind;
}

export interface LanguageStats {
  files: number;
  functions: number;
  classes: number;
  interfaces: number;
  typeAliases: number;
  variables: number;
}

export interface IndexStats {
  totalFiles: number;
  totalSymbols: number;
  totalFunctions: number;
  totalClasses: number;
  totalInterfaces: number;
  totalVariables: number;
  totalTypes: number;
  byLanguage: Record<SourceLanguage, LanguageStats>;
  generatedAt: string;
  artifactSizeBytes: number;
}

export interface IndexArtifact {
  schemaVersion: '2';
  generatedAt: string;
  rootDir: string;
  directories: string[];
  include: string[];
  exclude: string[];
  files: IndexedFile[];
  symbols: IndexedSymbol[];
  references: IndexedReference[];
  callGraph: CallGraphEdge[];
  typeRelationships: TypeRelationship[];
  stats: IndexStats;
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
  relatedTypes: IndexedSymbol[];
  references: ReferenceMatch[];
  tests: ReferenceMatch[];
}

export interface ReferenceMatch {
  filePath: string;
  line: number;
  kind: ReferenceKind;
  snippet: string;
  symbolId?: string | undefined;
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
  byLanguage: Record<SourceLanguage, LanguageStats>;
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
  schemaVersion: 2;
  directories: string[];
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

export type RemoteMode = 'worker' | 'direct';

export interface UserConfig {
  schemaVersion: 1;
  apiBaseUrl?: string | undefined;
  workerApiToken?: string | undefined;
  cloudflareApiToken?: string | undefined;
  accountId?: string | undefined;
  d1DatabaseId?: string | undefined;
  r2Bucket?: string | undefined;
  r2AccessKeyId?: string | undefined;
  r2SecretAccessKey?: string | undefined;
}

export interface DirectCloudflareConfig {
  accountId: string;
  d1DatabaseId: string;
  r2Bucket: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
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
  accountId?: string | undefined;
  d1DatabaseId?: string | undefined;
  r2Bucket?: string | undefined;
  r2AccessKeyId?: string | undefined;
  r2SecretAccessKey?: string | undefined;
  remoteMode?: RemoteMode | undefined;
}

export interface AuthInputOverrides {
  envFile?: string | undefined;
  apiBaseUrl?: string | undefined;
  workerApiToken?: string | undefined;
  cloudflareApiToken?: string | undefined;
  accountId?: string | undefined;
  d1DatabaseId?: string | undefined;
  r2Bucket?: string | undefined;
  r2AccessKeyId?: string | undefined;
  r2SecretAccessKey?: string | undefined;
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
    accountId: ResolvedValue<string | undefined>;
    d1DatabaseId: ResolvedValue<string | undefined>;
    r2Bucket: ResolvedValue<string | undefined>;
    r2AccessKeyId: ResolvedValue<string | undefined>;
    r2SecretAccessKey: ResolvedValue<string | undefined>;
    remoteMode: ResolvedValue<RemoteMode>;
  };
}

export interface ResolvedAuthInput {
  envFilePath?: string | undefined;
  apiBaseUrl: ResolvedValue<string | undefined>;
  workerApiToken: ResolvedValue<string | undefined>;
  cloudflareApiToken: ResolvedValue<string | undefined>;
  accountId: ResolvedValue<string | undefined>;
  d1DatabaseId: ResolvedValue<string | undefined>;
  r2Bucket: ResolvedValue<string | undefined>;
  r2AccessKeyId: ResolvedValue<string | undefined>;
  r2SecretAccessKey: ResolvedValue<string | undefined>;
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

export interface QueueSendResultLike {
  id?: string;
}

export interface QueueLike<T = unknown> {
  send(message: T): Promise<QueueSendResultLike | void>;
}

export interface DurableObjectIdLike {
  toString(): string;
}

export interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface WorkerEnvLike {
  DB?: D1DatabaseLike;
  INDEX_BUCKET?: R2BucketLike;
  API_TOKEN?: string;
  INDEX_QUEUE?: QueueLike<unknown>;
  PROJECT_LOCKS?: DurableObjectNamespaceLike;
}
