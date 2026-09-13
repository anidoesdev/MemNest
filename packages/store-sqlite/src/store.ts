import Database from 'better-sqlite3';
import type { Database as SqliteDatabase, Statement } from 'better-sqlite3';
import {
  ConfigurationError,
  EmbeddingProviderMismatchError,
  NotFoundError,
  ValidationError,
  assertInScope,
  assertWritableMemory,
  createJobQueue,
  nextProfileState,
  queryTerms,
  systemClock,
  traverseLineage,
  type Chunk,
  type Clock,
  type ContainerRecord,
  type Document,
  type DocumentKind,
  type DocumentRef,
  type DocumentStatus,
  type ExtractionMode,
  type ExtractionRun,
  type GraphSnapshot,
  type Job,
  type JobQueueOptions,
  type JobRecord,
  type JobStatus,
  type JobStorage,
  type InspectableJobQueue,
  type Memory,
  type MemoryKind,
  type MemoryStore,
  type MemoryStoreOps,
  type RowByTarget,
  type Scope,
  type Scored,
  type SearchTarget,
  type StoreCapabilities,
  type StoredProfile,
} from '@memnest/core';
import { migrate, migrationStatus } from './migrations';

export interface SqliteStoreOptions {
  /** Database file. Default ':memory:'. Ignored when `database` is given. */
  filename?: string;
  /** Bring your own better-sqlite3 connection. */
  database?: SqliteDatabase;
  /**
   * Apply pending migrations on open. Default false: an out-of-date schema is an
   * error, so host apps decide when migrations run (`memnest migrate`).
   */
  autoMigrate?: boolean;
  clock?: Clock;
}

export type SqliteJobQueue = InspectableJobQueue;

export interface SqliteStore extends MemoryStore {
  readonly db: SqliteDatabase;
  /**
   * A durable queue on the `memnest_jobs` table, sharing this store's connection and
   * write lock. Created on first call; later calls return the same queue and ignore options.
   */
  jobQueue(options?: Omit<JobQueueOptions, 'clock'>): SqliteJobQueue;
}

