import { randomUUID } from 'node:crypto';
import { ConfigurationError, createMemnest, scopeOf, type Job } from '@memnest/core';
import { fixedClock, hashEmbedder, sequentialIds } from '@memnest/core/testing';
import { defineStoreContract } from '@memnest/store-contract';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PG_MIGRATIONS, createPostgresStore, migratePostgres, pgMigrationStatus, quoteSchema } from '../src/index';

const url = process.env.MEMNEST_TEST_DATABASE_URL;
if (!url && process.env.CI) throw new Error('MEMNEST_TEST_DATABASE_URL must be set in CI: the Postgres suite gates merges');
const suite = url ? describe : describe.skip;
if (!url) console.warn('Skipping @memnest/store-postgres tests: set MEMNEST_TEST_DATABASE_URL to a Postgres with pgvector.');

const admin = url ? new pg.Pool({ connectionString: url, max: 4 }) : undefined;
const schemas: string[] = [];
const freshSchema = () => {
  const schema = `memnest_t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  schemas.push(schema);
  return schema;
};

afterAll(async () => {
  if (!admin) return;
  for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${quoteSchema(schema)} CASCADE`);
  await admin.end();
});

/** Every row of every table in the schema, as text: the Postgres equivalent of grepping the database file. */
async function dumpSchema(schema: string): Promise<string> {
  const tables = await admin!.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1`, [schema]);
  const parts: string[] = [];
  for (const { table_name } of tables.rows) {
    const { rows } = await admin!.query(`SELECT row_to_json(t)::text AS row FROM ${quoteSchema(schema)}."${table_name}" t`);
    parts.push(...rows.map((r) => r.row as string));
  }
  return parts.join('\n');
}

if (url) {
  defineStoreContract('postgres', async () => {
    const schema = freshSchema();
    const store = await createPostgresStore({ connectionString: url, schema, autoMigrate: true, maxConnections: 4 });
    return {
      store,
      closeAndDump: async () => {
        await store.close();
        return dumpSchema(schema);
      },
      cleanup: async () => {
        await store.close();
        await admin!.query(`DROP SCHEMA IF EXISTS ${quoteSchema(schema)} CASCADE`);
      },
    };
  });
}

suite('postgres store', () => {
  const user = scopeOf('user:123');

  it('refuses an unmigrated schema, migrates idempotently under concurrency', async () => {
    const schema = freshSchema();
    await expect(createPostgresStore({ connectionString: url!, schema })).rejects.toBeInstanceOf(ConfigurationError);

    const results = await Promise.all([migratePostgres(admin!, schema), migratePostgres(admin!, schema), migratePostgres(admin!, schema)]);
    expect(results.map((r) => r.length).sort()).toEqual([0, 0, PG_MIGRATIONS.length]);
    expect(await pgMigrationStatus(admin!, schema)).toMatchObject({ current: PG_MIGRATIONS.at(-1)!.id, pending: [] });

    const store = await createPostgresStore({ connectionString: url!, schema });
    expect(store.capabilities()).toEqual({ vector: true, fullText: true, transactions: true });
    await store.close();
  });

  it('treats the schema name as a security boundary', async () => {
    expect(() => quoteSchema('memnest; DROP TABLE users')).toThrow(ConfigurationError);
    expect(() => quoteSchema('Memnest')).toThrow(ConfigurationError);
    await expect(createPostgresStore({ connectionString: url!, schema: 'x"y' })).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('builds an HNSW index per embedding dimension and uses it for container-filtered search', async () => {
    const schema = freshSchema();
    const store = await createPostgresStore({ connectionString: url!, schema, autoMigrate: true });
    const memnest = createMemnest({ store, embedder: hashEmbedder(), clock: fixedClock(), ids: sequentialIds() });
    await memnest.addMemories({ containerTag: user.containerTag, memories: [{ content: 'The user drinks green tea.' }] });

    const indexes = await admin!.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname LIKE '%hnsw%' ORDER BY indexname`, [schema]);
    expect(indexes.rows.map((r) => r.indexname)).toEqual(['chunks_embedding_hnsw_512', 'memories_embedding_hnsw_512']);

    const [query] = await hashEmbedder().embed(['green tea']);
    const client = await admin!.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query(
        `EXPLAIN SELECT id FROM ${quoteSchema(schema)}.memories m WHERE m.container_tag = $2 AND m.embedding_dims = 512
         ORDER BY m.embedding::vector(512) <=> $1::vector(512) LIMIT 5`,
        [`[${Array.from(query!).join(',')}]`, user.containerTag],
      );
      await client.query('ROLLBACK');
      expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('memories_embedding_hnsw_512');
    } finally {
      client.release();
    }
    await store.close();
  });

  it('lets many workers share one queue without running any job twice', async () => {
    const schema = freshSchema();
    const clock = fixedClock('2026-01-01T00:00:00.000Z');
    const stores = await Promise.all(
      Array.from({ length: 4 }, (_, i) => createPostgresStore({ connectionString: url!, schema, autoMigrate: i === 0 ? true : true, clock, maxConnections: 3 })),
    );
    const jobs: Job[] = Array.from({ length: 40 }, (_, i) => ({
      id: `job_${i}`,
      type: 'extract',
      containerTag: user.containerTag,
      documentId: `doc_${i}`,
      mode: 'instant',
      runAt: clock.now(),
    }));
    for (const job of jobs) await stores[0]!.jobQueue().enqueue(job);

    const ran: string[] = [];
    await Promise.all(
      stores.map((s) =>
        s.jobQueue().runDue(async (job) => {
          ran.push(job.id);
          await new Promise((resolve) => setTimeout(resolve, 2));
        }),
      ),
    );
    expect(ran).toHaveLength(40);
    expect(new Set(ran).size).toBe(40);
    const records = await stores[1]!.jobQueue().list(user, { limit: 100 });
    expect(records.every((r) => r.status === 'succeeded' && r.attempts === 1)).toBe(true);
    await Promise.all(stores.map((s) => s.close()));
  });

  it('keeps the relevant memory in the top 5 among 1,000 irrelevant ones, found by both retrievers', async () => {
    const schema = freshSchema();
    const store = await createPostgresStore({ connectionString: url!, schema, autoMigrate: true });
    const memnest = createMemnest({ store, embedder: hashEmbedder(), clock: fixedClock(), ids: sequentialIds() });
    const noise = Array.from({ length: 1000 }, (_, i) => ({
      content: `Note ${i}: the ${['red', 'blue', 'green', 'amber', 'violet'][i % 5]} ${['kettle', 'bicycle', 'lantern', 'notebook', 'umbrella', 'guitar'][i % 6]} is kept in the ${['garage', 'attic', 'hallway', 'basement', 'garden shed'][i % 5]}.`,
    }));
    await memnest.addMemories({ containerTag: user.containerTag, memories: noise.slice(0, 500) });
    const [relevant] = await memnest.addMemories({ containerTag: user.containerTag, memories: [{ content: 'Alex works at Stripe as a product manager.' }] });
    await memnest.addMemories({ containerTag: user.containerTag, memories: noise.slice(500) });
    // Noise in another container must not dilute or leak into the results.
    await memnest.addMemories({ containerTag: 'user:other', memories: [{ content: 'Alex works at Stripe on the payments team.' }] });

    const { memories, trace } = await memnest.search('Which company does Alex work at?', user, { tokenBudget: 200 });
    expect(trace.degraded).toBeUndefined();
    const position = trace.candidates.findIndex((c) => c.memoryId === relevant!.id);
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(5);
    expect(trace.candidates[position]).toMatchObject({ lexicalRank: 1, vectorRank: 1, included: true });
    expect(memories[0]!.memory.id).toBe(relevant!.id);
    expect(memories.every((m) => m.memory.containerTag === user.containerTag)).toBe(true);
    await store.close();
  }, 60_000);
});
