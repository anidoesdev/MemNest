import { approxTokenCounter, randomIds, systemClock } from './defaults';
import { ConfigurationError, NotFoundError, NotImplementedError, ProviderError, ValidationError } from './errors';
import { DEFAULT_EXTRACTION_OPTIONS, createExtractionHandler, type ExtractionOptions } from './extract/job';
import { exactDuplicateResolver, type Resolver } from './extract/resolve';
import { createLlmResolver } from './extract/resolve-llm';
import { contextualText } from './extract/context';
import {
  DEFAULT_PROFILE_OPTIONS,
  buildProfile,
  invalidateProfileItems,
  isProfileDue,
  renderProfile,
  type ProfileOptions,
} from './profile/build';
import { DEFAULT_CHUNK_OPTIONS, chunkContent, type ChunkOptions } from './ingest/chunk';
import { canonicalContent, sha256Hex } from './ingest/hash';
import { normalizeContent } from './ingest/normalize';
import { defaultRedactor, redactContent, redactMetadata } from './ingest/redact';
import type {
  Clock,
  CompletionProvider,
  EmbeddingProvider,
  IdGenerator,
  JobQueue,
  MemoryStore,
  Redactor,
  TokenCounter,
} from './ports';
import { createInMemoryJobQueue } from './queue';
import { recall } from './recall/search';
import { scopeOf } from './scope';
import type {
  AddInput,
  AddResult,
  Chunk,
  ChunkResult,
  DirectMemoryInput,
  Document,
  DocumentWithChunks,
  ExtractionJob,
  ExtractionMode,
  ExtractionRun,
  GraphSnapshot,
  JobHandler,
  JobRunSummary,
  ProfilePolicy,
  StoredProfile,
  LineageGraph,
  Memory,
  MemoryFilter,
  MemoryResult,
  Page,
  Profile,
  Scope,
  SearchOptions,
  SearchResponse,
  SnapshotOpts,
} from './types';
import { MEMORY_KINDS } from './types';
import { assertIsoDate } from './validate';

export interface MemnestOptions {
  store: MemoryStore;
  queue?: JobQueue;
  embedder?: EmbeddingProvider;
  completion?: CompletionProvider;
  redactor?: Redactor;
  tokenCounter?: TokenCounter;
  clock?: Clock;
  ids?: IdGenerator;
  chunking?: Partial<ChunkOptions>;
  extraction?: Partial<ExtractionOptions>;
  /** How extracted candidates relate to existing memories. Default: the LLM resolver using completion. */
  resolver?: Resolver;
  profile?: Partial<ProfileOptions>;
}

/**
 * Everything an application does with memory. Both the embedded engine and `@memnest/client`
 * implement it, so consumers switch embedded ↔ remote by changing one import (D2).
 */
export interface MemnestApi {
  /** Returns once the document is indexed. Extraction runs later (D7). */
  add(input: AddInput): Promise<AddResult>;
  getDocument(scope: Scope, id: string): Promise<DocumentWithChunks | null>;
  deleteDocument(scope: Scope, id: string): Promise<void>;

  /** Direct write, bypassing extraction. Provenance is still recorded. */
  addMemories(input: DirectMemoryInput): Promise<Memory[]>;
  getMemory(scope: Scope, id: string): Promise<Memory | null>;
  listMemories(scope: Scope, page?: Page, filter?: MemoryFilter): Promise<Memory[]>;
  getLineage(scope: Scope, memoryId: string): Promise<LineageGraph | null>;
  forget(scope: Scope, memoryId: string): Promise<Memory>;
  graph(scope: Scope, opts?: SnapshotOpts): Promise<GraphSnapshot>;

  searchMemories(query: string, scope: Scope, opts?: SearchOptions): Promise<MemoryResult[]>;
  searchDocuments(query: string, scope: Scope, opts?: SearchOptions): Promise<ChunkResult[]>;
  search(query: string, scope: Scope, opts?: SearchOptions): Promise<SearchResponse>;

  /**
   * The cached container profile: a fast read. When a rebuild is due it is queued (with a
   * completion provider) or built inline (without one). Forgotten and superseded facts are
   * removed from the cache immediately, never left for the next rebuild.
   */
  profile(scope: Scope): Promise<Profile>;
  /** Builds the profile now, bypassing the cache and the rebuild policy. */
  rebuildProfile(scope: Scope): Promise<Profile>;
  /** Hard delete of everything in the container (D6). */
  deleteContainer(scope: Scope): Promise<void>;

