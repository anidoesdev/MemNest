/** "user:123", "workflow:abc", "org:acme". A hard isolation boundary. */
export type ContainerTag = string;

/**
 * Every store read and write is bound to exactly one container. There is no
 * unscoped query path. Build one with `scopeOf()`, which validates the tag.
 */
export interface Scope {
  readonly containerTag: ContainerTag;
}

export type Metadata = Record<string, string | number | boolean>;

export interface ConversationTurn {
  role: string;
  content: string;
  name?: string;
  /** ISO timestamp of the turn, if known. */
  at?: string;
}

export type ExtractionMode = 'instant' | 'batched' | 'none';

export interface AddInput {
  content: string | ConversationTurn[];
  containerTag: ContainerTag;
  /** Stable identity across re-ingest. */
  customId?: string;
  metadata?: Metadata;
  /** When the content is ABOUT. */
  documentDate?: string;
  /** Default 'batched'. */
  extraction?: ExtractionMode;
}

export interface AddResult {
  documentId: string;
  status: DocumentStatus;
  version: number;
  /** True when the same content was already ingested; nothing was written. */
  deduplicated: boolean;
  /** Present when an extraction job was enqueued. */
  jobId?: string;
}

export type DocumentKind = 'conversation' | 'markdown' | 'text' | 'direct';

export type DocumentStatus = 'indexed' | 'extracting' | 'extracted' | 'failed';

