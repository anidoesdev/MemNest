import {
  ConfigurationError,
  EmbeddingProviderMismatchError,
  NotFoundError,
  TransactionsUnsupportedError,
  ValidationError,
} from '../errors';
import { traverseLineage } from '../lineage';
import { nextProfileState, type ProfileState } from '../profile/build';
import type { MemoryStore, MemoryStoreOps, StoreCapabilities } from '../ports';
import { assertInScope } from '../scope';
import { queryTerms, terms } from '../text';
import type {
  Chunk,
  ContainerRecord,
  Document,
  DocumentRef,
  ExtractionRun,
  GraphSnapshot,
  Memory,
  RowByTarget,
  Scope,
  Scored,
  SearchTarget,
  StoredProfile,
} from '../types';
import { assertWritableMemory } from '../validate';

export interface InMemoryStoreOptions {
  /** Simulate a store without transactions. Default true. */
  transactions?: boolean;
  /** Enable exact (brute-force cosine) vector search. Default false, like SQLite. */
  vector?: boolean;
}

export interface InMemoryStore extends MemoryStore {
  /** Every persisted byte, serialized. The secrets test greps this. */
  dump(): string;
}

interface State {
  documents: Map<string, Document>;
  chunks: Map<string, Chunk>;
  memories: Map<string, Memory>;
  runs: Map<string, ExtractionRun>;
  containers: Map<string, ContainerRecord>;
  /** Keyed by `chunks:<id>` or `memories:<id>`. */
  vectors: Map<string, number[]>;
  /** Change tracking always; the built profile once one exists. */
  profiles: Map<string, { state: ProfileState; profile: StoredProfile | null }>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Binary string order, matching SQL collation rather than locale rules. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function emptyState(): State {
  return { documents: new Map(), chunks: new Map(), memories: new Map(), runs: new Map(), containers: new Map(), vectors: new Map(), profiles: new Map() };
}

function snapshot(state: State): State {
  return {
    documents: new Map(clone([...state.documents])),
    chunks: new Map(clone([...state.chunks])),
    memories: new Map(clone([...state.memories])),
    runs: new Map(clone([...state.runs])),
    containers: new Map(clone([...state.containers])),
    vectors: new Map(clone([...state.vectors])),
    profiles: new Map(clone([...state.profiles])),
  };
}

export function stem(term: string): string {
  if (term.length > 4 && term.endsWith('ies')) return `${term.slice(0, -3)}y`;
  if (term.length > 5 && term.endsWith('ing')) return term.slice(0, -3);
  if (term.length > 4 && term.endsWith('ed')) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return term;
}

function cosine(a: Float32Array, b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Okapi BM25 over one container's rows only. */
function bm25<T>(query: string, rows: Array<{ row: T; text: string }>, k: number): Scored<T>[] {
  const q = queryTerms(query).map(stem);
  if (q.length === 0 || rows.length === 0) return [];
  const docs = rows.map(({ row, text }) => {
    const tf = new Map<string, number>();
    const ts = terms(text).map(stem);
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { row, tf, length: ts.length };
  });
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.tf.has(t)).length]));
  const k1 = 1.2;
  const b = 0.75;
  return docs
    .map((d) => {
      let score = 0;
      for (const t of q) {
        const f = d.tf.get(t) ?? 0;
        if (f === 0) continue;
        const n = df.get(t) ?? 0;
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgLength)));
      }
      return { row: d.row, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, z) => z.score - a.score)
    .slice(0, k)
    .map((s, i) => ({ row: s.row, score: s.score, rank: i + 1 }));
}

/**
 * Reference MemoryStore for tests. Lexical-only (BM25), transactional via
 * snapshot-and-restore. Enforces scope and provenance exactly as real stores must.
 */
