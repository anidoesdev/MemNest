import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Append-only. Never edit a migration that has shipped; add a new one.
 * SQLite has no schemas, so every Memnest table is prefixed `memnest_` (the SQLite
 * equivalent of D8's `memnest.*` Postgres schema).
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'initial',
    sql: /* sql */ `
      CREATE TABLE memnest_documents (
        id                  TEXT PRIMARY KEY,
        container_tag       TEXT NOT NULL,
        custom_id           TEXT,
        kind                TEXT NOT NULL CHECK (kind IN ('conversation', 'markdown', 'text', 'direct')),
        content             TEXT NOT NULL,
        content_hash        TEXT NOT NULL,
        metadata            TEXT NOT NULL DEFAULT '{}',
        document_date       TEXT,
        status              TEXT NOT NULL CHECK (status IN ('indexed', 'extracting', 'extracted', 'failed')),
        extraction          TEXT NOT NULL CHECK (extraction IN ('instant', 'batched', 'none')),
        version             INTEGER NOT NULL,
        is_latest           INTEGER NOT NULL CHECK (is_latest IN (0, 1)),
        previous_version_id TEXT REFERENCES memnest_documents(id),
        deleted_at          TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE INDEX memnest_documents_container ON memnest_documents (container_tag, is_latest);
      CREATE INDEX memnest_documents_custom_id ON memnest_documents (container_tag, custom_id);
      CREATE INDEX memnest_documents_hash ON memnest_documents (container_tag, content_hash);

      CREATE TABLE memnest_chunks (
        seq           INTEGER PRIMARY KEY,
        id            TEXT NOT NULL UNIQUE,
        document_id   TEXT NOT NULL REFERENCES memnest_documents(id),
        container_tag TEXT NOT NULL,
        idx           INTEGER NOT NULL,
        content       TEXT NOT NULL,
        context       TEXT,
        tokens        INTEGER NOT NULL,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX memnest_chunks_document ON memnest_chunks (document_id, idx);
      CREATE INDEX memnest_chunks_container ON memnest_chunks (container_tag);

      CREATE VIRTUAL TABLE memnest_chunks_fts USING fts5(
        content, content = 'memnest_chunks', content_rowid = 'seq', tokenize = 'porter unicode61'
      );
      CREATE TRIGGER memnest_chunks_fts_insert AFTER INSERT ON memnest_chunks BEGIN
        INSERT INTO memnest_chunks_fts (rowid, content) VALUES (new.seq, new.content);
      END;
      CREATE TRIGGER memnest_chunks_fts_delete AFTER DELETE ON memnest_chunks BEGIN
        INSERT INTO memnest_chunks_fts (memnest_chunks_fts, rowid, content) VALUES ('delete', old.seq, old.content);
      END;
      CREATE TRIGGER memnest_chunks_fts_update AFTER UPDATE OF content ON memnest_chunks BEGIN
        INSERT INTO memnest_chunks_fts (memnest_chunks_fts, rowid, content) VALUES ('delete', old.seq, old.content);
        INSERT INTO memnest_chunks_fts (rowid, content) VALUES (new.seq, new.content);
      END;

      CREATE TABLE memnest_extraction_runs (
        id             TEXT PRIMARY KEY,
        container_tag  TEXT NOT NULL,
        method         TEXT NOT NULL CHECK (method IN ('llm', 'direct')),
        document_ids   TEXT NOT NULL DEFAULT '[]',
        model          TEXT,
        prompt_version TEXT,
        status         TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        error          TEXT,
        started_at     TEXT NOT NULL,
        finished_at    TEXT
      );
      CREATE INDEX memnest_extraction_runs_container ON memnest_extraction_runs (container_tag);

      CREATE TABLE memnest_memories (
        seq                 INTEGER PRIMARY KEY,
        id                  TEXT NOT NULL UNIQUE,
        container_tag       TEXT NOT NULL,
        content             TEXT NOT NULL,
        kind                TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'episode')),
        confidence          REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        is_latest           INTEGER NOT NULL CHECK (is_latest IN (0, 1)),
        version             INTEGER NOT NULL,
        supersedes          TEXT REFERENCES memnest_memories(id),
        extraction_run_id   TEXT NOT NULL REFERENCES memnest_extraction_runs(id),
        valid_from          TEXT NOT NULL,
        valid_until         TEXT,
        forgotten_at        TEXT,
        reinforcement_count INTEGER NOT NULL DEFAULT 1,
        created_at          TEXT NOT NULL
      );
      CREATE INDEX memnest_memories_container ON memnest_memories (container_tag, created_at, id);
      CREATE INDEX memnest_memories_supersedes ON memnest_memories (supersedes);

      CREATE VIRTUAL TABLE memnest_memories_fts USING fts5(
        content, content = 'memnest_memories', content_rowid = 'seq', tokenize = 'porter unicode61'
      );
      CREATE TRIGGER memnest_memories_fts_insert AFTER INSERT ON memnest_memories BEGIN
        INSERT INTO memnest_memories_fts (rowid, content) VALUES (new.seq, new.content);
      END;
      CREATE TRIGGER memnest_memories_fts_delete AFTER DELETE ON memnest_memories BEGIN
        INSERT INTO memnest_memories_fts (memnest_memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
      END;
      CREATE TRIGGER memnest_memories_fts_update AFTER UPDATE OF content ON memnest_memories BEGIN
        INSERT INTO memnest_memories_fts (memnest_memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
        INSERT INTO memnest_memories_fts (rowid, content) VALUES (new.seq, new.content);
      END;

      -- Provenance. Every memory has at least one row here (enforced by the store, asserted by tests).
      CREATE TABLE memnest_memory_sources (
        memory_id   TEXT NOT NULL REFERENCES memnest_memories(id),
        document_id TEXT NOT NULL REFERENCES memnest_documents(id),
        position    INTEGER NOT NULL,
        PRIMARY KEY (memory_id, document_id)
      );
      CREATE INDEX memnest_memory_sources_document ON memnest_memory_sources (document_id);

      -- EXTENDS relations. UPDATES lives on memnest_memories.supersedes.
      CREATE TABLE memnest_memory_edges (
        from_id  TEXT NOT NULL REFERENCES memnest_memories(id),
        to_id    TEXT NOT NULL REFERENCES memnest_memories(id),
        relation TEXT NOT NULL CHECK (relation IN ('extends')),
        position INTEGER NOT NULL,
        PRIMARY KEY (from_id, to_id, relation)
      );
      CREATE INDEX memnest_memory_edges_to ON memnest_memory_edges (to_id, relation);

      CREATE TABLE memnest_jobs (
        id            TEXT PRIMARY KEY,
        container_tag TEXT NOT NULL,
        type          TEXT NOT NULL,
        payload       TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
        attempts      INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 5,
        run_at        TEXT NOT NULL,
        last_error    TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX memnest_jobs_due ON memnest_jobs (status, run_at);
      CREATE INDEX memnest_jobs_container ON memnest_jobs (container_tag, status);
    `,
  },
  {
    id: 2,
    name: 'extraction_stats_and_job_leases',
    sql: /* sql */ `
      ALTER TABLE memnest_extraction_runs ADD COLUMN stats TEXT;
      ALTER TABLE memnest_jobs ADD COLUMN locked_until TEXT;
      CREATE INDEX memnest_extraction_runs_started ON memnest_extraction_runs (container_tag, started_at);
    `,
  },
  {
    id: 3,
    name: 'containers',
    sql: /* sql */ `
      CREATE TABLE memnest_containers (
        container_tag          TEXT PRIMARY KEY,
        embedding_provider_id  TEXT,
        embedding_dimensions   INTEGER,
        created_at             TEXT NOT NULL
      );
    `,
  },
  {
    id: 4,
    name: 'profiles',
    sql: /* sql */ `
      CREATE TABLE memnest_profiles (
        container_tag       TEXT PRIMARY KEY,
        profile             TEXT,
        built_at            TEXT,
        changes_since_build INTEGER NOT NULL DEFAULT 0,
        rebuild_queued_at   TEXT
      );
    `,
  },
];