  /** Extraction runs, newest first, optionally for one document. */
  listExtractionRuns(scope: Scope, opts?: { limit?: number; documentId?: string }): Promise<ExtractionRun[]>;

  /** Releases resources: the embedded engine stops its worker and closes the store. */
  close(): Promise<void>;
}

/**
 * The embedded engine. Adds the operations that only make sense in the process that owns
 * the store and the queue: running the worker and backfilling embeddings.
 */
export interface Memnest extends MemnestApi {
  /** Embeds memories and chunks written before an embedding provider was configured. */
  backfillEmbeddings(scope: Scope, opts?: { batchSize?: number }): Promise<{ memories: number; chunks: number }>;
  /** Starts processing extraction jobs in the background. Requires a completion provider. */
  startWorker(): void;
  /** Processes every job that is due now, then resolves. Requires a queue that supports it. */
  processDueJobs(): Promise<JobRunSummary>;
  /** Stops the worker (waiting for the job in flight) and closes the store. */
  close(): Promise<void>;
}

const EXTRACTION_MODES: readonly ExtractionMode[] = ['instant', 'batched', 'none'];
const MAX_DIRECT_MEMORIES = 1000;

export function createMemnest(options: MemnestOptions): Memnest {
  if (!options?.store) throw new ConfigurationError('createMemnest requires a store');

  const store = options.store;
  const queue = options.queue ?? createInMemoryJobQueue();
  const redactor = options.redactor ?? defaultRedactor;
  const tokenCounter = options.tokenCounter ?? approxTokenCounter;
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? randomIds;
  const chunking: ChunkOptions = { ...DEFAULT_CHUNK_OPTIONS, ...options.chunking };
  const extractionOptions: ExtractionOptions = { ...DEFAULT_EXTRACTION_OPTIONS, ...options.extraction };
  const resolver =
    options.resolver ??
    (options.completion ? createLlmResolver({ completion: options.completion, redactor }) : exactDuplicateResolver);
  // Embeddings are written only where the store can search them; otherwise the engine degrades to lexical (D1).
  const embedder = options.embedder && store.capabilities().vector ? options.embedder : undefined;
  const recallDeps = { store, tokenCounter, clock, embedder: options.embedder, completion: options.completion };
  const locked = new Set<string>();

  /** Embeds texts after recording (or checking) the container's embedding provider. */
  async function embedFor(scope: Scope, texts: string[]): Promise<Float32Array[] | undefined> {
    if (!embedder || texts.length === 0) return undefined;
    if (!locked.has(scope.containerTag)) {
      await store.lockEmbeddingProvider(scope, { id: embedder.id, dimensions: embedder.dimensions }, clock.now());
      locked.add(scope.containerTag);
    }
    const vectors = await embedder.embed(texts);
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== embedder.dimensions)) {
      throw new ProviderError(embedder.id, `expected ${texts.length} embeddings of ${embedder.dimensions} dimensions`, { retryable: false });
    }
    return vectors;
  }

  function requireScope(scope: Scope): Scope {
    return scopeOf(scope?.containerTag);
  }

  const profileOptions: ProfileOptions = { ...DEFAULT_PROFILE_OPTIONS, ...options.profile };
  const profileCompletion = profileOptions.builder === 'deterministic' ? undefined : options.completion;
  const profilePolicy = (): ProfilePolicy => ({
    threshold: profileOptions.rebuildAfterChanges,
    staleAfterMs: profileOptions.staleAfterMs,
    requeueAfterMs: profileOptions.requeueAfterMs,
    now: clock.now(),
  });

  async function rebuild(scope: Scope): Promise<StoredProfile> {
    const built = await buildProfile(
      { store, tokenCounter, redactor, completion: profileCompletion, options: profileOptions },
      scope,
      clock.now(),
    );
    await store.putProfile(scope, built);
    return built;
  }

  /** A due rebuild is queued when it needs the model (and so a worker), and built inline when it does not. */
  async function scheduleRebuild(scope: Scope): Promise<StoredProfile | undefined> {
    if (!profileCompletion) return rebuild(scope);
    await queue.enqueue({ id: ids.next('job'), type: 'profile', containerTag: scope.containerTag, runAt: clock.now() });
    return undefined;
  }

  async function memoriesChanged(scope: Scope, changes: number, invalidated: readonly string[]): Promise<void> {
    if (invalidated.length > 0) {
      const cached = await store.getProfile(scope);
      const pruned = cached ? invalidateProfileItems(cached, invalidated) : null;
      if (pruned) await store.putProfile(scope, pruned);
    }
    if (await store.noteProfileChanges(scope, changes, profilePolicy())) await scheduleRebuild(scope);
  }

  let workerStarted = false;
  let handler: JobHandler | undefined;
  function jobHandler(): JobHandler {
    if (!options.completion) {
      throw new ConfigurationError('processing jobs needs a completion provider: pass `completion` to createMemnest');
    }
    if (handler) return handler;
    const extract = createExtractionHandler({
      store,
      completion: options.completion,
      resolver,
      redactor,
      tokenCounter,
      clock,
      ids,
      options: extractionOptions,
      embed: embedder ? (scope, texts) => embedFor(scope, texts) : undefined,
      embedder,
      onMemoriesChanged: memoriesChanged,
    });
    handler = async (job) => {
      if (job.type === 'profile') {
        await rebuild(scopeOf(job.containerTag));
        return;
      }
      return extract(job);
    };
    return handler;
  }

  async function add(input: AddInput): Promise<AddResult> {
    if (!input || (typeof input.content !== 'string' && !Array.isArray(input.content))) {
      throw new ValidationError('content must be a string or an array of conversation turns');
    }
    const scope = scopeOf(input.containerTag);
    const extraction = input.extraction ?? 'batched';
    if (!EXTRACTION_MODES.includes(extraction)) {
      throw new ValidationError(`extraction must be one of ${EXTRACTION_MODES.join(', ')}`);
    }
    if (input.customId !== undefined && (typeof input.customId !== 'string' || input.customId.length === 0 || input.customId.length > 256)) {
      throw new ValidationError('customId must be a string of 1-256 characters');
    }
    if (Array.isArray(input.content)) {
      for (const turn of input.content) {
        if (typeof turn?.role !== 'string' || typeof turn?.content !== 'string') {
          throw new ValidationError('each conversation turn needs string role and content');
        }
      }
    }
    assertIsoDate(input.documentDate, 'documentDate');

    // Redact before anything is hashed, chunked or persisted.
    const content = redactContent(input.content, redactor);
    const metadata = redactMetadata(input.metadata, redactor);
    const contentHash = await sha256Hex(canonicalContent(content));

    const prior = input.customId
      ? (await store.findDocuments(scope, { customId: input.customId, latestOnly: true }))[0]
      : (await store.findDocuments(scope, { contentHash, latestOnly: true })).find(
          (d) => !d.customId && !d.deletedAt,
        );

    if (prior && prior.contentHash === contentHash && !prior.deletedAt) {
      return { documentId: prior.id, status: prior.status, version: prior.version, deduplicated: true };
    }

    const normalized = normalizeContent(content);
    const now = clock.now();
    const document: Document = {
      id: ids.next('doc'),
      containerTag: scope.containerTag,
      ...(input.customId !== undefined ? { customId: input.customId } : {}),
      kind: normalized.kind,
      content: normalized.text,
      contentHash,
      metadata,
      ...(input.documentDate !== undefined ? { documentDate: input.documentDate } : {}),
      status: 'indexed',
      extraction,
      version: prior ? prior.version + 1 : 1,
      isLatest: true,
      ...(prior ? { previousVersionId: prior.id } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const chunks: Chunk[] = chunkContent(normalized, tokenCounter, chunking).map((draft, index) => ({
      id: ids.next('chk'),
      documentId: document.id,
      containerTag: scope.containerTag,
      index,
      content: draft.content,
      tokens: draft.tokens,
      createdAt: now,
    }));

    // Embed before the transaction: a model call must never hold the write lock.
    const vectors = await embedFor(scope, chunks.map((c) => c.content));
    await store.transaction(async (tx) => {
      if (prior) await tx.putDocument(scope, { ...prior, isLatest: false, updatedAt: now });
      await tx.putDocument(scope, document);
      await tx.putChunks(scope, chunks);
      if (vectors) await tx.putEmbeddings(scope, 'chunks', chunks.map((c, i) => ({ id: c.id, embedding: vectors[i]! })));
    });

    const result: AddResult = {
      documentId: document.id,
      status: document.status,
      version: document.version,
      deduplicated: false,
    };
    if (extraction !== 'none') {
      const job: ExtractionJob = {
        id: ids.next('job'),
        type: 'extract',
        containerTag: scope.containerTag,
        documentId: document.id,
        ...(input.customId !== undefined ? { customId: input.customId } : {}),
        mode: extraction,
        runAt:
          extraction === 'batched' ? new Date(Date.parse(now) + extractionOptions.batchWindowMs).toISOString() : now,
      };
      await queue.enqueue(job);
      result.jobId = job.id;
    }
    return result;
  }

  async function addMemories(input: DirectMemoryInput): Promise<Memory[]> {
    const scope = scopeOf(input?.containerTag);
    if (!Array.isArray(input.memories) || input.memories.length === 0) {
      throw new ValidationError('memories must be a non-empty array');
    }
    if (input.memories.length > MAX_DIRECT_MEMORIES) {
      throw new ValidationError(`at most ${MAX_DIRECT_MEMORIES} memories per direct write`);
    }
    for (const [i, m] of input.memories.entries()) {
      if (typeof m?.content !== 'string' || m.content.trim().length === 0) {
        throw new ValidationError(`memories[${i}].content must be a non-empty string`);
      }
      if (m.kind !== undefined && !MEMORY_KINDS.includes(m.kind)) {
        throw new ValidationError(`memories[${i}].kind must be one of ${MEMORY_KINDS.join(', ')}`);
      }
      if (m.confidence !== undefined && !(m.confidence >= 0 && m.confidence <= 1)) {
        throw new ValidationError(`memories[${i}].confidence must be within 0..1`);
      }
      assertIsoDate(m.validFrom, `memories[${i}].validFrom`);
      assertIsoDate(m.validUntil, `memories[${i}].validUntil`);
    }

    const now = clock.now();
    const contents = input.memories.map((m) => redactor.redact(m.content).trim());
    const documentText = contents.join('\n');
    const document: Document = {
      id: ids.next('doc'),
      containerTag: scope.containerTag,
      kind: 'direct',
      content: documentText,
      contentHash: await sha256Hex(documentText),
      metadata: redactMetadata(input.metadata, redactor),
      status: 'extracted',
      extraction: 'none',
      version: 1,
      isLatest: true,
      createdAt: now,
      updatedAt: now,
    };
    const run: ExtractionRun = {
      id: ids.next('run'),
      containerTag: scope.containerTag,
      method: 'direct',
      documentIds: [document.id],
      status: 'succeeded',
      startedAt: now,
      finishedAt: now,
    };

    const vectors = await embedFor(scope, contents);
    return store.transaction(async (tx) => {
      await tx.putDocument(scope, document);
      await tx.putExtractionRun(scope, run);
      const written: Memory[] = [];
      for (const [i, m] of input.memories.entries()) {
        let version = 1;
        if (m.supersedes !== undefined) {
          const old = await tx.getMemory(scope, m.supersedes);
          if (!old) throw new NotFoundError('memory', m.supersedes);
          if (!old.isLatest) throw new ValidationError(`memory ${old.id} is already superseded`);
          version = old.version + 1;
        }
        for (const extendedId of m.extendsIds ?? []) {
          if (!(await tx.getMemory(scope, extendedId))) throw new NotFoundError('memory', extendedId);
        }
        const memory: Memory = {
          id: ids.next('mem'),
          containerTag: scope.containerTag,
          content: contents[i]!,
          kind: m.kind ?? 'fact',
          confidence: m.confidence ?? 1,
          isLatest: true,
          version,
          ...(m.supersedes !== undefined ? { supersedes: m.supersedes } : {}),
          extendsIds: [...new Set(m.extendsIds ?? [])],
          sourceDocumentIds: [document.id],
          extractionRunId: run.id,
          validFrom: m.validFrom ?? now,
          ...(m.validUntil !== undefined ? { validUntil: m.validUntil } : {}),
          reinforcementCount: 1,
          createdAt: now,
        };
        await tx.putMemories(scope, [memory]);
        if (vectors) await tx.putEmbeddings(scope, 'memories', [{ id: memory.id, embedding: vectors[i]! }]);
        if (memory.supersedes) await tx.supersede(scope, memory.supersedes, memory.id);
        written.push(memory);
      }
      return written;
    }).then(async (written) => {
      await memoriesChanged(scope, written.length, written.flatMap((m) => (m.supersedes ? [m.supersedes] : [])));
      return written;
    });
  }

  return {
    add,
    addMemories,

    async getDocument(scope, id) {
      const s = requireScope(scope);
      const document = await store.getDocument(s, id);
      if (!document) return null;
      return { document, chunks: await store.getChunks(s, id) };
    },

    async deleteDocument(scope, id) {
      const s = requireScope(scope);
      if (!(await store.getDocument(s, id))) throw new NotFoundError('document', id);
      await store.deleteDocument(s, id, clock.now());
    },

    getMemory: (scope, id) => store.getMemory(requireScope(scope), id),

    async listMemories(scope, page = { limit: 100 }, filter) {
      if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 1000) {
        throw new ValidationError('page.limit must be an integer in 1..1000');
      }
      return store.listMemories(requireScope(scope), page, filter);
    },

    getLineage: (scope, memoryId) => store.getLineage(requireScope(scope), memoryId),

    async forget(scope, memoryId) {
      const s = requireScope(scope);
      const memory = await store.getMemory(s, memoryId);
      if (!memory) throw new NotFoundError('memory', memoryId);
      if (memory.forgottenAt) return memory;
      const at = clock.now();
      await store.forget(s, memoryId, at);
      await memoriesChanged(s, 1, [memoryId]);
      return { ...memory, forgottenAt: at };
    },

    async graph(scope, opts = {}) {
      if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 50_000)) {
        throw new ValidationError('limit must be an integer in 1..50000');
      }
      return store.graphSnapshot(requireScope(scope), opts);
    },

    async searchMemories(query, scope, opts = {}) {
      return (await recall(recallDeps, query, requireScope(scope), opts, { memories: true, chunks: false })).memories;
    },

    async searchDocuments(query, scope, opts = {}) {
      return (await recall(recallDeps, query, requireScope(scope), opts, { memories: false, chunks: true })).chunks;
    },

    search: (query, scope, opts = {}) =>
      recall(recallDeps, query, requireScope(scope), opts, { memories: true, chunks: true }),

    async profile(scope) {
      const s = requireScope(scope);
      const now = clock.now();
      let stored = await store.getProfile(s);
      const queuedRecently =
        stored?.rebuildQueuedAt !== undefined && Date.parse(stored.rebuildQueuedAt) + profileOptions.requeueAfterMs > Date.parse(now);
      if (isProfileDue(stored, profileOptions, now) && !queuedRecently && (await store.noteProfileChanges(s, 0, profilePolicy()))) {
        stored = (await scheduleRebuild(s)) ?? stored;
      }
      return renderProfile(s, stored, clock.now(), profileOptions, tokenCounter);
    },

    async rebuildProfile(scope) {
      const s = requireScope(scope);
      return renderProfile(s, await rebuild(s), clock.now(), profileOptions, tokenCounter);
    },

    async backfillEmbeddings(scope, opts = {}) {
      const s = requireScope(scope);
      if (!embedder) {
        throw new ConfigurationError('backfilling embeddings needs an embedding provider and a store with vector search');
      }
      const batchSize = opts.batchSize ?? 100;
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new ValidationError('batchSize must be an integer in 1..1000');
      const counts = { memories: 0, chunks: 0 };
      for (const target of ['memories', 'chunks'] as const) {
        const seen = new Set<string>();
        for (;;) {
          const rows = await store.listMissingEmbeddings(s, target, batchSize);
          if (rows.length === 0) break;
          if (rows.some((r) => seen.has(r.id))) {
            throw new ConfigurationError(`backfill made no progress on ${target}: the store keeps reporting embedded rows as missing`);
          }
          rows.forEach((r) => seen.add(r.id));
          const vectors = await embedFor(s, rows.map((r) => (target === 'chunks' ? contextualText(r.context, r.content) : r.content)));
          await store.putEmbeddings(s, target, rows.map((r, i) => ({ id: r.id, embedding: vectors![i]! })));
          counts[target] += rows.length;
        }
      }
      return counts;
    },

    deleteContainer: (scope) => store.deleteContainer(requireScope(scope)),

    async listExtractionRuns(scope, opts = {}) {
      const limit = opts.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ValidationError('limit must be an integer in 1..1000');
      return store.listExtractionRuns(requireScope(scope), { limit, ...(opts.documentId ? { documentId: opts.documentId } : {}) });
    },

    startWorker() {
      queue.process(jobHandler());
      workerStarted = true;
    },

    async processDueJobs() {
      if (!queue.runDue) throw new ConfigurationError('this job queue cannot process on demand (no runDue)');
      return queue.runDue(jobHandler());
    },

    async close() {
      if (workerStarted) await queue.stop?.();
      await store.close();
    },
  };
}
