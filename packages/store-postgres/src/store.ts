import pg from 'pg';
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
  type ApiKeyRecord,
  type AuthStore,
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
  type InspectableJobQueue,
  type Job,
  type JobQueueOptions,
  type JobStatus,
  type JobStorage,
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
import { migratePostgres, pgMigrationStatus, quoteSchema } from './migrations';

export interface PostgresStoreOptions {
  /** e.g. postgres://user:pass@host:5432/db. Ignored when `pool` is given. */
  connectionString?: string;
  /** Bring your own pool; the store will not end it on close. */
  pool?: pg.Pool;
  /** Default 'memnest' (D8). */
  schema?: string;
  /** Apply pending migrations on open. Default false: the host decides when migrations run. */
  autoMigrate?: boolean;
  clock?: Clock;
  /** Pool size when the store creates the pool. Default 10. */
  maxConnections?: number;
}

export type PostgresJobQueue = InspectableJobQueue;

export interface PostgresStore extends MemoryStore {
  readonly pool: pg.Pool;
  readonly schema: string;
  /** A queue on the jobs table. Claims use FOR UPDATE SKIP LOCKED, so many workers can share it. */
  jobQueue(options?: Omit<JobQueueOptions, 'clock'>): PostgresJobQueue;
  /** Server credentials on the `api_keys` and `sessions` tables of this store's schema. */
  authStore(): AuthStore;
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>;
}

/** HNSW indexes pgvector can build for the `vector` type. Larger embeddings fall back to exact search. */
const HNSW_MAX_DIMENSIONS = 2000;

const iso = (value: unknown): string => (value instanceof Date ? value : new Date(value as string)).toISOString();
const optionalIso = (value: unknown): string | undefined => (value === null || value === undefined ? undefined : iso(value));
const vectorLiteral = (v: Float32Array): string => `[${Array.from(v).join(',')}]`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