export function createInMemoryStore(options: InMemoryStoreOptions = {}): InMemoryStore {
  let state = emptyState();
  const supportsTransactions = options.transactions ?? true;
  const supportsVectors = options.vector ?? false;
  const noVectors = () => new ConfigurationError('this in-memory store was created without vector support');
  let lock: Promise<unknown> = Promise.resolve();

  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  }

  const inScope = <T extends { containerTag: string }>(scope: Scope, row: T | undefined): T | null =>
    row && row.containerTag === scope.containerTag ? clone(row) : null;

  const requireMemory = (scope: Scope, id: string): Memory => {
    const m = state.memories.get(id);
    if (!m || m.containerTag !== scope.containerTag) throw new NotFoundError('memory', id);
    return m;
  };

  const toRef = (d: Document): DocumentRef => ({
    id: d.id,
    ...(d.customId !== undefined ? { customId: d.customId } : {}),
    kind: d.kind,
    version: d.version,
    isLatest: d.isLatest,
    ...(d.documentDate !== undefined ? { documentDate: d.documentDate } : {}),
    createdAt: d.createdAt,
    ...(d.deletedAt !== undefined ? { deletedAt: d.deletedAt } : {}),
  });

  const ops: MemoryStoreOps = {
    async putDocument(scope, doc) {
      assertInScope(scope, doc.containerTag, `document ${doc.id}`);
      const existing = state.documents.get(doc.id);
      if (existing) assertInScope(scope, existing.containerTag, `document ${doc.id}`);
      state.documents.set(doc.id, clone(doc));
    },

    async putChunks(scope, chunks) {
      for (const chunk of chunks) {
        assertInScope(scope, chunk.containerTag, `chunk ${chunk.id}`);
        const doc = state.documents.get(chunk.documentId);
        if (!doc || doc.containerTag !== scope.containerTag) throw new NotFoundError('document', chunk.documentId);
        const existing = state.chunks.get(chunk.id);
        if (existing) assertInScope(scope, existing.containerTag, `chunk ${chunk.id}`);
      }
      for (const chunk of chunks) state.chunks.set(chunk.id, clone(chunk));
    },

    async putExtractionRun(scope, run) {
      assertInScope(scope, run.containerTag, `extraction run ${run.id}`);
      const existing = state.runs.get(run.id);
      if (existing) assertInScope(scope, existing.containerTag, `extraction run ${run.id}`);
      state.runs.set(run.id, clone(run));
    },

    async putMemories(scope, memories) {
      for (const memory of memories) {
        assertWritableMemory(scope, memory);
        for (const docId of memory.sourceDocumentIds) {
          const doc = state.documents.get(docId);
          if (!doc || doc.containerTag !== scope.containerTag) throw new NotFoundError('document', docId);
        }
        const run = state.runs.get(memory.extractionRunId);
        if (!run || run.containerTag !== scope.containerTag) throw new NotFoundError('extraction run', memory.extractionRunId);
        const existing = state.memories.get(memory.id);
        if (existing) assertInScope(scope, existing.containerTag, `memory ${memory.id}`);
        const pending = new Set(memories.map((m) => m.id));
        for (const related of [...(memory.supersedes ? [memory.supersedes] : []), ...memory.extendsIds]) {
          if (pending.has(related)) continue;
          if (state.memories.get(related)?.containerTag !== scope.containerTag) throw new NotFoundError('memory', related);
        }
      }
      for (const memory of memories) state.memories.set(memory.id, clone(memory));
    },

    async supersede(scope, oldId, newId) {
      const old = requireMemory(scope, oldId);
      const next = requireMemory(scope, newId);
      if (next.supersedes !== oldId) throw new ValidationError(`memory ${newId} does not supersede ${oldId}`);
      old.isLatest = false;
    },

    async reinforce(scope, memoryId, sourceDocumentId) {
      const m = requireMemory(scope, memoryId);
      const doc = state.documents.get(sourceDocumentId);
      if (!doc || doc.containerTag !== scope.containerTag) throw new NotFoundError('document', sourceDocumentId);
      m.reinforcementCount += 1;
      if (!m.sourceDocumentIds.includes(sourceDocumentId)) m.sourceDocumentIds.push(sourceDocumentId);
    },

    async forget(scope, memoryId, at) {
      const m = requireMemory(scope, memoryId);
      m.forgottenAt ??= at;
    },

    async getDocument(scope, id) {
      return inScope(scope, state.documents.get(id));
    },

    async findDocuments(scope, query) {
      return [...state.documents.values()]
        .filter(
          (d) =>
            d.containerTag === scope.containerTag &&
            (query.customId === undefined || d.customId === query.customId) &&
            (query.contentHash === undefined || d.contentHash === query.contentHash) &&
            (!query.latestOnly || d.isLatest),
        )
        .sort((a, z) => z.version - a.version || cmp(z.createdAt, a.createdAt))
        .map(clone);
    },

    async getChunks(scope, documentId) {
      return [...state.chunks.values()]
        .filter((c) => c.containerTag === scope.containerTag && c.documentId === documentId)
        .sort((a, z) => a.index - z.index)
        .map(clone);
    },

    async deleteDocument(scope, id, at) {
      const doc = state.documents.get(id);
      if (!doc || doc.containerTag !== scope.containerTag) throw new NotFoundError('document', id);
      doc.content = '';
      doc.deletedAt ??= at;
      doc.updatedAt = at;
      for (const [chunkId, chunk] of state.chunks) {
        if (chunk.documentId === id) {
          state.chunks.delete(chunkId);
          state.vectors.delete(`chunks:${chunkId}`);
        }
      }
    },

    async getMemory(scope, id) {
      return inScope(scope, state.memories.get(id));
    },

    async listExtractionRuns(scope, opts) {
      return [...state.runs.values()]
        .filter(
          (r) =>
            r.containerTag === scope.containerTag &&
            (opts.documentId === undefined || r.documentIds.includes(opts.documentId)),
        )
        .sort((a, z) => cmp(z.startedAt, a.startedAt) || cmp(z.id, a.id))
        .slice(0, opts.limit)
        .map(clone);
    },

    async lexicalSearch<T extends SearchTarget>(q: string, scope: Scope, opts: { target: T; k: number }) {
      if (opts.target === 'memories') {
        const rows = [...state.memories.values()]
          .filter((m) => m.containerTag === scope.containerTag)
          .map((m) => ({ row: clone(m), text: m.content }));
        return bm25(q, rows, opts.k) as Scored<RowByTarget[T]>[];
      }
      const rows = [...state.chunks.values()]
        .filter((c) => {
          const doc = state.documents.get(c.documentId);
          return c.containerTag === scope.containerTag && doc?.isLatest && !doc.deletedAt;
        })
        .map((c) => ({ row: clone(c), text: c.content }));
      return bm25(q, rows, opts.k) as Scored<RowByTarget[T]>[];
    },

    async listMissingEmbeddings(scope, target, limit) {
      if (!supportsVectors) return [];
      const rows =
        target === 'memories'
          ? [...state.memories.values()].filter((m) => m.containerTag === scope.containerTag).map((m) => ({ id: m.id, content: m.content }))
          : [...state.chunks.values()]
              .filter((c) => {
                const doc = state.documents.get(c.documentId);
                return c.containerTag === scope.containerTag && doc?.isLatest && !doc.deletedAt;
              })
              .map((c) => ({ id: c.id, content: c.content, ...(c.context !== undefined ? { context: c.context } : {}) }));
      return rows
        .filter((r) => !state.vectors.has(`${target}:${r.id}`))
        .sort((a, z) => cmp(a.id, z.id))
        .slice(0, limit);
    },

    async getProfile(scope) {
      const entry = state.profiles.get(scope.containerTag);
      if (!entry?.profile) return null;
      return clone({ ...entry.profile, ...entry.state });
    },

    async putProfile(scope, profile) {
      assertInScope(scope, profile.containerTag, 'profile');
      for (const id of [...profile.stable, ...profile.recent].flatMap((i) => i.memoryIds)) {
        if (state.memories.get(id)?.containerTag !== scope.containerTag) throw new NotFoundError('memory', id);
      }
      const { changesSinceBuild, rebuildQueuedAt, ...rest } = clone(profile);
      state.profiles.set(scope.containerTag, {
        profile: { ...rest, changesSinceBuild, ...(rebuildQueuedAt ? { rebuildQueuedAt } : {}) },
        state: { changesSinceBuild, builtAt: profile.builtAt, ...(rebuildQueuedAt ? { rebuildQueuedAt } : {}) },
      });
    },

    async noteProfileChanges(scope, changes, policy) {
      const entry = state.profiles.get(scope.containerTag);
      const { state: next, due } = nextProfileState(entry?.state ?? null, changes, policy);
      state.profiles.set(scope.containerTag, { profile: entry?.profile ?? null, state: next });
      return due;
    },

    async getContainer(scope) {
      const record = state.containers.get(scope.containerTag);
      return record ? clone(record) : null;
    },

    async lockEmbeddingProvider(scope, provider, at) {
      const record = state.containers.get(scope.containerTag) ?? { containerTag: scope.containerTag, createdAt: at };
      if (record.embeddingProviderId === undefined) {
        record.embeddingProviderId = provider.id;
        record.embeddingDimensions = provider.dimensions;
        state.containers.set(scope.containerTag, record);
      } else if (record.embeddingProviderId !== provider.id || record.embeddingDimensions !== provider.dimensions) {
        throw new EmbeddingProviderMismatchError(
          scope.containerTag,
          { id: record.embeddingProviderId, dimensions: record.embeddingDimensions ?? 0 },
          provider,
        );
      }
      return clone(record);
    },

    async putEmbeddings(scope, target, items) {
      if (!supportsVectors) throw noVectors();
      const table: Map<string, { containerTag: string }> = target === 'memories' ? state.memories : state.chunks;
      for (const item of items) {
        const row = table.get(item.id);
        if (!row || row.containerTag !== scope.containerTag) throw new NotFoundError(target === 'memories' ? 'memory' : 'chunk', item.id);
      }
      const dims = state.containers.get(scope.containerTag)?.embeddingDimensions;
      if (dims === undefined) throw new ConfigurationError(`container "${scope.containerTag}" has no embedding provider; lock one first`);
      for (const item of items) {
        if (item.embedding.length !== dims) throw new ValidationError(`embedding for ${item.id} has ${item.embedding.length} dimensions, expected ${dims}`);
      }
      for (const item of items) state.vectors.set(`${target}:${item.id}`, Array.from(item.embedding));
    },

    async vectorSearch<T extends SearchTarget>(v: Float32Array, scope: Scope, opts: { target: T; k: number }) {
      if (!supportsVectors) throw noVectors();
      const dims = state.containers.get(scope.containerTag)?.embeddingDimensions;
      if (dims === undefined) return [];
      if (v.length !== dims) throw new ValidationError(`query vector has ${v.length} dimensions, container uses ${dims}`);
      const rows: Array<{ id: string; containerTag: string }> =
        opts.target === 'memories'
          ? [...state.memories.values()].filter((m) => m.containerTag === scope.containerTag)
          : [...state.chunks.values()].filter((c) => {
              const doc = state.documents.get(c.documentId);
              return c.containerTag === scope.containerTag && doc?.isLatest && !doc.deletedAt;
            });
      return rows
        .map((row) => ({ row, vector: state.vectors.get(`${opts.target}:${row.id}`) }))
        .filter((x): x is { row: typeof x.row; vector: number[] } => !!x.vector)
        .map(({ row, vector }) => ({ row, score: cosine(v, vector) }))
        .sort((a, z) => z.score - a.score || cmp(a.row.id, z.row.id))
        .slice(0, opts.k)
        .map((s, i) => ({ row: clone(s.row), score: s.score, rank: i + 1 })) as unknown as Scored<RowByTarget[T]>[];
    },

    async getLineage(scope, memoryId) {
      return traverseLineage(memoryId, {
        getMemory: async (id) => inScope(scope, state.memories.get(id)),
        getDependents: async (id) =>
          [...state.memories.values()]
            .filter((m) => m.containerTag === scope.containerTag && (m.supersedes === id || m.extendsIds.includes(id)))
            .map(clone),
        getDocuments: async (docIds) =>
          docIds
            .map((docId) => state.documents.get(docId))
            .filter((d): d is Document => !!d && d.containerTag === scope.containerTag)
            .map(toRef),
      });
    },

    async listMemories(scope, page, filter = {}) {
      const all = [...state.memories.values()]
        .filter(
          (m) =>
            m.containerTag === scope.containerTag &&
            (filter.kind === undefined || m.kind === filter.kind) &&
            (!filter.latestOnly || m.isLatest) &&
            (filter.includeForgotten || !m.forgottenAt),
        )
        .sort((a, z) => cmp(a.createdAt, z.createdAt) || cmp(a.id, z.id));
      let start = 0;
      if (page.after !== undefined) {
        const index = all.findIndex((m) => m.id === page.after);
        start = index === -1 ? all.length : index + 1;
      }
      return all.slice(start, start + page.limit).map(clone);
    },

    async graphSnapshot(scope, opts) {
      const includeSuperseded = opts.includeSuperseded ?? true;
      const includeForgotten = opts.includeForgotten ?? false;
      const limit = opts.limit ?? 2000;
      const all = [...state.memories.values()].filter((m) => m.containerTag === scope.containerTag);
      const eligible = all
        .filter((m) => (includeSuperseded || m.isLatest) && (includeForgotten || !m.forgottenAt))
        .sort((a, z) => cmp(z.createdAt, a.createdAt) || cmp(z.id, a.id));
      const nodes = eligible.slice(0, limit);
      const ids = new Set(nodes.map((m) => m.id));
      const edges: GraphSnapshot['edges'] = [];
      for (const m of nodes) {
        if (m.supersedes && ids.has(m.supersedes)) edges.push({ from: m.id, to: m.supersedes, relation: 'updates' });
        for (const e of m.extendsIds) if (ids.has(e)) edges.push({ from: m.id, to: e, relation: 'extends' });
      }
      return {
        containerTag: scope.containerTag,
        nodes: nodes.map((m) => ({
          id: m.id,
          content: m.content,
          kind: m.kind,
          confidence: m.confidence,
          isLatest: m.isLatest,
          forgotten: !!m.forgottenAt,
          reinforcementCount: m.reinforcementCount,
          validFrom: m.validFrom,
          ...(m.validUntil !== undefined ? { validUntil: m.validUntil } : {}),
          createdAt: m.createdAt,
        })),
        edges,
        totalMemories: all.length,
        truncated: eligible.length > nodes.length,
      };
    },

    async deleteContainer(scope) {
      for (const [target, table] of [['chunks', state.chunks], ['memories', state.memories]] as const) {
        for (const [id, row] of table) if (row.containerTag === scope.containerTag) state.vectors.delete(`${target}:${id}`);
      }
      state.containers.delete(scope.containerTag);
      state.profiles.delete(scope.containerTag);
      for (const table of [state.documents, state.chunks, state.memories, state.runs] as Map<string, { containerTag: string }>[]) {
        for (const [id, row] of table) if (row.containerTag === scope.containerTag) table.delete(id);
      }
    },
  };

  const locked = Object.fromEntries(
    Object.entries(ops).map(([name, fn]) => [
      name,
      (...args: unknown[]) => exclusive(() => (fn as (...a: unknown[]) => Promise<unknown>)(...args)),
    ]),
  ) as unknown as MemoryStoreOps;

  const capabilities: StoreCapabilities = { vector: supportsVectors, fullText: true, transactions: supportsTransactions };

  return {
    ...locked,
    capabilities: () => ({ ...capabilities }),
    transaction(fn) {
      if (!supportsTransactions) return Promise.reject(new TransactionsUnsupportedError());
      return exclusive(async () => {
        const before = snapshot(state);
        try {
          return await fn(ops);
        } catch (error) {
          state = before;
          throw error;
        }
      });
    },
    async close() {},
    dump: () =>
      JSON.stringify({
        documents: [...state.documents.values()],
        chunks: [...state.chunks.values()],
        memories: [...state.memories.values()],
        runs: [...state.runs.values()],
      }),
  };
}