const LEDGER = /* sql */ `
  CREATE TABLE IF NOT EXISTS memnest_migrations (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

export interface MigrationStatus {
  current: number;
  latest: number;
  pending: Migration[];
}

export function migrationStatus(db: Database): MigrationStatus {
  const ledgerExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memnest_migrations'`)
    .get();
  const applied = new Set<number>(
    ledgerExists
      ? (db.prepare('SELECT id FROM memnest_migrations').all() as Array<{ id: number }>).map((r) => r.id)
      : [],
  );
  const latest = MIGRATIONS.at(-1)?.id ?? 0;
  return {
    current: Math.max(0, ...applied),
    latest,
    pending: MIGRATIONS.filter((m) => !applied.has(m.id)),
  };
}

/** Applies pending migrations, each in its own transaction. Returns what was applied. */
export function migrate(db: Database, now: () => string = () => new Date().toISOString()): Migration[] {
  db.exec(LEDGER);
  const { pending } = migrationStatus(db);
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO memnest_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        now(),
      );
    })();
  }
  return pending;
}

/** Opens `filename` (creating it if needed), migrates it, and closes it. */
export function migrateFile(filename: string): { applied: Migration[]; status: MigrationStatus } {
  const db = new BetterSqlite3(filename);
  try {
    const applied = migrate(db);
    return { applied, status: migrationStatus(db) };
  } finally {
    db.close();
  }
}