function toDocument(r: Row): Document {
  return {
    id: r.id,
    containerTag: r.container_tag,
    ...(r.custom_id !== null ? { customId: r.custom_id } : {}),
    kind: r.kind as DocumentKind,
    content: r.content,
    contentHash: r.content_hash,
    metadata: r.metadata ?? {},
    ...(r.document_date !== null ? { documentDate: r.document_date } : {}),
    status: r.status as DocumentStatus,
    extraction: r.extraction as ExtractionMode,
    version: r.version,
    isLatest: r.is_latest,
    ...(r.previous_version_id !== null ? { previousVersionId: r.previous_version_id } : {}),
    ...(r.deleted_at !== null ? { deletedAt: iso(r.deleted_at) } : {}),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function toDocumentRef(r: Row): DocumentRef {
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

function toChunk(r: Row): Chunk {
  return {
    id: r.id,
    documentId: r.document_id,
    containerTag: r.container_tag,
    index: r.idx,
    content: r.content,
    ...(r.context !== null ? { context: r.context } : {}),
    tokens: r.tokens,
    createdAt: iso(r.created_at),
  };
}

function toMemory(r: Row): Memory {
  const validUntil = optionalIso(r.valid_until);
  const forgottenAt = optionalIso(r.forgotten_at);
  return {
    id: r.id,
    containerTag: r.container_tag,
    content: r.content,
    kind: r.kind as MemoryKind,
    confidence: Number(r.confidence),
    isLatest: r.is_latest,
    version: r.version,
    ...(r.supersedes !== null ? { supersedes: r.supersedes } : {}),
    extendsIds: r.extends_ids ?? [],
    sourceDocumentIds: r.source_ids ?? [],
    extractionRunId: r.extraction_run_id,
    validFrom: iso(r.valid_from),
    ...(validUntil ? { validUntil } : {}),
    ...(forgottenAt ? { forgottenAt } : {}),
    reinforcementCount: r.reinforcement_count,
    createdAt: iso(r.created_at),
  };
}

function toContainer(r: Row): ContainerRecord {
  return {
    containerTag: r.container_tag,
    ...(r.embedding_provider_id !== null ? { embeddingProviderId: r.embedding_provider_id } : {}),
    ...(r.embedding_dimensions !== null ? { embeddingDimensions: r.embedding_dimensions } : {}),
    createdAt: iso(r.created_at),
  };
}

function toRun(r: Row): ExtractionRun {
  const finishedAt = optionalIso(r.finished_at);
  return {
    id: r.id,
    containerTag: r.container_tag,
    method: r.method,
    documentIds: r.document_ids ?? [],
    ...(r.model !== null ? { model: r.model } : {}),
    ...(r.prompt_version !== null ? { promptVersion: r.prompt_version } : {}),
    status: r.status,
    ...(r.error !== null ? { error: r.error } : {}),
    ...(r.stats !== null ? { stats: r.stats } : {}),
    startedAt: iso(r.started_at),
    ...(finishedAt ? { finishedAt } : {}),
  };
}

/** OR of the query's terms. Terms are letters and digits only, so they cannot inject tsquery syntax. */
function tsQuery(q: string): string | null {
  const terms = queryTerms(q);
  return terms.length === 0 ? null : terms.join(' | ');
}

export async function createPostgresStore(options: PostgresStoreOptions): Promise<PostgresStore> {
  if (!options.pool && !options.connectionString) throw new ConfigurationError('createPostgresStore needs a connectionString or a pool');
  const schema = options.schema ?? 'memnest';
  const S = quoteSchema(schema);
  const ownsPool = !options.pool;
  const pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString, max: options.maxConnections ?? 10 });
  const clock = options.clock ?? systemClock;

  let iterativeScan = false;
  try {
    const status = await pgMigrationStatus(pool, schema);
    if (status.pending.length > 0) {
      if (!options.autoMigrate) {
        throw new ConfigurationError(
          `Memnest schema "${schema}" is at version ${status.current} but ${status.latest} is required; run \`memnest migrate\` or pass autoMigrate: true`,
        );
      }
      await migratePostgres(pool, schema);
    }
    const version = await pool.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
    const [major = 0, minor = 0] = String(version.rows[0]?.extversion ?? '0.0').split('.').map(Number);
    // Iterative index scans (0.8+) keep filtered HNSW queries from returning too few rows.
    iterativeScan = major > 0 || minor >= 8;
  } catch (error) {
    if (ownsPool) await pool.end();
    throw error;
  }

  const MEMORY_COLUMNS = /* sql */ `
    m.id, m.container_tag, m.content, m.kind, m.confidence, m.is_latest, m.version, m.supersedes,
    m.extraction_run_id, m.valid_from, m.valid_until, m.forgotten_at, m.reinforcement_count, m.created_at,
    COALESCE((SELECT array_agg(s.document_id ORDER BY s.position) FROM ${S}.memory_sources s WHERE s.memory_id = m.id), '{}') AS source_ids,
    COALESCE((SELECT array_agg(e.to_id ORDER BY e.position) FROM ${S}.memory_edges e WHERE e.from_id = m.id AND e.relation = 'extends'), '{}') AS extends_ids`;
  const CHUNK_COLUMNS = 'c.id, c.document_id, c.container_tag, c.idx, c.content, c.context, c.tokens, c.created_at';

  async function inTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const indexedDimensions = new Set<number>();
  async function ensureVectorIndexes(dims: number): Promise<void> {
    if (indexedDimensions.has(dims) || dims > HNSW_MAX_DIMENSIONS) return;
    for (const table of ['memories', 'chunks']) {
      try {
        await pool.query(
          `CREATE INDEX IF NOT EXISTS ${table}_embedding_hnsw_${dims} ON ${S}.${table} ` +
            `USING hnsw ((embedding::vector(${dims})) vector_cosine_ops) WHERE embedding_dims = ${dims}`,
        );
      } catch (error) {
        // A concurrent process created it first.
        if (!['42P07', '23505'].includes((error as { code?: string }).code ?? '')) throw error;
      }
    }
    indexedDimensions.add(dims);
  }

  function makeOps(db: Queryable, atomically: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T>): MemoryStoreOps {
    const owner = async (table: string, id: string): Promise<string | undefined> =>
      (await db.query(`SELECT container_tag FROM ${S}.${table} WHERE id = $1`, [id])).rows[0]?.container_tag;

    const selectMemory = async (q: Queryable, scope: Scope, id: string) => {
      const { rows } = await q.query(`SELECT ${MEMORY_COLUMNS} FROM ${S}.memories m WHERE m.id = $1 AND m.container_tag = $2`, [
        id,
        scope.containerTag,
      ]);
      return rows[0] ? toMemory(rows[0]) : null;
    };
    const selectDocument = async (q: Queryable, scope: Scope, id: string) => {
      const { rows } = await q.query(`SELECT * FROM ${S}.documents WHERE id = $1 AND container_tag = $2`, [id, scope.containerTag]);
      return rows[0] ? toDocument(rows[0]) : null;
    };
    const containerDims = async (scope: Scope) =>
      (await db.query(`SELECT embedding_dimensions FROM ${S}.containers WHERE container_tag = $1`, [scope.containerTag])).rows[0]
        ?.embedding_dimensions as number | null | undefined;

    return {
      async putDocument(scope, doc) {
        assertInScope(scope, doc.containerTag, `document ${doc.id}`);
        const existing = await owner('documents', doc.id);
        if (existing !== undefined) assertInScope(scope, existing, `document ${doc.id}`);
        if (doc.previousVersionId !== undefined && !(await selectDocument(db, scope, doc.previousVersionId))) {
          throw new NotFoundError('document', doc.previousVersionId);
        }
        await db.query(
          /* sql */ `
          INSERT INTO ${S}.documents (id, container_tag, custom_id, kind, content, content_hash, metadata, document_date, status,
            extraction, version, is_latest, previous_version_id, deleted_at, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
          ON CONFLICT (id) DO UPDATE SET custom_id = EXCLUDED.custom_id, kind = EXCLUDED.kind, content = EXCLUDED.content,
            content_hash = EXCLUDED.content_hash, metadata = EXCLUDED.metadata, document_date = EXCLUDED.document_date,
            status = EXCLUDED.status, extraction = EXCLUDED.extraction, version = EXCLUDED.version, is_latest = EXCLUDED.is_latest,
            previous_version_id = EXCLUDED.previous_version_id, deleted_at = EXCLUDED.deleted_at, updated_at = EXCLUDED.updated_at`,
          [
            doc.id,
            doc.containerTag,
            doc.customId ?? null,
            doc.kind,
            doc.content,
            doc.contentHash,
            JSON.stringify(doc.metadata ?? {}),
            doc.documentDate ?? null,
            doc.status,
            doc.extraction,
            doc.version,
            doc.isLatest,
            doc.previousVersionId ?? null,
            doc.deletedAt ?? null,
            doc.createdAt,
            doc.updatedAt,
          ],
        );
      },

      async putChunks(scope, chunks) {
        for (const chunk of chunks) {
          assertInScope(scope, chunk.containerTag, `chunk ${chunk.id}`);
          if ((await owner('documents', chunk.documentId)) !== scope.containerTag) throw new NotFoundError('document', chunk.documentId);
          const existing = await owner('chunks', chunk.id);
          if (existing !== undefined) assertInScope(scope, existing, `chunk ${chunk.id}`);
        }
        if (chunks.length === 0) return;
        await db.query(
          /* sql */ `
          INSERT INTO ${S}.chunks (id, document_id, container_tag, idx, content, context, tokens, created_at)
          SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::text[], $7::int[], $8::timestamptz[])
          ON CONFLICT (id) DO UPDATE SET document_id = EXCLUDED.document_id, idx = EXCLUDED.idx, content = EXCLUDED.content,
            context = EXCLUDED.context, tokens = EXCLUDED.tokens`,
          [
            chunks.map((c) => c.id),
            chunks.map((c) => c.documentId),
            chunks.map((c) => c.containerTag),
            chunks.map((c) => c.index),
            chunks.map((c) => c.content),
            chunks.map((c) => c.context ?? null),
            chunks.map((c) => c.tokens),
            chunks.map((c) => c.createdAt),
          ],
        );
      },

      async putExtractionRun(scope, run) {
        assertInScope(scope, run.containerTag, `extraction run ${run.id}`);
        const existing = await owner('extraction_runs', run.id);
        if (existing !== undefined) assertInScope(scope, existing, `extraction run ${run.id}`);
        await db.query(
          /* sql */ `
          INSERT INTO ${S}.extraction_runs (id, container_tag, method, document_ids, model, prompt_version, status, error, stats, started_at, finished_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (id) DO UPDATE SET document_ids = EXCLUDED.document_ids, model = EXCLUDED.model,
            prompt_version = EXCLUDED.prompt_version, status = EXCLUDED.status, error = EXCLUDED.error,
            stats = EXCLUDED.stats, finished_at = EXCLUDED.finished_at`,
          [
            run.id,
            run.containerTag,
            run.method,
            run.documentIds,
            run.model ?? null,
            run.promptVersion ?? null,
            run.status,
            run.error ?? null,
            run.stats ? JSON.stringify(run.stats) : null,
            run.startedAt,
            run.finishedAt ?? null,
          ],
        );
      },

      async putMemories(scope, memories) {
        const pending = new Set(memories.map((m) => m.id));
        for (const memory of memories) {
          assertWritableMemory(scope, memory);
          for (const docId of memory.sourceDocumentIds) {
            if ((await owner('documents', docId)) !== scope.containerTag) throw new NotFoundError('document', docId);
          }
          if ((await owner('extraction_runs', memory.extractionRunId)) !== scope.containerTag) {
            throw new NotFoundError('extraction run', memory.extractionRunId);
          }
          const existing = await owner('memories', memory.id);
          if (existing !== undefined) assertInScope(scope, existing, `memory ${memory.id}`);
          for (const related of [...(memory.supersedes ? [memory.supersedes] : []), ...memory.extendsIds]) {
            if (!pending.has(related) && (await owner('memories', related)) !== scope.containerTag) throw new NotFoundError('memory', related);
          }
        }
        await atomically(async (q) => {
          for (const m of memories) {
            await q.query(
              /* sql */ `
              INSERT INTO ${S}.memories (id, container_tag, content, kind, confidence, is_latest, version, supersedes, extraction_run_id,
                valid_from, valid_until, forgotten_at, reinforcement_count, created_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
              ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, kind = EXCLUDED.kind, confidence = EXCLUDED.confidence,
                is_latest = EXCLUDED.is_latest, version = EXCLUDED.version, supersedes = EXCLUDED.supersedes,
                extraction_run_id = EXCLUDED.extraction_run_id, valid_from = EXCLUDED.valid_from, valid_until = EXCLUDED.valid_until,
                forgotten_at = EXCLUDED.forgotten_at, reinforcement_count = EXCLUDED.reinforcement_count,
                embedding = CASE WHEN ${S}.memories.content = EXCLUDED.content THEN ${S}.memories.embedding END,
                embedding_dims = CASE WHEN ${S}.memories.content = EXCLUDED.content THEN ${S}.memories.embedding_dims END`,
              [
                m.id,
                m.containerTag,
                m.content,
                m.kind,
                m.confidence,
                m.isLatest,
                m.version,
                m.supersedes ?? null,
                m.extractionRunId,
                m.validFrom,
                m.validUntil ?? null,
                m.forgottenAt ?? null,
                m.reinforcementCount,
                m.createdAt,
              ],
            );
            await q.query(`DELETE FROM ${S}.memory_sources WHERE memory_id = $1`, [m.id]);
            await q.query(`DELETE FROM ${S}.memory_edges WHERE from_id = $1 AND relation = 'extends'`, [m.id]);
            const sources = [...new Set(m.sourceDocumentIds)];
            await q.query(
              `INSERT INTO ${S}.memory_sources (memory_id, document_id, position) SELECT $1, d, p - 1 FROM unnest($2::text[]) WITH ORDINALITY AS u(d, p)`,
              [m.id, sources],
            );
            const extended = [...new Set(m.extendsIds)];
            if (extended.length > 0) {
              await q.query(
                `INSERT INTO ${S}.memory_edges (from_id, to_id, relation, position) SELECT $1, t, 'extends', p - 1 FROM unnest($2::text[]) WITH ORDINALITY AS u(t, p)`,
                [m.id, extended],
              );
            }
          }
        });
      },

      async supersede(scope, oldId, newId) {
        const old = await selectMemory(db, scope, oldId);
        if (!old) throw new NotFoundError('memory', oldId);
        const next = await selectMemory(db, scope, newId);
        if (!next) throw new NotFoundError('memory', newId);
        if (next.supersedes !== oldId) throw new ValidationError(`memory ${newId} does not supersede ${oldId}`);
        await db.query(`UPDATE ${S}.memories SET is_latest = false WHERE id = $1 AND container_tag = $2`, [oldId, scope.containerTag]);
      },

      async reinforce(scope, memoryId, sourceDocumentId) {
        if (!(await selectMemory(db, scope, memoryId))) throw new NotFoundError('memory', memoryId);
        if (!(await selectDocument(db, scope, sourceDocumentId))) throw new NotFoundError('document', sourceDocumentId);
        await atomically(async (q) => {
          await q.query(`UPDATE ${S}.memories SET reinforcement_count = reinforcement_count + 1 WHERE id = $1 AND container_tag = $2`, [
            memoryId,
            scope.containerTag,
          ]);
          await q.query(
            `INSERT INTO ${S}.memory_sources (memory_id, document_id, position)
             SELECT $1, $2, COALESCE(MAX(position) + 1, 0) FROM ${S}.memory_sources WHERE memory_id = $1
             ON CONFLICT DO NOTHING`,
            [memoryId, sourceDocumentId],
          );
        });
      },

      async forget(scope, memoryId, at) {
        const result = await db.query(
          `UPDATE ${S}.memories SET forgotten_at = COALESCE(forgotten_at, $1) WHERE id = $2 AND container_tag = $3`,
          [at, memoryId, scope.containerTag],
        );
        if (result.rowCount === 0) throw new NotFoundError('memory', memoryId);
      },

      getDocument: (scope, id) => selectDocument(db, scope, id),

      async findDocuments(scope, query) {
        const where = ['container_tag = $1'];
        const values: unknown[] = [scope.containerTag];
        if (query.customId !== undefined) where.push(`custom_id = $${values.push(query.customId)}`);
        if (query.contentHash !== undefined) where.push(`content_hash = $${values.push(query.contentHash)}`);
        if (query.latestOnly) where.push('is_latest');
        const { rows } = await db.query(`SELECT * FROM ${S}.documents WHERE ${where.join(' AND ')} ORDER BY version DESC, created_at DESC`, values);
        return rows.map(toDocument);
      },

      async getChunks(scope, documentId) {
        const { rows } = await db.query(
          `SELECT ${CHUNK_COLUMNS} FROM ${S}.chunks c WHERE c.document_id = $1 AND c.container_tag = $2 ORDER BY c.idx`,
          [documentId, scope.containerTag],
        );
        return rows.map(toChunk);
      },

      async deleteDocument(scope, id, at) {
        if (!(await selectDocument(db, scope, id))) throw new NotFoundError('document', id);
        await atomically(async (q) => {
          await q.query(`DELETE FROM ${S}.chunks WHERE document_id = $1 AND container_tag = $2`, [id, scope.containerTag]);
          await q.query(
            `UPDATE ${S}.documents SET content = '', deleted_at = COALESCE(deleted_at, $1), updated_at = $1 WHERE id = $2 AND container_tag = $3`,
            [at, id, scope.containerTag],
          );
        });
      },

      getMemory: (scope, id) => selectMemory(db, scope, id),

      async listExtractionRuns(scope, opts) {
        const { rows } = await db.query(
          `SELECT * FROM ${S}.extraction_runs WHERE container_tag = $1 AND ($2::text IS NULL OR $2 = ANY(document_ids))
           ORDER BY started_at DESC, id DESC LIMIT $3`,
          [scope.containerTag, opts.documentId ?? null, opts.limit],
        );
        return rows.map(toRun);
      },

      async getContainer(scope) {
        const { rows } = await db.query(`SELECT * FROM ${S}.containers WHERE container_tag = $1`, [scope.containerTag]);
        return rows[0] ? toContainer(rows[0]) : null;
      },

      async lockEmbeddingProvider(scope, provider, at) {
        if (!Number.isInteger(provider.dimensions) || provider.dimensions < 1 || provider.dimensions > 16000) {
          throw new ValidationError('embedding dimensions must be an integer in 1..16000');
        }
        const { rows } = await db.query(
          /* sql */ `
          INSERT INTO ${S}.containers (container_tag, embedding_provider_id, embedding_dimensions, created_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (container_tag) DO UPDATE SET
            embedding_provider_id = COALESCE(${S}.containers.embedding_provider_id, EXCLUDED.embedding_provider_id),
            embedding_dimensions = COALESCE(${S}.containers.embedding_dimensions, EXCLUDED.embedding_dimensions)
          RETURNING *`,
          [scope.containerTag, provider.id, provider.dimensions, at],
        );
        const record = toContainer(rows[0]!);
        if (record.embeddingProviderId !== provider.id || record.embeddingDimensions !== provider.dimensions) {
          throw new EmbeddingProviderMismatchError(
            scope.containerTag,
            { id: record.embeddingProviderId ?? '', dimensions: record.embeddingDimensions ?? 0 },
            provider,
          );
        }
        await ensureVectorIndexes(provider.dimensions);
        return record;
      },

      async listMissingEmbeddings(scope, target, limit) {
        const { rows } =
          target === 'memories'
            ? await db.query(`SELECT id, content FROM ${S}.memories WHERE container_tag = $1 AND embedding IS NULL ORDER BY id LIMIT $2`, [
                scope.containerTag,
                limit,
              ])
            : await db.query(
                `SELECT c.id, c.content, c.context FROM ${S}.chunks c JOIN ${S}.documents d ON d.id = c.document_id
                 WHERE c.container_tag = $1 AND d.container_tag = c.container_tag AND d.is_latest AND d.deleted_at IS NULL AND c.embedding IS NULL
                 ORDER BY c.id LIMIT $2`,
                [scope.containerTag, limit],
              );
        return rows.map((r: Row) => ({ id: r.id, content: r.content, ...(r.context ? { context: r.context } : {}) }));
      },

      async getProfile(scope) {
        const { rows } = await db.query(`SELECT * FROM ${S}.profiles WHERE container_tag = $1 AND profile IS NOT NULL`, [scope.containerTag]);
        const r = rows[0];
        if (!r) return null;
        const queued = optionalIso(r.rebuild_queued_at);
        return {
          ...(r.profile as Omit<StoredProfile, 'containerTag' | 'builtAt' | 'changesSinceBuild' | 'rebuildQueuedAt'>),
          containerTag: r.container_tag,
          builtAt: iso(r.built_at),
          changesSinceBuild: r.changes_since_build,
          ...(queued ? { rebuildQueuedAt: queued } : {}),
        };
      },

      async putProfile(scope, profile) {
        assertInScope(scope, profile.containerTag, 'profile');
        const ids = [...new Set([...profile.stable, ...profile.recent].flatMap((i) => i.memoryIds))];
        const found = (await db.query(`SELECT count(*)::int AS n FROM ${S}.memories WHERE container_tag = $1 AND id = ANY($2)`, [scope.containerTag, ids]))
          .rows[0].n;
        if (found !== ids.length) throw new NotFoundError('memory', 'cited by the profile');
        const { changesSinceBuild, rebuildQueuedAt, builtAt, containerTag: _tag, ...body } = profile;
        await db.query(
          `INSERT INTO ${S}.profiles (container_tag, profile, built_at, changes_since_build, rebuild_queued_at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (container_tag) DO UPDATE SET profile = EXCLUDED.profile, built_at = EXCLUDED.built_at,
             changes_since_build = EXCLUDED.changes_since_build, rebuild_queued_at = EXCLUDED.rebuild_queued_at`,
          [scope.containerTag, JSON.stringify(body), builtAt, changesSinceBuild, rebuildQueuedAt ?? null],
        );
      },

      async noteProfileChanges(scope, changes, policy) {
        return atomically(async (q) => {
          await q.query(`INSERT INTO ${S}.profiles (container_tag) VALUES ($1) ON CONFLICT DO NOTHING`, [scope.containerTag]);
          const r = (await q.query(`SELECT * FROM ${S}.profiles WHERE container_tag = $1 FOR UPDATE`, [scope.containerTag])).rows[0];
          const builtAt = optionalIso(r.built_at);
          const queuedAt = optionalIso(r.rebuild_queued_at);
          const { state, due } = nextProfileState(
            { changesSinceBuild: r.changes_since_build, ...(builtAt ? { builtAt } : {}), ...(queuedAt ? { rebuildQueuedAt: queuedAt } : {}) },
            changes,
            policy,
          );
          await q.query(`UPDATE ${S}.profiles SET changes_since_build = $1, rebuild_queued_at = $2 WHERE container_tag = $3`, [
            state.changesSinceBuild,
            state.rebuildQueuedAt ?? null,
            scope.containerTag,
          ]);
          return due;
        });
      },

      async putEmbeddings(scope, target, items) {
        if (items.length === 0) return;
        const dims = await containerDims(scope);
        if (!dims) throw new ConfigurationError(`container "${scope.containerTag}" has no embedding provider; lock one first`);
        for (const item of items) {
          if (item.embedding.length !== dims) {
            throw new ValidationError(`embedding for ${item.id} has ${item.embedding.length} dimensions, expected ${dims}`);
          }
        }
        const table = target === 'memories' ? 'memories' : 'chunks';
        await atomically(async (q) => {
          const result = await q.query(
            `UPDATE ${S}.${table} t SET embedding = u.embedding::vector, embedding_dims = $1
             FROM unnest($2::text[], $3::text[]) AS u(id, embedding)
             WHERE t.id = u.id AND t.container_tag = $4`,
            [dims, items.map((i) => i.id), items.map((i) => vectorLiteral(i.embedding)), scope.containerTag],
          );
          if (result.rowCount !== new Set(items.map((i) => i.id)).size) {
            const found = new Set(
              (await q.query(`SELECT id FROM ${S}.${table} WHERE id = ANY($1) AND container_tag = $2`, [items.map((i) => i.id), scope.containerTag]))
                .rows.map((r: Row) => r.id),
            );
            const missing = items.find((i) => !found.has(i.id))!;
            throw new NotFoundError(target === 'memories' ? 'memory' : 'chunk', missing.id);
          }
        });
      },

      async lexicalSearch<T extends SearchTarget>(q: string, scope: Scope, opts: { target: T; k: number }) {
        const query = tsQuery(q);
        if (!query) return [];
        const { rows } =
          opts.target === 'memories'
            ? await db.query(
                `SELECT ${MEMORY_COLUMNS}, ts_rank_cd(m.content_tsv, tq) AS score
                 FROM ${S}.memories m, to_tsquery('english', $1) tq
                 WHERE m.container_tag = $2 AND m.content_tsv @@ tq
                 ORDER BY score DESC, m.created_at, m.id LIMIT $3`,
                [query, scope.containerTag, opts.k],
              )
            : await db.query(
                `SELECT ${CHUNK_COLUMNS}, ts_rank_cd(c.content_tsv, tq) AS score
                 FROM ${S}.chunks c JOIN ${S}.documents d ON d.id = c.document_id, to_tsquery('english', $1) tq
                 WHERE c.container_tag = $2 AND d.container_tag = c.container_tag AND d.is_latest AND d.deleted_at IS NULL
                   AND c.content_tsv @@ tq
                 ORDER BY score DESC, c.created_at, c.idx LIMIT $3`,
                [query, scope.containerTag, opts.k],
              );
        const map = opts.target === 'memories' ? toMemory : toChunk;
        return rows.map((r, i) => ({ row: map(r), score: Number(r.score), rank: i + 1 })) as unknown as Scored<RowByTarget[T]>[];
      },

      async vectorSearch<T extends SearchTarget>(v: Float32Array, scope: Scope, opts: { target: T; k: number }) {
        const dims = await containerDims(scope);
        if (!dims) return [];
        if (v.length !== dims) throw new ValidationError(`query vector has ${v.length} dimensions, container uses ${dims}`);
        const k = Math.max(1, Math.min(1000, Math.trunc(opts.k)));
        const distance = (column: string) => `${column}::vector(${dims}) <=> $1::vector(${dims})`;
        const sql =
          opts.target === 'memories'
            ? `SELECT ${MEMORY_COLUMNS}, 1 - (${distance('m.embedding')}) AS score
               FROM ${S}.memories m
               WHERE m.container_tag = $2 AND m.embedding_dims = ${dims}
               ORDER BY ${distance('m.embedding')} LIMIT $3`
            : `SELECT ${CHUNK_COLUMNS}, 1 - (${distance('c.embedding')}) AS score
               FROM ${S}.chunks c JOIN ${S}.documents d ON d.id = c.document_id
               WHERE c.container_tag = $2 AND c.embedding_dims = ${dims} AND d.container_tag = c.container_tag
                 AND d.is_latest AND d.deleted_at IS NULL
               ORDER BY ${distance('c.embedding')} LIMIT $3`;
        const { rows } = await atomically(async (q) => {
          if (iterativeScan) {
            await q.query(`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true), set_config('hnsw.ef_search', $1, true)`, [
              String(Math.max(40, Math.min(1000, k * 2))),
            ]);
          }
          return q.query(sql, [vectorLiteral(v), scope.containerTag, k]);
        });
        const map = opts.target === 'memories' ? toMemory : toChunk;
        // Relaxed ordering may return near-sorted rows; restore exact order before assigning ranks.
        return rows
          .map((r) => ({ row: map(r), score: Number(r.score) }))
          .sort((a, z) => z.score - a.score || (a.row.id < z.row.id ? -1 : 1))
          .map((h, i) => ({ ...h, rank: i + 1 })) as unknown as Scored<RowByTarget[T]>[];
      },

      async getLineage(scope, memoryId) {
        return traverseLineage(memoryId, {
          getMemory: (id) => selectMemory(db, scope, id),
          getDependents: async (id) =>
            (
              await db.query(
                `SELECT ${MEMORY_COLUMNS} FROM ${S}.memories m
                 WHERE m.container_tag = $1 AND (m.supersedes = $2 OR m.id IN (SELECT from_id FROM ${S}.memory_edges WHERE to_id = $2 AND relation = 'extends'))
                 ORDER BY m.created_at, m.id`,
                [scope.containerTag, id],
              )
            ).rows.map(toMemory),
          getDocuments: async (ids) =>
            (
              await db.query(`SELECT * FROM ${S}.documents WHERE container_tag = $1 AND id = ANY($2) ORDER BY created_at, id`, [
                scope.containerTag,
                ids,
              ])
            ).rows.map(toDocumentRef),
        });
      },

      async listMemories(scope, page, filter = {}) {
        const where = ['m.container_tag = $1'];
        const values: unknown[] = [scope.containerTag];
        if (filter.kind !== undefined) where.push(`m.kind = $${values.push(filter.kind)}`);
        if (filter.latestOnly) where.push('m.is_latest');
        if (!filter.includeForgotten) where.push('m.forgotten_at IS NULL');
        if (page.after !== undefined) {
          const cursor = (
            await db.query(`SELECT created_at, id FROM ${S}.memories WHERE id = $1 AND container_tag = $2`, [page.after, scope.containerTag])
          ).rows[0];
          if (!cursor) return [];
          where.push(`(m.created_at, m.id) > ($${values.push(cursor.created_at)}::timestamptz, $${values.push(cursor.id)})`);
        }
        const { rows } = await db.query(
          `SELECT ${MEMORY_COLUMNS} FROM ${S}.memories m WHERE ${where.join(' AND ')} ORDER BY m.created_at, m.id LIMIT $${values.push(page.limit)}`,
          values,
        );
        return rows.map(toMemory);
      },

      async graphSnapshot(scope, opts) {
        const where = ['container_tag = $1'];
        if (!(opts.includeSuperseded ?? true)) where.push('is_latest');
        if (!(opts.includeForgotten ?? false)) where.push('forgotten_at IS NULL');
        const clause = where.join(' AND ');
        const limit = opts.limit ?? 2000;
        const [total, eligible, nodes, extendRows] = await Promise.all([
          db.query(`SELECT count(*)::int AS n FROM ${S}.memories WHERE container_tag = $1`, [scope.containerTag]),
          db.query(`SELECT count(*)::int AS n FROM ${S}.memories WHERE ${clause}`, [scope.containerTag]),
          db.query(
            `SELECT id, content, kind, confidence, is_latest, forgotten_at, reinforcement_count, valid_from, valid_until, created_at, supersedes
             FROM ${S}.memories WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT $2`,
            [scope.containerTag, limit],
          ),
          db.query(
            `SELECT e.from_id, e.to_id FROM ${S}.memory_edges e JOIN ${S}.memories m ON m.id = e.from_id
             WHERE m.container_tag = $1 AND e.relation = 'extends' ORDER BY e.from_id, e.position`,
            [scope.containerTag],
          ),
        ]);
        const ids = new Set(nodes.rows.map((r: Row) => r.id));
        const extendsByFrom = new Map<string, string[]>();
        for (const { from_id, to_id } of extendRows.rows) extendsByFrom.set(from_id, [...(extendsByFrom.get(from_id) ?? []), to_id]);
        const edges: GraphSnapshot['edges'] = [];
        for (const r of nodes.rows) {
          if (r.supersedes !== null && ids.has(r.supersedes)) edges.push({ from: r.id, to: r.supersedes, relation: 'updates' });
          for (const to of extendsByFrom.get(r.id) ?? []) if (ids.has(to)) edges.push({ from: r.id, to, relation: 'extends' });
        }
        return {
          containerTag: scope.containerTag,
          nodes: nodes.rows.map((r: Row) => {
            const validUntil = optionalIso(r.valid_until);
            return {
              id: r.id,
              content: r.content,
              kind: r.kind as MemoryKind,
              confidence: Number(r.confidence),
              isLatest: r.is_latest,
              forgotten: r.forgotten_at !== null,
              reinforcementCount: r.reinforcement_count,
              validFrom: iso(r.valid_from),
              ...(validUntil ? { validUntil } : {}),
              createdAt: iso(r.created_at),
            };
          }),
          edges,
          totalMemories: total.rows[0].n,
          truncated: eligible.rows[0].n > nodes.rows.length,
        };
      },

      async deleteContainer(scope) {
        const tag = scope.containerTag;
        await atomically(async (q) => {
          const inContainer = `SELECT id FROM ${S}.memories WHERE container_tag = $1`;
          await q.query(`DELETE FROM ${S}.memory_edges WHERE from_id IN (${inContainer}) OR to_id IN (${inContainer})`, [tag]);
          await q.query(`DELETE FROM ${S}.memory_sources WHERE memory_id IN (${inContainer})`, [tag]);
          for (const table of ['memories', 'chunks', 'documents', 'extraction_runs', 'jobs', 'containers', 'profiles']) {
            await q.query(`DELETE FROM ${S}.${table} WHERE container_tag = $1`, [tag]);
          }
        });
      },
    };
  }

  const poolOps = makeOps(pool, (fn) => inTransaction((client) => fn(client)));
  const capabilities: StoreCapabilities = { vector: true, fullText: true, transactions: true };

  const jobStorage: JobStorage = {
    async insert(job, { maxAttempts, now }) {
      await pool.query(
        `INSERT INTO ${S}.jobs (id, container_tag, type, payload, status, max_attempts, run_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $7)`,
        [job.id, job.containerTag, job.type, JSON.stringify(job), maxAttempts, job.runAt, now],
      );
    },
    async claim(now, lockedUntil) {
      const { rows } = await pool.query(
        /* sql */ `
        UPDATE ${S}.jobs SET status = 'running', attempts = attempts + 1, locked_until = $2, updated_at = $1
        WHERE id = (
          SELECT id FROM ${S}.jobs
          WHERE (status = 'pending' AND run_at <= $1) OR (status = 'running' AND locked_until < $1)
          ORDER BY run_at, created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING payload, attempts, max_attempts`,
        [now, lockedUntil],
      );
      const row = rows[0];
      return row ? { job: row.payload as Job, attempts: row.attempts, maxAttempts: row.max_attempts } : null;
    },
    async complete(id, now) {
      await pool.query(`UPDATE ${S}.jobs SET status = 'succeeded', locked_until = NULL, updated_at = $1 WHERE id = $2`, [now, id]);
    },
    async reschedule(id, runAt, { now, error, countAttempt }) {
      await pool.query(
        `UPDATE ${S}.jobs SET status = 'pending', run_at = $1, locked_until = NULL, updated_at = $2,
           attempts = attempts - $3, last_error = COALESCE($4, last_error) WHERE id = $5`,
        [runAt, now, countAttempt ? 0 : 1, error ?? null, id],
      );
    },
    async fail(id, error, now) {
      await pool.query(`UPDATE ${S}.jobs SET status = 'failed', last_error = $1, locked_until = NULL, updated_at = $2 WHERE id = $3`, [
        error,
        now,
        id,
      ]);
    },
  };

  let queue: PostgresJobQueue | undefined;
  let closed = false;

  const toApiKey = (r: Row): ApiKeyRecord => ({
    id: r.id,
    name: r.name,
    secretHash: r.secret_hash,
    ...(r.container_tag !== null ? { containerTag: r.container_tag } : {}),
    createdAt: iso(r.created_at),
    ...(r.last_used_at !== null ? { lastUsedAt: iso(r.last_used_at) } : {}),
    ...(r.revoked_at !== null ? { revokedAt: iso(r.revoked_at) } : {}),
  });

  const auth: AuthStore = {
    async putApiKey(key) {
      const result = await pool.query(
        `INSERT INTO ${S}.api_keys (id, name, secret_hash, container_tag, created_at, last_used_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [key.id, key.name, key.secretHash, key.containerTag ?? null, key.createdAt, key.lastUsedAt ?? null, key.revokedAt ?? null],
      );
      if (result.rowCount === 0) throw new ValidationError(`API key ${key.id} already exists`);
    },
    async getApiKey(id) {
      const { rows } = await pool.query(`SELECT * FROM ${S}.api_keys WHERE id = $1`, [id]);
      return rows[0] ? toApiKey(rows[0]) : null;
    },
    async listApiKeys() {
      const { rows } = await pool.query(`SELECT * FROM ${S}.api_keys ORDER BY created_at, id`);
      return rows.map(toApiKey);
    },
    revokeApiKey: (id, at) =>
      inTransaction(async (client) => {
        const result = await client.query(`UPDATE ${S}.api_keys SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`, [at, id]);
        if (result.rowCount === 0) return false;
        await client.query(`DELETE FROM ${S}.sessions WHERE key_id = $1`, [id]);
        return true;
      }),
    async touchApiKey(id, at) {
      await pool.query(`UPDATE ${S}.api_keys SET last_used_at = $1 WHERE id = $2`, [at, id]);
    },
    async putSession(session) {
      await pool.query(`INSERT INTO ${S}.sessions (id, key_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`, [
        session.id,
        session.keyId,
        session.createdAt,
        session.expiresAt,
      ]);
    },
    async getSession(id) {
      const { rows } = await pool.query(`SELECT id, key_id, created_at, expires_at FROM ${S}.sessions WHERE id = $1`, [id]);
      const row = rows[0];
      return row ? { id: row.id, keyId: row.key_id, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at) } : null;
    },
    async deleteSession(id) {
      await pool.query(`DELETE FROM ${S}.sessions WHERE id = $1`, [id]);
    },
    async deleteExpiredSessions(now) {
      return (await pool.query(`DELETE FROM ${S}.sessions WHERE expires_at <= $1`, [now])).rowCount ?? 0;
    },
  };

  return {
    ...poolOps,
    pool,
    schema,
    authStore: () => auth,
    capabilities: () => ({ ...capabilities }),
    transaction: (fn) =>
      inTransaction((client) =>
        fn(
          makeOps(client, (inner) => inner(client)),
        ),
      ),
    jobQueue: (queueOptions) =>
      (queue ??= {
        ...createJobQueue(jobStorage, { ...queueOptions, clock }),
        async list(scope, filter: { status?: JobStatus; limit?: number } = {}) {
          const { rows } = await pool.query(
            `SELECT payload, status, attempts, max_attempts, run_at, last_error, created_at, updated_at FROM ${S}.jobs
             WHERE container_tag = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at, id LIMIT $3`,
            [scope.containerTag, filter.status ?? null, filter.limit ?? 100],
          );
          return rows.map((r: Row) => ({
            job: r.payload as Job,
            status: r.status as JobStatus,
            attempts: r.attempts,
            maxAttempts: r.max_attempts,
            runAt: iso(r.run_at),
            ...(r.last_error !== null ? { lastError: r.last_error } : {}),
            createdAt: iso(r.created_at),
            updatedAt: iso(r.updated_at),
          }));
        },
        async retry(scope, jobId) {
          const now = clock.now();
          const result = await pool.query(
            `UPDATE ${S}.jobs SET status = 'pending', attempts = 0, run_at = $1, locked_until = NULL, updated_at = $1
             WHERE id = $2 AND container_tag = $3 AND status = 'failed'`,
            [now, jobId, scope.containerTag],
          );
          if (result.rowCount === 0) throw new NotFoundError('failed job', jobId);
        },
      }),
    async close() {
      if (closed) return;
      closed = true;
      if (ownsPool) await pool.end();
    },
  };
}