export interface Document {
  id: string;
  containerTag: ContainerTag;
  customId?: string;
  kind: DocumentKind;
  /** Normalized and redacted. Raw input is never persisted. */
  content: string;
  /** SHA-256 of the redacted input. */
  contentHash: string;
  metadata: Metadata;
  documentDate?: string;
  status: DocumentStatus;
  extraction: ExtractionMode;
  version: number;
  isLatest: boolean;
  previousVersionId?: string;
  /**
   * Tombstone. A deleted document loses its content and chunks but keeps its row,
   * so memories extracted from it still have a traceable source.
   */
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Chunk {
  id: string;
  documentId: string;
  containerTag: ContainerTag;
  index: number;
  content: string;
  /** Document-level summary prepended before embedding (contextual chunking). */
  context?: string;
  tokens: number;
  createdAt: string;
}

export type MemoryKind = 'fact' | 'preference' | 'episode';

export const MEMORY_KINDS: readonly MemoryKind[] = ['fact', 'preference', 'episode'];

export interface Memory {
  id: string;
  containerTag: ContainerTag;
  /** Atomic, self-contained, one topic. */
  content: string;
  kind: MemoryKind;
  /** 0..1, from the extractor. */
  confidence: number;
  isLatest: boolean;
  version: number;
  /** Memory id this UPDATES. */
  supersedes?: string;
  /** Memory ids this ENRICHES. */
  extendsIds: string[];
  /** Never empty. */
  sourceDocumentIds: string[];
  extractionRunId: string;
  validFrom: string;
  /** Time-based expiry. */
  validUntil?: string;
  /** Soft delete. */
  forgottenAt?: string;
  /** Preferences strengthen with repetition. Starts at 1. */
  reinforcementCount: number;
  /** When the engine wrote the row. Orders pagination and the temporal view. */
  createdAt: string;
}

export interface ExtractionRun {
  id: string;
  containerTag: ContainerTag;
  /** 'direct' runs record memories written through the API, bypassing extraction. */
  method: 'llm' | 'direct';
  documentIds: string[];
  model?: string;
  promptVersion?: string;
  status: 'running' | 'succeeded' | 'failed';
  error?: string;
  stats?: ExtractionStats;
  startedAt: string;
  finishedAt?: string;
}

export type CandidateRejection =
  | 'malformed'
  | 'empty'
  | 'too-long'
  | 'unresolved-pronoun'
  | 'secret'
  | 'low-confidence'
  | 'already-expired'
  | 'duplicate-in-batch';

export interface ResolutionDecision {
  /** The candidate as written. */
  content: string;
  relation: 'new' | 'duplicate' | 'updates' | 'extends';
  /** The existing (or same-batch) memory it relates to. */
  memoryId?: string;
  /** The model's short explanation, redacted. */
  reason?: string;
  /**
   * How the decision was reached: no similar memories, an exact text match, the model,
   * the model failing twice (treated as new), or a plan invalidated at write time.
   */
  via: 'no-neighbors' | 'exact' | 'model' | 'fallback' | 'conflict';
  /** The memory written or reinforced. */
  resultId?: string;
}

export interface ExtractionStats {
  /** Extraction completion calls (long transcripts are split into windows). */
  calls: number;
  /** Resolution completion calls, at most one per candidate plus retries. */
  resolutionCalls: number;
  /** One per accepted candidate, in order. */
  decisions: ResolutionDecision[];
  candidates: number;
  accepted: number;
  /** Candidates dropped by deterministic screening. Content is redacted before it is stored. */
  rejected: Array<{ content: string; reason: CandidateRejection }>;
  created: number;
  reinforced: number;
  updated: number;
  extended: number;
  /** Chunks re-embedded with a document summary (contextual chunking). */
  contextualizedChunks: number;
  /** Why contextual chunking was skipped or failed, if it was. Extraction continues regardless. */
  contextError?: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** A memory written directly, bypassing extraction. Still gets a source document and run. */
export interface DirectMemoryInput {
  containerTag: ContainerTag;
  memories: Array<{
    content: string;
    kind?: MemoryKind;
    confidence?: number;
    validFrom?: string;
    validUntil?: string;
    /** Explicit UPDATES relation to an existing latest memory in the same container. */
    supersedes?: string;
    /** Explicit EXTENDS relations to existing memories in the same container. */
    extendsIds?: string[];
  }>;
  metadata?: Metadata;
}

// ---------------------------------------------------------------------------
// Store query shapes

export interface Scored<T> {
  row: T;
  /** Higher is better. */
  score: number;
  /** 1-based position in the list it came from. */
  rank: number;
}

export type SearchTarget = 'memories' | 'chunks';

export interface RowByTarget {
  memories: Memory;
  chunks: Chunk;
}

export interface StoreSearchOpts<T extends SearchTarget = SearchTarget> {
  target: T;
  k: number;
}

export interface Page {
  limit: number;
  /** Id of the last memory of the previous page. */
  after?: string;
}

export interface MemoryFilter {
  kind?: MemoryKind;
  /** Default false: superseded memories are listed too. */
  latestOnly?: boolean;
  /** Default false. */
  includeForgotten?: boolean;
}

export interface DocumentQuery {
  customId?: string;
  contentHash?: string;
  latestOnly?: boolean;
}

export type LineageRelation = 'updates' | 'extends' | 'source';

export interface LineageEdge {
  /** The newer memory (for updates/extends) or the memory (for source). */
  from: string;
  /** The older memory (for updates/extends) or the document (for source). */
  to: string;
  relation: LineageRelation;
}

export type DocumentRef = Pick<
  Document,
  'id' | 'customId' | 'kind' | 'version' | 'isLatest' | 'documentDate' | 'createdAt' | 'deletedAt'
>;

export interface LineageGraph {
  rootId: string;
  memories: Memory[];
  documents: DocumentRef[];
  edges: LineageEdge[];
}

export interface SnapshotOpts {
  /** Maximum nodes, newest first. Default 2000. */
  limit?: number;
  /** Default true. */
  includeSuperseded?: boolean;
  /** Default false. */
  includeForgotten?: boolean;
}

export interface GraphNode {
  id: string;
  content: string;
  kind: MemoryKind;
  confidence: number;
  isLatest: boolean;
  forgotten: boolean;
  reinforcementCount: number;
  validFrom: string;
  validUntil?: string;
  createdAt: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: 'updates' | 'extends';
}

export interface GraphSnapshot {
  containerTag: ContainerTag;
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalMemories: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Jobs

export interface ExtractionJob {
  id: string;
  type: 'extract';
  containerTag: ContainerTag;
  documentId: string;
  customId?: string;
  mode: 'instant' | 'batched';
  /** Earliest time the job may run. Batched jobs wait for the grouping window. */
  runAt: string;
}

export interface ProfileJob {
  id: string;
  type: 'profile';
  containerTag: ContainerTag;
  runAt: string;
}

export type Job = ExtractionJob | ProfileJob;

/** Returned by a handler that is not ready yet: the job runs again at `deferUntil` without spending an attempt. */
export interface JobDeferral {
  deferUntil: string;
}

export type JobHandler = (job: Job) => Promise<void | JobDeferral>;

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface JobRecord {
  job: Job;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobRunSummary {
  processed: number;
  succeeded: number;
  deferred: number;
  retried: number;
  failed: number;
}

export type JobEvent =
  | { type: 'started'; job: Job; attempt: number }
  | { type: 'succeeded'; job: Job; attempt: number }
  | { type: 'deferred'; job: Job; until: string }
  | { type: 'retrying'; job: Job; attempt: number; at: string; error: string }
  | { type: 'failed'; job: Job; attempt: number; error: string }
  | { type: 'error'; error: string };

// ---------------------------------------------------------------------------
// Recall

export interface SearchOptions {
  /** Pack as much as fits, highest value first. Default 2000. */
  tokenBudget?: number;
  /** Candidate pool size requested from each retriever. Default 50. */
  candidates?: number;
  /**
   * LLM rerank of eligible memory candidates before packing. Needs a completion provider.
   * `true` uses the defaults: top 20 candidates, drop those scored below 0.2.
   */
  rerank?: boolean | { topN?: number; minScore?: number };
  /** Vector hits with cosine similarity at or below this are ignored. Default 0. */
  minVectorScore?: number;
}

/** Per-container settings the engine persists. */
export interface ContainerRecord {
  containerTag: ContainerTag;
  /** The embedding provider every vector in this container came from (the dimension lock). */
  embeddingProviderId?: string;
  embeddingDimensions?: number;
  createdAt: string;
}

export interface EmbeddingWrite {
  /** Chunk or memory id, in the store's scope. */
  id: string;
  embedding: Float32Array;
}

export interface MemoryResult {
  memory: Memory;
  score: number;
  tokens: number;
}

export interface ChunkResult {
  chunk: Chunk;
  score: number;
  tokens: number;
}

export type ExcludedReason = 'not-latest' | 'expired' | 'forgotten' | 'budget' | 'rerank';

export interface TraceCandidate {
  memoryId: string;
  lexicalRank?: number;
  lexicalScore?: number;
  vectorRank?: number;
  vectorScore?: number;
  rrfScore: number;
  rerankScore?: number;
  included: boolean;
  excludedReason?: ExcludedReason;
  tokens: number;
}

export interface RecallTrace {
  query: string;
  rewrittenQuery?: string;
  degraded?: string;
  candidates: TraceCandidate[];
  budget: { limit: number; used: number };
  timings: Record<string, number>;
}

export interface SearchResponse {
  memories: MemoryResult[];
  chunks: ChunkResult[];
  trace: RecallTrace;
}

export interface ProfileItem {
  /** One self-contained sentence. */
  text: string;
  /** The memories it states. Never empty: a profile line with no source is a bug, like a memory with none. */
  memoryIds: string[];
  /** The earliest expiry among its memories; the item is hidden once this passes. */
  expiresAt?: string;
}

/** What the store caches for a container. */
export interface StoredProfile {
  containerTag: ContainerTag;
  stable: ProfileItem[];
  recent: ProfileItem[];
  /** Latest, remembered memories the build considered. */
  memoryCount: number;
  builtAt: string;
  /** 'llm' condenses with the completion provider; 'deterministic' ranks memories verbatim. */
  builder: 'llm' | 'deterministic';
  /** Why an LLM build fell back, when it did. */
  buildNote?: string;
  /** Memory changes recorded since the build. */
  changesSinceBuild: number;
  /** Set while a rebuild is queued or running. */
  rebuildQueuedAt?: string;
}

export interface Profile {
  containerTag: ContainerTag;
  /** Durable facts and preferences, most important first. */
  stable: ProfileItem[];
  /** Short digest of recent activity. */
  recent: ProfileItem[];
  /** Prompt-ready rendering of both sections. */
  text: string;
  tokens: number;
  memoryCount: number;
  /** Null when the container has never had a profile built. */
  builtAt: string | null;
  builder: 'llm' | 'deterministic' | 'none';
  /** True when a rebuild is due or queued; the profile is still safe to use (see forget/supersede invalidation). */
  stale: boolean;
}

export interface ProfilePolicy {
  /** Rebuild once this many memory changes accumulate. */
  threshold: number;
  /** Rebuild once the profile is older than this. */
  staleAfterMs: number;
  /** A queued rebuild older than this is assumed lost and may be queued again. */
  requeueAfterMs: number;
  now: string;
}

export interface MissingEmbedding {
  id: string;
  content: string;
  /** Chunks only: the document summary prepended before embedding. */
  context?: string;
}

export interface DocumentWithChunks {
  document: Document;
  chunks: Chunk[];
}
