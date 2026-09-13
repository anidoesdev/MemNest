import type {
  MissingEmbedding,
  ProfilePolicy,
  StoredProfile,
  ContainerRecord,
  EmbeddingWrite,
  JobRecord,
  JobStatus,
  Chunk,
  ConversationTurn,
  Document,
  DocumentQuery,
  ExtractionRun,
  GraphSnapshot,
  Job,
  JobHandler,
  JobRunSummary,
  LineageGraph,
  Memory,
  MemoryFilter,
  Page,
  RowByTarget,
  Scope,
  Scored,
  SearchTarget,
  SnapshotOpts,
  StoreSearchOpts,
} from './types';

export interface StoreCapabilities {
  vector: boolean;
  fullText: boolean;
  transactions: boolean;
}

/**
 * Every method takes a Scope. Implementations MUST:
 *  - reject writes whose rows belong to a different container (ScopeViolationError)
 *  - never return rows outside `scope.containerTag` from a read
 *  - treat ids that exist in another container as not found
 */
export interface MemoryStoreOps {
  putDocument(scope: Scope, doc: Document): Promise<void>;
  putChunks(scope: Scope, chunks: Chunk[]): Promise<void>;
  putExtractionRun(scope: Scope, run: ExtractionRun): Promise<void>;
  /** Rejects memories without sourceDocumentIds or extractionRunId (ProvenanceError). */
  putMemories(scope: Scope, memories: Memory[]): Promise<void>;
  /** Marks `oldId` not-latest. Both must exist in scope; `newId` must supersede `oldId`. */
  supersede(scope: Scope, oldId: string, newId: string): Promise<void>;
  reinforce(scope: Scope, memoryId: string, sourceDocumentId: string): Promise<void>;
  forget(scope: Scope, memoryId: string, at: string): Promise<void>;

  getDocument(scope: Scope, id: string): Promise<Document | null>;
  findDocuments(scope: Scope, query: DocumentQuery): Promise<Document[]>;
  getChunks(scope: Scope, documentId: string): Promise<Chunk[]>;
  /** Tombstones the document: clears content, removes chunks, keeps the row for provenance. */
  deleteDocument(scope: Scope, id: string, at: string): Promise<void>;
  getMemory(scope: Scope, id: string): Promise<Memory | null>;

  getContainer(scope: Scope): Promise<ContainerRecord | null>;
  /**
   * Records `provider` as the container's embedding provider if none is recorded, atomically.
   * Throws EmbeddingProviderMismatchError when a different provider is already recorded.
   */
  lockEmbeddingProvider(scope: Scope, provider: { id: string; dimensions: number }, at: string): Promise<ContainerRecord>;
  /**
   * Stores vectors for chunks or memories in scope. The container must be locked and every
   * vector must have its dimensions. Stores without vector capability throw ConfigurationError.
   */
  putEmbeddings(scope: Scope, target: SearchTarget, items: EmbeddingWrite[]): Promise<void>;
  /**
   * Rows without a vector: memories of any state, and chunks of latest, non-deleted documents.
   * Stores without vector capability return [].
   */
  listMissingEmbeddings(scope: Scope, target: SearchTarget, limit: number): Promise<MissingEmbedding[]>;

  getProfile(scope: Scope): Promise<StoredProfile | null>;
  /** Replaces the cached profile, change counter and queue marker included. */
  putProfile(scope: Scope, profile: StoredProfile): Promise<void>;
  /**
   * Atomically adds `changes` to the container's counter and decides whether a rebuild is due
   * (never built, threshold reached, or stale) and not already queued. When it returns true the
   * rebuild is marked queued, so concurrent callers never both rebuild.
   */
  noteProfileChanges(scope: Scope, changes: number, policy: ProfilePolicy): Promise<boolean>;
  /** Newest first. With `documentId`, only runs that used that document. */
  listExtractionRuns(scope: Scope, opts: { limit: number; documentId?: string }): Promise<ExtractionRun[]>;