interface DocumentRow {
  id: string;
  container_tag: string;
  custom_id: string | null;
  kind: string;
  content: string;
  content_hash: string;
  metadata: string;
  document_date: string | null;
  status: string;
  extraction: string;
  version: number;
  is_latest: number;
  previous_version_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ChunkRow {
  id: string;
  document_id: string;
  container_tag: string;
  idx: number;
  content: string;
  context: string | null;
  tokens: number;
  created_at: string;
}

interface MemoryRow {
  id: string;
  container_tag: string;
  content: string;
  kind: string;
  confidence: number;
  is_latest: number;
  version: number;
  supersedes: string | null;
  extraction_run_id: string;
  valid_from: string;
  valid_until: string | null;
  forgotten_at: string | null;
  reinforcement_count: number;
  created_at: string;
  source_ids: string;
  extends_ids: string;
}

interface ContainerRow {
  container_tag: string;
  embedding_provider_id: string | null;
  embedding_dimensions: number | null;
  created_at: string;
}

function toContainer(r: ContainerRow): ContainerRecord {
  return {
    containerTag: r.container_tag,
    ...(r.embedding_provider_id !== null ? { embeddingProviderId: r.embedding_provider_id } : {}),
    ...(r.embedding_dimensions !== null ? { embeddingDimensions: r.embedding_dimensions } : {}),
    createdAt: r.created_at,
  };
}

interface ProfileRow {
  container_tag: string;
  profile: string | null;
  built_at: string | null;
  changes_since_build: number;
  rebuild_queued_at: string | null;
}

function toProfile(r: ProfileRow): StoredProfile {
  return {
    ...(JSON.parse(r.profile!) as Omit<StoredProfile, 'containerTag' | 'builtAt' | 'changesSinceBuild' | 'rebuildQueuedAt'>),
    containerTag: r.container_tag,
    builtAt: r.built_at!,
    changesSinceBuild: r.changes_since_build,
    ...(r.rebuild_queued_at !== null ? { rebuildQueuedAt: r.rebuild_queued_at } : {}),
  };
}

interface RunRow {
  id: string;
  container_tag: string;
  method: string;
  document_ids: string;
  model: string | null;
  prompt_version: string | null;
  status: string;
  error: string | null;
  stats: string | null;
  started_at: string;
  finished_at: string | null;
}

interface JobRow {
  payload: string;
  status: string;
  attempts: number;
  max_attempts: number;
  run_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const MEMORY_COLUMNS = /* sql */ `
  m.id, m.container_tag, m.content, m.kind, m.confidence, m.is_latest, m.version, m.supersedes,
  m.extraction_run_id, m.valid_from, m.valid_until, m.forgotten_at, m.reinforcement_count, m.created_at,
  (SELECT json_group_array(s.document_id ORDER BY s.position)
     FROM memnest_memory_sources s WHERE s.memory_id = m.id) AS source_ids,
  (SELECT json_group_array(e.to_id ORDER BY e.position)
     FROM memnest_memory_edges e WHERE e.from_id = m.id AND e.relation = 'extends') AS extends_ids`;

const CHUNK_COLUMNS = 'c.id, c.document_id, c.container_tag, c.idx, c.content, c.context, c.tokens, c.created_at';

function toDocument(r: DocumentRow): Document {
  return {
    id: r.id,
    containerTag: r.container_tag,
    ...(r.custom_id !== null ? { customId: r.custom_id } : {}),
    kind: r.kind as DocumentKind,
    content: r.content,
    contentHash: r.content_hash,
    metadata: JSON.parse(r.metadata),
    ...(r.document_date !== null ? { documentDate: r.document_date } : {}),
    status: r.status as DocumentStatus,
    extraction: r.extraction as ExtractionMode,
    version: r.version,
    isLatest: r.is_latest === 1,
    ...(r.previous_version_id !== null ? { previousVersionId: r.previous_version_id } : {}),
    ...(r.deleted_at !== null ? { deletedAt: r.deleted_at } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toDocumentRef(r: DocumentRow): DocumentRef {
  const d = toDocument(r);
  return {
    id: d.id,
    ...(d.customId !== undefined ? { customId: d.customId } : {}),
    kind: d.kind,
    version: d.version,
    isLatest: d.isLatest,
    ...(d.documentDate !== undefined ? { documentDate: d.documentDate } : {}),
    createdAt: d.createdAt,
    ...(d.deletedAt !== undefined ? { deletedAt: d.deletedAt } : {}),
  };
}

function toChunk(r: ChunkRow): Chunk {
  return {
    id: r.id,
    documentId: r.document_id,
    containerTag: r.container_tag,
    index: r.idx,
    content: r.content,
    ...(r.context !== null ? { context: r.context } : {}),
    tokens: r.tokens,
    createdAt: r.created_at,
  };
}

function toMemory(r: MemoryRow): Memory {
  return {
    id: r.id,
    containerTag: r.container_tag,
    content: r.content,
    kind: r.kind as MemoryKind,
    confidence: r.confidence,
    isLatest: r.is_latest === 1,
    version: r.version,
    ...(r.supersedes !== null ? { supersedes: r.supersedes } : {}),
    extendsIds: JSON.parse(r.extends_ids),
    sourceDocumentIds: JSON.parse(r.source_ids),
    extractionRunId: r.extraction_run_id,
    validFrom: r.valid_from,
    ...(r.valid_until !== null ? { validUntil: r.valid_until } : {}),
    ...(r.forgotten_at !== null ? { forgottenAt: r.forgotten_at } : {}),
    reinforcementCount: r.reinforcement_count,
    createdAt: r.created_at,
  };
}

/** FTS5 MATCH expression: quoted terms OR-ed together, so user input is never parsed as query syntax. */
function ftsQuery(q: string): string | null {
  const terms = queryTerms(q);
  return terms.length === 0 ? null : terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

export function createSqliteStore(options: SqliteStoreOptions = {}): SqliteStore {
  const ownsConnection = !options.database;
  const db = options.database ?? new Database(options.filename ?? ':memory:');
  const clock = options.clock ?? systemClock;

  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    // Overwrite deleted content on disk: tombstoned documents and deleted containers leave no residue.
    db.pragma('secure_delete = ON');
    if (!db.memory) db.pragma('journal_mode = WAL');

    const status = migrationStatus(db);
    if (status.pending.length > 0) {
      if (!options.autoMigrate) {
        throw new ConfigurationError(
          `Memnest schema is at version ${status.current} but ${status.latest} is required; run \`memnest migrate\` or pass autoMigrate: true`,
        );
      }
      migrate(db, clock.now);
    }
  } catch (error) {
    if (ownsConnection && db.open) db.close();
    throw error;
  }

  const statements = new Map<string, Statement>();
  const sql = (text: string): Statement => {
    let statement = statements.get(text);
    if (!statement) {
      statement = db.prepare(text);
      statements.set(text, statement);
    }
    return statement;
  };

  // One connection, one writer. Transactions span awaits, so every operation queues behind this lock.
  let lock: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  }

  const atomically = <T>(fn: () => T): T => db.transaction(fn)();

  const selectMemory = (scope: Scope, id: string): Memory | null => {
    const row = sql(`SELECT ${MEMORY_COLUMNS} FROM memnest_memories m WHERE m.id = ? AND m.container_tag = ?`).get(
      id,
      scope.containerTag,
    ) as MemoryRow | undefined;
    return row ? toMemory(row) : null;
  };

  const selectDocument = (scope: Scope, id: string): Document | null => {
    const row = sql('SELECT * FROM memnest_documents WHERE id = ? AND container_tag = ?').get(id, scope.containerTag) as
      | DocumentRow
      | undefined;
    return row ? toDocument(row) : null;
  };

  const existingContainer = (table: string, id: string): string | undefined =>
    (sql(`SELECT container_tag FROM ${table} WHERE id = ?`).get(id) as { container_tag: string } | undefined)
      ?.container_tag;

  const requireMemoriesInScope = (scope: Scope, ids: string[]) => {
    for (const id of ids) {
      if (existingContainer('memnest_memories', id) !== scope.containerTag) throw new NotFoundError('memory', id);
    }
  };

  const ops: MemoryStoreOps = {
    async putDocument(scope, doc) {
      assertInScope(scope, doc.containerTag, `document ${doc.id}`);
      const owner = existingContainer('memnest_documents', doc.id);
      if (owner !== undefined) assertInScope(scope, owner, `document ${doc.id}`);
      if (doc.previousVersionId !== undefined && !selectDocument(scope, doc.previousVersionId)) {
        throw new NotFoundError('document', doc.previousVersionId);
      }
      sql(/* sql */ `
        INSERT INTO memnest_documents (
          id, container_tag, custom_id, kind, content, content_hash, metadata, document_date, status,
          extraction, version, is_latest, previous_version_id, deleted_at, created_at, updated_at
        ) VALUES (
          @id, @containerTag, @customId, @kind, @content, @contentHash, @metadata, @documentDate, @status,
          @extraction, @version, @isLatest, @previousVersionId, @deletedAt, @createdAt, @updatedAt
        )
        ON CONFLICT (id) DO UPDATE SET
          custom_id = excluded.custom_id, kind = excluded.kind, content = excluded.content,
          content_hash = excluded.content_hash, metadata = excluded.metadata,
          document_date = excluded.document_date, status = excluded.status, extraction = excluded.extraction,
          version = excluded.version, is_latest = excluded.is_latest,
          previous_version_id = excluded.previous_version_id, deleted_at = excluded.deleted_at,
          updated_at = excluded.updated_at
      `).run({
        id: doc.id,
        containerTag: doc.containerTag,
        customId: doc.customId ?? null,
        kind: doc.kind,
        content: doc.content,
        contentHash: doc.contentHash,
        metadata: JSON.stringify(doc.metadata ?? {}),
        documentDate: doc.documentDate ?? null,
        status: doc.status,
        extraction: doc.extraction,
        version: doc.version,
        isLatest: doc.isLatest ? 1 : 0,
        previousVersionId: doc.previousVersionId ?? null,
        deletedAt: doc.deletedAt ?? null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      });
    },

    async putChunks(scope, chunks) {
      for (const chunk of chunks) {
        assertInScope(scope, chunk.containerTag, `chunk ${chunk.id}`);
        if (existingContainer('memnest_documents', chunk.documentId) !== scope.containerTag) {
          throw new NotFoundError('document', chunk.documentId);
        }
        const owner = existingContainer('memnest_chunks', chunk.id);
        if (owner !== undefined) assertInScope(scope, owner, `chunk ${chunk.id}`);
      }
      const upsert = sql(/* sql */ `
        INSERT INTO memnest_chunks (id, document_id, container_tag, idx, content, context, tokens, created_at)
        VALUES (@id, @documentId, @containerTag, @index, @content, @context, @tokens, @createdAt)
        ON CONFLICT (id) DO UPDATE SET
          document_id = excluded.document_id, idx = excluded.idx, content = excluded.content,
          context = excluded.context, tokens = excluded.tokens
      `);
      atomically(() => {
        for (const c of chunks) {
          upsert.run({
            id: c.id,
            documentId: c.documentId,
            containerTag: c.containerTag,
            index: c.index,
            content: c.content,
            context: c.context ?? null,
            tokens: c.tokens,
            createdAt: c.createdAt,
          });
        }
      });
    },

    async putExtractionRun(scope, run: ExtractionRun) {
      assertInScope(scope, run.containerTag, `extraction run ${run.id}`);
      const owner = existingContainer('memnest_extraction_runs', run.id);
      if (owner !== undefined) assertInScope(scope, owner, `extraction run ${run.id}`);
      sql(/* sql */ `
        INSERT INTO memnest_extraction_runs (
          id, container_tag, method, document_ids, model, prompt_version, status, error, stats, started_at, finished_at
        ) VALUES (
          @id, @containerTag, @method, @documentIds, @model, @promptVersion, @status, @error, @stats, @startedAt, @finishedAt
        )
        ON CONFLICT (id) DO UPDATE SET
          document_ids = excluded.document_ids, model = excluded.model, prompt_version = excluded.prompt_version,
          status = excluded.status, error = excluded.error, stats = excluded.stats, finished_at = excluded.finished_at
      `).run({
        id: run.id,
        containerTag: run.containerTag,
        method: run.method,
        documentIds: JSON.stringify(run.documentIds),
        model: run.model ?? null,
        promptVersion: run.promptVersion ?? null,
        status: run.status,
        error: run.error ?? null,
        stats: run.stats ? JSON.stringify(run.stats) : null,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? null,
      });
    },

    async putMemories(scope, memories) {
      for (const memory of memories) {
        assertWritableMemory(scope, memory);
        for (const docId of memory.sourceDocumentIds) {
          if (existingContainer('memnest_documents', docId) !== scope.containerTag) throw new NotFoundError('document', docId);
        }
        if (existingContainer('memnest_extraction_runs', memory.extractionRunId) !== scope.containerTag) {
          throw new NotFoundError('extraction run', memory.extractionRunId);
        }
        const owner = existingContainer('memnest_memories', memory.id);
        if (owner !== undefined) assertInScope(scope, owner, `memory ${memory.id}`);
        const pending = new Set(memories.map((m) => m.id));
        requireMemoriesInScope(
          scope,
          [...(memory.supersedes ? [memory.supersedes] : []), ...memory.extendsIds].filter((id) => !pending.has(id)),
        );
      }
      const upsert = sql(/* sql */ `
        INSERT INTO memnest_memories (
          id, container_tag, content, kind, confidence, is_latest, version, supersedes, extraction_run_id,
          valid_from, valid_until, forgotten_at, reinforcement_count, created_at
        ) VALUES (
          @id, @containerTag, @content, @kind, @confidence, @isLatest, @version, @supersedes, @extractionRunId,
          @validFrom, @validUntil, @forgottenAt, @reinforcementCount, @createdAt
        )
        ON CONFLICT (id) DO UPDATE SET
          content = excluded.content, kind = excluded.kind, confidence = excluded.confidence,
          is_latest = excluded.is_latest, version = excluded.version, supersedes = excluded.supersedes,
          extraction_run_id = excluded.extraction_run_id, valid_from = excluded.valid_from,
          valid_until = excluded.valid_until, forgotten_at = excluded.forgotten_at,
          reinforcement_count = excluded.reinforcement_count
      `);
      atomically(() => {
        for (const m of memories) {
          upsert.run({
            id: m.id,
            containerTag: m.containerTag,
            content: m.content,
            kind: m.kind,
            confidence: m.confidence,
            isLatest: m.isLatest ? 1 : 0,
            version: m.version,
            supersedes: m.supersedes ?? null,
            extractionRunId: m.extractionRunId,
            validFrom: m.validFrom,
            validUntil: m.validUntil ?? null,
            forgottenAt: m.forgottenAt ?? null,
            reinforcementCount: m.reinforcementCount,
            createdAt: m.createdAt,
          });
          sql('DELETE FROM memnest_memory_sources WHERE memory_id = ?').run(m.id);
          sql("DELETE FROM memnest_memory_edges WHERE from_id = ? AND relation = 'extends'").run(m.id);
          [...new Set(m.sourceDocumentIds)].forEach((docId, position) =>
            sql('INSERT INTO memnest_memory_sources (memory_id, document_id, position) VALUES (?, ?, ?)').run(
              m.id,
              docId,
              position,
            ),
          );
          [...new Set(m.extendsIds)].forEach((toId, position) =>
            sql("INSERT INTO memnest_memory_edges (from_id, to_id, relation, position) VALUES (?, ?, 'extends', ?)").run(
              m.id,
              toId,
              position,
            ),
          );
        }
      });
    },

    async supersede(scope, oldId, newId) {
      const old = selectMemory(scope, oldId);
      if (!old) throw new NotFoundError('memory', oldId);
      const next = selectMemory(scope, newId);
      if (!next) throw new NotFoundError('memory', newId);
      if (next.supersedes !== oldId) throw new ValidationError(`memory ${newId} does not supersede ${oldId}`);
      sql('UPDATE memnest_memories SET is_latest = 0 WHERE id = ? AND container_tag = ?').run(oldId, scope.containerTag);
    },

    async reinforce(scope, memoryId, sourceDocumentId) {
      if (!selectMemory(scope, memoryId)) throw new NotFoundError('memory', memoryId);
      if (!selectDocument(scope, sourceDocumentId)) throw new NotFoundError('document', sourceDocumentId);
      atomically(() => {
        sql('UPDATE memnest_memories SET reinforcement_count = reinforcement_count + 1 WHERE id = ? AND container_tag = ?').run(
          memoryId,
          scope.containerTag,
        );
        sql(/* sql */ `
          INSERT OR IGNORE INTO memnest_memory_sources (memory_id, document_id, position)
          SELECT ?, ?, COALESCE(MAX(position) + 1, 0) FROM memnest_memory_sources WHERE memory_id = ?
        `).run(memoryId, sourceDocumentId, memoryId);
      });
    },

    async forget(scope, memoryId, at) {
      const result = sql(
        'UPDATE memnest_memories SET forgotten_at = COALESCE(forgotten_at, ?) WHERE id = ? AND container_tag = ?',
      ).run(at, memoryId, scope.containerTag);
      if (result.changes === 0) throw new NotFoundError('memory', memoryId);
    },

    async getDocument(scope, id) {
      return selectDocument(scope, id);
    },

    async findDocuments(scope, query) {
      const where = ['container_tag = @containerTag'];
      if (query.customId !== undefined) where.push('custom_id = @customId');
      if (query.contentHash !== undefined) where.push('content_hash = @contentHash');
      if (query.latestOnly) where.push('is_latest = 1');
      const rows = sql(
        `SELECT * FROM memnest_documents WHERE ${where.join(' AND ')} ORDER BY version DESC, created_at DESC`,
      ).all({
        containerTag: scope.containerTag,
        ...(query.customId !== undefined ? { customId: query.customId } : {}),
        ...(query.contentHash !== undefined ? { contentHash: query.contentHash } : {}),
      }) as DocumentRow[];
      return rows.map(toDocument);
    },

    async getChunks(scope, documentId) {
      const rows = sql(
        `SELECT ${CHUNK_COLUMNS} FROM memnest_chunks c WHERE c.document_id = ? AND c.container_tag = ? ORDER BY c.idx`,
      ).all(documentId, scope.containerTag) as ChunkRow[];
      return rows.map(toChunk);
    },

    async deleteDocument(scope, id, at) {
      if (!selectDocument(scope, id)) throw new NotFoundError('document', id);
      atomically(() => {
        sql('DELETE FROM memnest_chunks WHERE document_id = ? AND container_tag = ?').run(id, scope.containerTag);
        sql(
          "UPDATE memnest_documents SET content = '', deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ? AND container_tag = ?",
        ).run(at, at, id, scope.containerTag);
      });
    },

    async getMemory(scope, id) {
      return selectMemory(scope, id);
    },

    async listExtractionRuns(scope, opts) {
      const rows = sql(/* sql */ `
        SELECT * FROM memnest_extraction_runs
        WHERE container_tag = @containerTag
          AND (@documentId IS NULL OR EXISTS (SELECT 1 FROM json_each(document_ids) WHERE value = @documentId))
        ORDER BY started_at DESC, id DESC
        LIMIT @limit
      `).all({ containerTag: scope.containerTag, documentId: opts.documentId ?? null, limit: opts.limit }) as RunRow[];
      return rows.map((r) => ({
        id: r.id,
        containerTag: r.container_tag,
        method: r.method as ExtractionRun['method'],
        documentIds: JSON.parse(r.document_ids),
        ...(r.model !== null ? { model: r.model } : {}),
        ...(r.prompt_version !== null ? { promptVersion: r.prompt_version } : {}),
        status: r.status as ExtractionRun['status'],
        ...(r.error !== null ? { error: r.error } : {}),
        ...(r.stats !== null ? { stats: JSON.parse(r.stats) } : {}),
        startedAt: r.started_at,
        ...(r.finished_at !== null ? { finishedAt: r.finished_at } : {}),
      }));
    },

    async lexicalSearch<T extends SearchTarget>(q: string, scope: Scope, opts: { target: T; k: number }) {
      const match = ftsQuery(q);
      if (!match) return [];
      if (opts.target === 'memories') {
        const rows = sql(/* sql */ `
          WITH hits AS (
            SELECT rowid AS seq, bm25(memnest_memories_fts) AS bm25 FROM memnest_memories_fts WHERE memnest_memories_fts MATCH ?
          )
          SELECT ${MEMORY_COLUMNS}, -h.bm25 AS score
          FROM hits h JOIN memnest_memories m ON m.seq = h.seq
          WHERE m.container_tag = ?
          ORDER BY h.bm25, m.seq
          LIMIT ?
        `).all(match, scope.containerTag, opts.k) as Array<MemoryRow & { score: number }>;
        return rows.map((r, i) => ({ row: toMemory(r), score: r.score, rank: i + 1 })) as Scored<RowByTarget[T]>[];
      }
      const rows = sql(/* sql */ `
        WITH hits AS (
          SELECT rowid AS seq, bm25(memnest_chunks_fts) AS bm25 FROM memnest_chunks_fts WHERE memnest_chunks_fts MATCH ?
        )
        SELECT ${CHUNK_COLUMNS}, -h.bm25 AS score
        FROM hits h
        JOIN memnest_chunks c ON c.seq = h.seq
        JOIN memnest_documents d ON d.id = c.document_id
        WHERE c.container_tag = ? AND d.container_tag = c.container_tag AND d.is_latest = 1 AND d.deleted_at IS NULL
        ORDER BY h.bm25, c.seq
        LIMIT ?
      `).all(match, scope.containerTag, opts.k) as Array<ChunkRow & { score: number }>;
      return rows.map((r, i) => ({ row: toChunk(r), score: r.score, rank: i + 1 })) as Scored<RowByTarget[T]>[];
    },

    async vectorSearch() {
      throw new ConfigurationError('the SQLite store is lexical-only (capabilities().vector is false); use @memnest/store-postgres for vector search');
    },

    async getContainer(scope) {
      const row = sql('SELECT * FROM memnest_containers WHERE container_tag = ?').get(scope.containerTag) as ContainerRow | undefined;
      return row ? toContainer(row) : null;
    },

    async lockEmbeddingProvider(scope, provider, at) {
      return atomically(() => {
        sql(/* sql */ `
          INSERT INTO memnest_containers (container_tag, embedding_provider_id, embedding_dimensions, created_at)
          VALUES (@tag, @id, @dims, @at)
          ON CONFLICT (container_tag) DO UPDATE SET
            embedding_provider_id = COALESCE(memnest_containers.embedding_provider_id, excluded.embedding_provider_id),
            embedding_dimensions = COALESCE(memnest_containers.embedding_dimensions, excluded.embedding_dimensions)
        `).run({ tag: scope.containerTag, id: provider.id, dims: provider.dimensions, at });
        const record = toContainer(sql('SELECT * FROM memnest_containers WHERE container_tag = ?').get(scope.containerTag) as ContainerRow);
        if (record.embeddingProviderId !== provider.id || record.embeddingDimensions !== provider.dimensions) {
          throw new EmbeddingProviderMismatchError(
            scope.containerTag,
            { id: record.embeddingProviderId ?? '', dimensions: record.embeddingDimensions ?? 0 },
            provider,
          );
        }
        return record;
      });
    },

    async listMissingEmbeddings() {
      return [];
    },

    async getProfile(scope) {
      const row = sql('SELECT * FROM memnest_profiles WHERE container_tag = ? AND profile IS NOT NULL').get(scope.containerTag) as ProfileRow | undefined;
      return row ? toProfile(row) : null;
    },

    async putProfile(scope, profile) {
      assertInScope(scope, profile.containerTag, 'profile');
      const ids = [...new Set([...profile.stable, ...profile.recent].flatMap((i) => i.memoryIds))];
      const found = (
        sql('SELECT COUNT(*) AS n FROM memnest_memories WHERE container_tag = ? AND id IN (SELECT value FROM json_each(?))').get(
          scope.containerTag,
          JSON.stringify(ids),
        ) as { n: number }
      ).n;
      if (found !== ids.length) throw new NotFoundError('memory', 'cited by the profile');
      const { changesSinceBuild, rebuildQueuedAt, builtAt, containerTag: _tag, ...body } = profile;
      sql(/* sql */ `
        INSERT INTO memnest_profiles (container_tag, profile, built_at, changes_since_build, rebuild_queued_at)
        VALUES (@tag, @profile, @builtAt, @changes, @queued)
        ON CONFLICT (container_tag) DO UPDATE SET profile = excluded.profile, built_at = excluded.built_at,
          changes_since_build = excluded.changes_since_build, rebuild_queued_at = excluded.rebuild_queued_at
      `).run({ tag: scope.containerTag, profile: JSON.stringify(body), builtAt, changes: changesSinceBuild, queued: rebuildQueuedAt ?? null });
    },

    async noteProfileChanges(scope, changes, policy) {
      return atomically(() => {
        const row = sql('SELECT * FROM memnest_profiles WHERE container_tag = ?').get(scope.containerTag) as ProfileRow | undefined;
        const current = row
          ? {
              changesSinceBuild: row.changes_since_build,
              ...(row.built_at !== null ? { builtAt: row.built_at } : {}),
              ...(row.rebuild_queued_at !== null ? { rebuildQueuedAt: row.rebuild_queued_at } : {}),
            }
          : null;
        const { state, due } = nextProfileState(current, changes, policy);
        sql(/* sql */ `
          INSERT INTO memnest_profiles (container_tag, changes_since_build, rebuild_queued_at) VALUES (@tag, @changes, @queued)
          ON CONFLICT (container_tag) DO UPDATE SET changes_since_build = excluded.changes_since_build, rebuild_queued_at = excluded.rebuild_queued_at
        `).run({ tag: scope.containerTag, changes: state.changesSinceBuild, queued: state.rebuildQueuedAt ?? null });
        return due;
      });
    },

    async putEmbeddings() {
      throw new ConfigurationError('the SQLite store is lexical-only (capabilities().vector is false); embeddings cannot be stored');
    },

    async getLineage(scope, memoryId) {
      return traverseLineage(memoryId, {
        getMemory: async (id) => selectMemory(scope, id),
        getDependents: async (id) =>
          (
            sql(/* sql */ `
              SELECT ${MEMORY_COLUMNS} FROM memnest_memories m
              WHERE m.container_tag = ?
                AND (m.supersedes = ? OR m.id IN (
                  SELECT from_id FROM memnest_memory_edges WHERE to_id = ? AND relation = 'extends'
                ))
              ORDER BY m.created_at, m.id
            `).all(scope.containerTag, id, id) as MemoryRow[]
          ).map(toMemory),
        getDocuments: async (ids) =>
          (
            sql(
              'SELECT * FROM memnest_documents WHERE container_tag = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY created_at, id',
            ).all(scope.containerTag, JSON.stringify(ids)) as DocumentRow[]
          ).map(toDocumentRef),
      });
    },

    async listMemories(scope, page, filter = {}) {
      const where = ['m.container_tag = @containerTag'];
      const params: Record<string, string | number> = { containerTag: scope.containerTag, limit: page.limit };
      if (filter.kind !== undefined) {
        where.push('m.kind = @kind');
        params.kind = filter.kind;
      }
      if (filter.latestOnly) where.push('m.is_latest = 1');
      if (!filter.includeForgotten) where.push('m.forgotten_at IS NULL');
      if (page.after !== undefined) {
        const cursor = sql('SELECT created_at, id FROM memnest_memories WHERE id = ? AND container_tag = ?').get(
          page.after,
          scope.containerTag,
        ) as { created_at: string; id: string } | undefined;
        if (!cursor) return [];
        where.push('(m.created_at, m.id) > (@afterCreatedAt, @afterId)');
        params.afterCreatedAt = cursor.created_at;
        params.afterId = cursor.id;
      }
      const rows = sql(
        `SELECT ${MEMORY_COLUMNS} FROM memnest_memories m WHERE ${where.join(' AND ')} ORDER BY m.created_at, m.id LIMIT @limit`,
      ).all(params) as MemoryRow[];
      return rows.map(toMemory);
    },

    async graphSnapshot(scope, opts) {
      const includeSuperseded = opts.includeSuperseded ?? true;
      const includeForgotten = opts.includeForgotten ?? false;
      const limit = opts.limit ?? 2000;
      const where = ['container_tag = ?'];
      if (!includeSuperseded) where.push('is_latest = 1');
      if (!includeForgotten) where.push('forgotten_at IS NULL');
      const clause = where.join(' AND ');

      const total = (sql('SELECT COUNT(*) AS n FROM memnest_memories WHERE container_tag = ?').get(scope.containerTag) as { n: number }).n;
      const eligible = (sql(`SELECT COUNT(*) AS n FROM memnest_memories WHERE ${clause}`).get(scope.containerTag) as { n: number }).n;
      const rows = sql(/* sql */ `
        SELECT id, content, kind, confidence, is_latest, forgotten_at, reinforcement_count, valid_from, valid_until,
               created_at, supersedes
        FROM memnest_memories WHERE ${clause}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(scope.containerTag, limit) as Array<Omit<MemoryRow, 'container_tag' | 'version' | 'extraction_run_id' | 'source_ids' | 'extends_ids'>>;

      const ids = new Set(rows.map((r) => r.id));
      const extendsByFrom = new Map<string, string[]>();
      const extendRows = sql(/* sql */ `
        SELECT e.from_id, e.to_id FROM memnest_memory_edges e
        JOIN memnest_memories m ON m.id = e.from_id
        WHERE m.container_tag = ? AND e.relation = 'extends'
        ORDER BY e.from_id, e.position
      `).all(scope.containerTag) as Array<{ from_id: string; to_id: string }>;
      for (const { from_id, to_id } of extendRows) {
        if (!extendsByFrom.has(from_id)) extendsByFrom.set(from_id, []);
        extendsByFrom.get(from_id)!.push(to_id);
      }

      const edges: GraphSnapshot['edges'] = [];
      for (const r of rows) {
        if (r.supersedes !== null && ids.has(r.supersedes)) edges.push({ from: r.id, to: r.supersedes, relation: 'updates' });
        for (const to of extendsByFrom.get(r.id) ?? []) if (ids.has(to)) edges.push({ from: r.id, to, relation: 'extends' });
      }

      return {
        containerTag: scope.containerTag,
        nodes: rows.map((r) => ({
          id: r.id,
          content: r.content,
          kind: r.kind as MemoryKind,
          confidence: r.confidence,
          isLatest: r.is_latest === 1,
          forgotten: r.forgotten_at !== null,
          reinforcementCount: r.reinforcement_count,
          validFrom: r.valid_from,
          ...(r.valid_until !== null ? { validUntil: r.valid_until } : {}),
          createdAt: r.created_at,
        })),
        edges,
        totalMemories: total,
        truncated: eligible > rows.length,
      };
    },

    async deleteContainer(scope) {
      const tag = scope.containerTag;
      atomically(() => {
        const inContainer = 'SELECT id FROM memnest_memories WHERE container_tag = ?';
        sql(`DELETE FROM memnest_memory_edges WHERE from_id IN (${inContainer}) OR to_id IN (${inContainer})`).run(tag, tag);
        sql(`DELETE FROM memnest_memory_sources WHERE memory_id IN (${inContainer})`).run(tag);
        sql('DELETE FROM memnest_memories WHERE container_tag = ?').run(tag);
        sql('DELETE FROM memnest_chunks WHERE container_tag = ?').run(tag);
        sql('DELETE FROM memnest_documents WHERE container_tag = ?').run(tag);
        sql('DELETE FROM memnest_extraction_runs WHERE container_tag = ?').run(tag);
        sql('DELETE FROM memnest_jobs WHERE container_tag = ?').run(tag);
        sql('DELETE FROM memnest_containers WHERE container_tag = ?').run(tag);
        sql('DELETE FROM memnest_profiles WHERE container_tag = ?').run(tag);
      });
    },
  };

  const locked = Object.fromEntries(
    Object.entries(ops).map(([name, fn]) => [
      name,
      (...args: unknown[]) => exclusive(() => (fn as (...a: unknown[]) => Promise<unknown>)(...args)),
    ]),
  ) as unknown as MemoryStoreOps;

  const capabilities: StoreCapabilities = { vector: false, fullText: true, transactions: true };

  const jobStorage: JobStorage = {
    insert: (job, { maxAttempts, now }) =>
      exclusive(() => {
        sql(/* sql */ `
          INSERT INTO memnest_jobs (id, container_tag, type, payload, status, max_attempts, run_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        `).run(job.id, job.containerTag, job.type, JSON.stringify(job), maxAttempts, job.runAt, now, now);
      }),
    claim: (now, lockedUntil) =>
      exclusive(() => {
        const row = sql(/* sql */ `
          UPDATE memnest_jobs
          SET status = 'running', attempts = attempts + 1, locked_until = @lockedUntil, updated_at = @now
          WHERE id = (
            SELECT id FROM memnest_jobs
            WHERE (status = 'pending' AND run_at <= @now) OR (status = 'running' AND locked_until < @now)
            ORDER BY run_at, created_at, id
            LIMIT 1
          )
          RETURNING payload, attempts, max_attempts
        `).get({ now, lockedUntil }) as { payload: string; attempts: number; max_attempts: number } | undefined;
        return row ? { job: JSON.parse(row.payload) as Job, attempts: row.attempts, maxAttempts: row.max_attempts } : null;
      }),
    complete: (id, now) =>
      exclusive(() => {
        sql("UPDATE memnest_jobs SET status = 'succeeded', locked_until = NULL, updated_at = ? WHERE id = ?").run(now, id);
      }),
    reschedule: (id, runAt, { now, error, countAttempt }) =>
      exclusive(() => {
        sql(/* sql */ `
          UPDATE memnest_jobs
          SET status = 'pending', run_at = @runAt, locked_until = NULL, updated_at = @now,
              attempts = attempts - @giveBack, last_error = COALESCE(@error, last_error)
          WHERE id = @id
        `).run({ id, runAt, now, error: error ?? null, giveBack: countAttempt ? 0 : 1 });
      }),
    fail: (id, error, now) =>
      exclusive(() => {
        sql("UPDATE memnest_jobs SET status = 'failed', last_error = ?, locked_until = NULL, updated_at = ? WHERE id = ?").run(
          error,
          now,
          id,
        );
      }),
  };

  let queue: SqliteJobQueue | undefined;
  const createQueue = (options: Omit<JobQueueOptions, 'clock'> = {}): SqliteJobQueue => ({
    ...createJobQueue(jobStorage, { ...options, clock }),
    list: (scope, filter = {}) =>
      exclusive(() => {
        const rows = sql(/* sql */ `
          SELECT payload, status, attempts, max_attempts, run_at, last_error, created_at, updated_at FROM memnest_jobs
          WHERE container_tag = @containerTag AND (@status IS NULL OR status = @status)
          ORDER BY created_at, id
          LIMIT @limit
        `).all({ containerTag: scope.containerTag, status: filter.status ?? null, limit: filter.limit ?? 100 }) as JobRow[];
        return rows.map((r) => ({
          job: JSON.parse(r.payload) as Job,
          status: r.status as JobStatus,
          attempts: r.attempts,
          maxAttempts: r.max_attempts,
          runAt: r.run_at,
          ...(r.last_error !== null ? { lastError: r.last_error } : {}),
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }));
      }),
    retry: (scope, jobId) =>
      exclusive(() => {
        const now = clock.now();
        const result = sql(/* sql */ `
          UPDATE memnest_jobs SET status = 'pending', attempts = 0, run_at = ?, locked_until = NULL, updated_at = ?
          WHERE id = ? AND container_tag = ? AND status = 'failed'
        `).run(now, now, jobId, scope.containerTag);
        if (result.changes === 0) throw new NotFoundError('failed job', jobId);
      }),
  });

  return {
    ...locked,
    db,
    capabilities: () => ({ ...capabilities }),
    transaction: (fn) =>
      exclusive(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(ops);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          if (db.inTransaction) db.exec('ROLLBACK');
          throw error;
        }
      }),
    jobQueue: (options) => (queue ??= createQueue(options)),
    close: () =>
      exclusive(() => {
        if (ownsConnection && db.open) db.close();
      }),
  };
}
