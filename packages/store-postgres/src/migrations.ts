import { ConfigurationError } from '@memnest/core';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

export interface PgMigration {
  id: number;
  name: string;
  /** Receives the quoted schema name. */
  sql: (schema: string) => string;
}

/** Append-only. Never edit a shipped migration; add a new one. Everything lives in its own schema (D8). */
export const PG_MIGRATIONS: readonly PgMigration[] = [
  {
    id: 1,
    name: 'initial',
    sql: (s) => /* sql */ `
      CREATE TABLE ${s}.containers (
        container_tag         text PRIMARY KEY,
        embedding_provider_id text,
        embedding_dimensions  integer,
        created_at            timestamptz NOT NULL
      );

      CREATE TABLE ${s}.documents (
        id                  text PRIMARY KEY,
        container_tag       text NOT NULL,
        custom_id           text,
        kind                text NOT NULL CHECK (kind IN ('conversation', 'markdown', 'text', 'direct')),
        content             text NOT NULL,
        content_hash        text NOT NULL,
        metadata            jsonb NOT NULL DEFAULT '{}',
        document_date       text,
        status              text NOT NULL CHECK (status IN ('indexed', 'extracting', 'extracted', 'failed')),
        extraction          text NOT NULL CHECK (extraction IN ('instant', 'batched', 'none')),
        version             integer NOT NULL,
        is_latest           boolean NOT NULL,
        previous_version_id text REFERENCES ${s}.documents (id),
        deleted_at          timestamptz,
        created_at          timestamptz NOT NULL,
        updated_at          timestamptz NOT NULL
      );
      CREATE INDEX documents_container ON ${s}.documents (container_tag, is_latest);
      CREATE INDEX documents_custom_id ON ${s}.documents (container_tag, custom_id);
      CREATE INDEX documents_hash ON ${s}.documents (container_tag, content_hash);

      CREATE TABLE ${s}.chunks (
        id             text PRIMARY KEY,
        document_id    text NOT NULL REFERENCES ${s}.documents (id),
        container_tag  text NOT NULL,
        idx            integer NOT NULL,
        content        text NOT NULL,
        context        text,
        tokens         integer NOT NULL,
        created_at     timestamptz NOT NULL,
        content_tsv    tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
        embedding      vector,
        embedding_dims integer
      );
      CREATE INDEX chunks_document ON ${s}.chunks (document_id, idx);
      CREATE INDEX chunks_container ON ${s}.chunks (container_tag);
      CREATE INDEX chunks_tsv ON ${s}.chunks USING gin (content_tsv);

      CREATE TABLE ${s}.extraction_runs (
        id             text PRIMARY KEY,
        container_tag  text NOT NULL,
        method         text NOT NULL CHECK (method IN ('llm', 'direct')),
        document_ids   text[] NOT NULL DEFAULT '{}',
        model          text,
        prompt_version text,
        status         text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        error          text,
        stats          jsonb,
        started_at     timestamptz NOT NULL,
        finished_at    timestamptz
      );
      CREATE INDEX extraction_runs_started ON ${s}.extraction_runs (container_tag, started_at);
      CREATE INDEX extraction_runs_documents ON ${s}.extraction_runs USING gin (document_ids);

      CREATE TABLE ${s}.memories (
        id                  text PRIMARY KEY,
        container_tag       text NOT NULL,
        content             text NOT NULL,
        kind                text NOT NULL CHECK (kind IN ('fact', 'preference', 'episode')),
        confidence          double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        is_latest           boolean NOT NULL,
        version             integer NOT NULL,
        supersedes          text REFERENCES ${s}.memories (id),
        extraction_run_id   text NOT NULL REFERENCES ${s}.extraction_runs (id),
        valid_from          timestamptz NOT NULL,
        valid_until         timestamptz,
        forgotten_at        timestamptz,
        reinforcement_count integer NOT NULL DEFAULT 1,
        created_at          timestamptz NOT NULL,
        content_tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
        embedding           vector,
        embedding_dims      integer
      );
      CREATE INDEX memories_container ON ${s}.memories (container_tag, created_at, id);
      CREATE INDEX memories_supersedes ON ${s}.memories (supersedes);
      CREATE INDEX memories_tsv ON ${s}.memories USING gin (content_tsv);

      -- Provenance: every memory has at least one row here.
      CREATE TABLE ${s}.memory_sources (
        memory_id   text NOT NULL REFERENCES ${s}.memories (id),
        document_id text NOT NULL REFERENCES ${s}.documents (id),
        position    integer NOT NULL,
        PRIMARY KEY (memory_id, document_id)
      );
      CREATE INDEX memory_sources_document ON ${s}.memory_sources (document_id);

      CREATE TABLE ${s}.memory_edges (
        from_id  text NOT NULL REFERENCES ${s}.memories (id),
        to_id    text NOT NULL REFERENCES ${s}.memories (id),
        relation text NOT NULL CHECK (relation IN ('extends')),
        position integer NOT NULL,
        PRIMARY KEY (from_id, to_id, relation)
      );
      CREATE INDEX memory_edges_to ON ${s}.memory_edges (to_id, relation);

      CREATE TABLE ${s}.jobs (
        id            text PRIMARY KEY,
        container_tag text NOT NULL,
        type          text NOT NULL,
        payload       jsonb NOT NULL,
        status        text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
        attempts      integer NOT NULL DEFAULT 0,
        max_attempts  integer NOT NULL DEFAULT 5,
        run_at        timestamptz NOT NULL,
        locked_until  timestamptz,
        last_error    text,
        created_at    timestamptz NOT NULL,
        updated_at    timestamptz NOT NULL
      );
      CREATE INDEX jobs_due ON ${s}.jobs (status, run_at);
      CREATE INDEX jobs_container ON ${s}.jobs (container_tag, status);
    `,
  },
  {
    id: 2,
    name: 'profiles',
    sql: (s) => /* sql */ `
      CREATE TABLE ${s}.profiles (
        container_tag       text PRIMARY KEY,
        profile             jsonb,
        built_at            timestamptz,
        changes_since_build integer NOT NULL DEFAULT 0,
        rebuild_queued_at   timestamptz
      );
    `,
  },
  {
    id: 3,
    name: 'api_keys_and_sessions',
    sql: (s) => /* sql */ `
      -- Server credentials. Only argon2id hashes of key secrets and SHA-256 hashes of session tokens are stored.
      CREATE TABLE ${s}.api_keys (
        id            text PRIMARY KEY,
        name          text NOT NULL,
        secret_hash   text NOT NULL,
        container_tag text,
        created_at    timestamptz NOT NULL,
        last_used_at  timestamptz,
        revoked_at    timestamptz
      );

      CREATE TABLE ${s}.sessions (
        id         text PRIMARY KEY,
        key_id     text NOT NULL REFERENCES ${s}.api_keys (id),
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL
      );
      CREATE INDEX sessions_key ON ${s}.sessions (key_id);
      CREATE INDEX sessions_expires ON ${s}.sessions (expires_at);
    `,
  },
];

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Validates and quotes a schema name. Schema names are interpolated into SQL, so this is a security boundary. */
export function quoteSchema(schema: string): string {
  if (!SCHEMA_NAME.test(schema)) {
    throw new ConfigurationError(`invalid schema name ${JSON.stringify(schema)}: use lowercase letters, digits and underscores`);
  }
  return `"${schema}"`;
}