  /**
   * Returns chunks of latest, non-deleted documents only. Memories are returned
   * regardless of isLatest / forgottenAt / validUntil: recall filters them so the
   * trace can say why.
   */
  lexicalSearch<T extends SearchTarget>(
    q: string,
    scope: Scope,
    opts: StoreSearchOpts<T>,
  ): Promise<Scored<RowByTarget[T]>[]>;
  vectorSearch<T extends SearchTarget>(
    v: Float32Array,
    scope: Scope,
    opts: StoreSearchOpts<T>,
  ): Promise<Scored<RowByTarget[T]>[]>;

  getLineage(scope: Scope, memoryId: string): Promise<LineageGraph | null>;
  listMemories(scope: Scope, page: Page, filter?: MemoryFilter): Promise<Memory[]>;
  graphSnapshot(scope: Scope, opts: SnapshotOpts): Promise<GraphSnapshot>;

  /** Hard delete of every row in the container (D6). */
  deleteContainer(scope: Scope): Promise<void>;
}

export interface MemoryStore extends MemoryStoreOps {
  capabilities(): StoreCapabilities;
  /**
   * Runs `fn` atomically. Stores with `transactions: false` must throw
   * TransactionsUnsupportedError rather than run `fn` non-atomically.
   */
  transaction<T>(fn: (tx: MemoryStoreOps) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface EmbeddingProvider {
  /** e.g. "openai:text-embedding-3-small" */
  id: string;
  dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface CompletionRequest {
  system?: string;
  messages: ConversationTurn[];
  /** JSON schema the response must satisfy. */
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  temperature?: number;
  maxTokens?: number;
}

export interface CompletionResponse {
  /** Parsed JSON conforming to the request schema. */
  json: unknown;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface CompletionProvider {
  /** e.g. "ollama:llama3.1:8b". Recorded on extraction runs. */
  id?: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

/**
 * Consumers may supply their own (e.g. BullMQ). `runDue` and `stop` are optional
 * because external queues may not be able to offer them.
 */
export interface JobQueue {
  enqueue(job: Job): Promise<void>;
  /** Starts processing in the background until `stop()`. */
  process(handler: JobHandler): void;
  /** Processes every job that is due now, then resolves. */
  runDue?(handler: JobHandler): Promise<JobRunSummary>;
  /** Stops background processing and waits for the job in flight. */
  stop?(): Promise<void>;
}

/** A queue whose jobs can be listed and retried per container (the CLI and, later, the server use this). */
export interface InspectableJobQueue extends JobQueue {
  runDue(handler?: JobHandler): Promise<JobRunSummary>;
  stop(): Promise<void>;
  list(scope: Scope, filter?: { status?: JobStatus; limit?: number }): Promise<JobRecord[]>;
  /** Puts a failed job back in the queue, due now, with its attempts reset. */
  retry(scope: Scope, jobId: string): Promise<void>;
}

/** Persistence behind `createJobQueue`. Implementations must make `claim` atomic. */
export interface JobStorage {
  insert(job: Job, options: { maxAttempts: number; now: string }): Promise<void>;
  /**
   * Atomically takes the next job that is pending and due, or running with an expired
   * lease (its worker died). Increments attempts and sets the lease.
   */
  claim(now: string, lockedUntil: string): Promise<ClaimedJob | null>;
  complete(id: string, now: string): Promise<void>;
  /** Back to pending at `runAt`. `countAttempt: false` gives the attempt back (deferrals). */
  reschedule(id: string, runAt: string, options: { now: string; error?: string; countAttempt: boolean }): Promise<void>;
  fail(id: string, error: string, now: string): Promise<void>;
}

export interface ClaimedJob {
  job: Job;
  /** Including this one. */
  attempts: number;
  maxAttempts: number;
}

export interface Redactor {
  redact(text: string): string;
}

export interface TokenCounter {
  count(text: string): number;
}

export interface Clock {
  /** ISO 8601 timestamp. */
  now(): string;
}

export interface IdGenerator {
  next(prefix: 'doc' | 'chk' | 'mem' | 'run' | 'job'): string;
}