export interface PgMigrationStatus {
  current: number;
  latest: number;
  pending: PgMigration[];
}

export async function pgMigrationStatus(pool: Pool | PoolClient, schema = 'memnest'): Promise<PgMigrationStatus> {
  const s = quoteSchema(schema);
  const exists = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`${s}.migrations`]);
  const applied = new Set<number>(
    exists.rows[0].exists ? (await pool.query(`SELECT id FROM ${s}.migrations`)).rows.map((r: { id: number }) => r.id) : [],
  );
  return {
    current: Math.max(0, ...applied),
    latest: PG_MIGRATIONS.at(-1)?.id ?? 0,
    pending: PG_MIGRATIONS.filter((m) => !applied.has(m.id)),
  };
}

/** Connects, migrates, disconnects. For CLIs and deploy scripts. */
export async function migrateDatabase(
  connectionString: string,
  schema = 'memnest',
): Promise<{ applied: PgMigration[]; status: PgMigrationStatus }> {
  const pool = new pg.Pool({ connectionString, max: 2 });
  try {
    const applied = await migratePostgres(pool, schema);
    return { applied, status: await pgMigrationStatus(pool, schema) };
  } finally {
    await pool.end();
  }
}

/**
 * Creates pgvector once per database. The extension is shared by every schema, so the per-schema migration
 * lock does not serialise it, and concurrent `CREATE EXTENSION IF NOT EXISTS` can fail with a unique
 * violation. A database-wide lock serialises creation; losing a race to another session still counts as created.
 */
async function ensureVectorExtension(client: PoolClient): Promise<void> {
  const installed = async () => ((await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`)).rowCount ?? 0) > 0;
  if (await installed()) return;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['memnest-migrate:pgvector']);
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (await installed()) return;
    throw new ConfigurationError(
      `the pgvector extension is not available (${(error as Error).message}). Install pgvector and run "CREATE EXTENSION vector;" as a superuser.`,
    );
  }
}

/**
 * Applies pending migrations in one transaction, under an advisory lock so concurrent
 * deploys cannot both migrate. Creates the pgvector extension if it is missing, which
 * needs a role allowed to do so; the error says what to run otherwise.
 */
export async function migratePostgres(pool: Pool, schema = 'memnest'): Promise<PgMigration[]> {
  const s = quoteSchema(schema);
  const client = await pool.connect();
  try {
    await ensureVectorExtension(client);
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`memnest-migrate:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${s}.migrations (id integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { pending } = await pgMigrationStatus(client, schema);
    for (const migration of pending) {
      await client.query(migration.sql(s));
      await client.query(`INSERT INTO ${s}.migrations (id, name) VALUES ($1, $2)`, [migration.id, migration.name]);
    }
    await client.query('COMMIT');
    return pending;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
