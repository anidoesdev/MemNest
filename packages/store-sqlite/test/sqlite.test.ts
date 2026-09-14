import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigurationError, NotFoundError, ProviderError, createMemnest, scopeOf } from '@memnest/core';
import { fixedClock, scriptedModel, sequentialIds } from '@memnest/core/testing';
import { defineAuthStoreContract, defineStoreContract } from '@memnest/store-contract';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, createSqliteStore, migrate, migrationStatus } from '../src/index';

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memnest-sqlite-'));
  dirs.push(dir);
  return join(dir, 'memnest.db');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every byte SQLite may have written: the database, its WAL and shared memory files. */
function persistedBytes(filename: string): string {
  return ['', '-wal', '-shm', '-journal']
    .map((suffix) => filename + suffix)
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path).toString('latin1'))
    .join('\n');
}

defineStoreContract('sqlite', async () => {
  const filename = tempDb();
  const store = createSqliteStore({ filename, autoMigrate: true });
  return {
    store,
    closeAndDump: async () => {
      store.db.pragma('wal_checkpoint(TRUNCATE)');
      await store.close();
      return persistedBytes(filename);
    },
    cleanup: () => store.close(),
  };
});

defineAuthStoreContract('sqlite', async () => {
  const store = createSqliteStore({ filename: tempDb(), autoMigrate: true });
  return { auth: store.authStore(), cleanup: () => store.close() };
});

describe('sqlite migrations', () => {
  it('refuses to open an unmigrated database unless told to migrate', () => {
    const filename = tempDb();
    expect(() => createSqliteStore({ filename })).toThrow(ConfigurationError);

    const db = new Database(filename);
    expect(migrationStatus(db)).toMatchObject({ current: 0, latest: MIGRATIONS.at(-1)!.id });
    expect(migrate(db).map((m) => m.id)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(migrate(db)).toEqual([]);
    expect(migrationStatus(db)).toMatchObject({ current: MIGRATIONS.at(-1)!.id, pending: [] });
    db.close();

    const store = createSqliteStore({ filename });
    expect(store.capabilities()).toEqual({ vector: false, fullText: true, transactions: true });
    return store.close();
  });
});

describe('sqlite persistence', () => {
  const user = scopeOf('user:123');

  it('survives a restart', async () => {
    const filename = tempDb();
    const first = createSqliteStore({ filename, autoMigrate: true });
    const memnest = createMemnest({ store: first, queue: first.jobQueue(), clock: fixedClock(), ids: sequentialIds() });
    const added = await memnest.add({
      containerTag: user.containerTag,
      content: [{ role: 'user', content: 'I run the payments service on Postgres.' }],
    });
    const [memory] = await memnest.addMemories({
      containerTag: user.containerTag,
      memories: [{ content: 'The user runs the payments service on Postgres.' }],
    });
    await memnest.close();

    // An hour later, a new process picks up the extraction job the first one left behind.
    const clock = fixedClock('2026-01-01T01:00:00.000Z');
    const reopened = createSqliteStore({ filename, clock });
    const completion = scriptedModel({
      extraction: [{ candidates: [{ content: 'The user runs the payments service on Postgres databases.', kind: 'fact', confidence: 0.9, validUntil: null }] }],
    });
    const again = createMemnest({ store: reopened, queue: reopened.jobQueue(), clock, completion });
    expect((await again.searchDocuments('payments', user))[0]?.chunk.documentId).toBe(added.documentId);
    expect((await again.searchMemories('payments Postgres', user)).map((m) => m.memory.id)).toEqual([memory!.id]);
    expect(await reopened.jobQueue().list(user)).toEqual([
      expect.objectContaining({ status: 'pending', attempts: 0, job: expect.objectContaining({ id: added.jobId, documentId: added.documentId, mode: 'batched' }) }),
    ]);
    expect(await reopened.jobQueue().list(scopeOf('user:other'))).toEqual([]);

    expect(await again.processDueJobs()).toMatchObject({ succeeded: 1 });
    expect(await reopened.jobQueue().list(user)).toEqual([expect.objectContaining({ status: 'succeeded', attempts: 1 })]);
    expect(await again.listMemories(user)).toHaveLength(2);
    await again.close();
  });

  it('keeps job state durable: backoff, permanent failure, lease takeover and manual retry', async () => {
    const filename = tempDb();
    const clock = fixedClock('2026-01-01T00:00:00.000Z');
    const store = createSqliteStore({ filename, autoMigrate: true, clock });
    const queue = store.jobQueue({ maxAttempts: 2, backoffBaseMs: 1000, leaseMs: 60_000 });
    const job = (id: string) => ({ id, type: 'extract' as const, containerTag: user.containerTag, documentId: 'doc_x', mode: 'instant' as const, runAt: clock.now() });

    await queue.enqueue(job('flaky'));
    const flaky = async () => {
      throw new ProviderError('p', 'HTTP 429', { status: 429, retryable: true });
    };
    expect(await queue.runDue(flaky)).toMatchObject({ retried: 1 });
    expect((await queue.list(user))[0]).toMatchObject({ status: 'pending', attempts: 1, runAt: '2026-01-01T00:00:01.000Z', lastError: 'p: HTTP 429' });
    clock.advance(1000);
    expect(await queue.runDue(flaky)).toMatchObject({ failed: 1 });
    expect((await queue.list(user, { status: 'failed' }))[0]).toMatchObject({ attempts: 2 });

    await queue.retry(user, 'flaky');
    await expect(queue.retry(scopeOf('user:other'), 'flaky')).rejects.toBeInstanceOf(NotFoundError);
    expect(await queue.runDue(async () => undefined)).toMatchObject({ succeeded: 1 });
    await expect(queue.retry(user, 'flaky')).rejects.toBeInstanceOf(NotFoundError);

    // A worker claims a job and dies. After the lease expires, another process takes it over.
    await queue.enqueue(job('orphan'));
    store.db.prepare("UPDATE memnest_jobs SET status = 'running', attempts = 1, locked_until = ? WHERE id = 'orphan'").run('2026-01-01T00:01:01.000Z');
    await store.close();

    const reopened = createSqliteStore({ filename, clock });
    const again = reopened.jobQueue();
    expect(await again.runDue(async () => undefined)).toMatchObject({ processed: 0 });
    clock.advance(61_000);
    expect(await again.runDue(async () => undefined)).toMatchObject({ succeeded: 1 });
    expect((await again.list(user)).find((r) => r.job.id === 'orphan')).toMatchObject({ status: 'succeeded', attempts: 2 });
    await reopened.close();
  });

  it('leaves no residue of deleted content on disk', async () => {
    const filename = tempDb();
    const store = createSqliteStore({ filename, autoMigrate: true });
    const memnest = createMemnest({ store, clock: fixedClock(), ids: sequentialIds() });
    const marker = 'quixotic-zeppelin-marmalade';
    const doc = await memnest.add({ containerTag: user.containerTag, content: `Remember ${marker}.`, extraction: 'none' });
    await memnest.add({ containerTag: 'user:gone', content: `Container ${marker} too.`, extraction: 'none' });
    await memnest.addMemories({ containerTag: 'user:gone', memories: [{ content: `Memory ${marker}.` }] });

    await memnest.deleteDocument(user, doc.documentId);
    await memnest.deleteContainer(scopeOf('user:gone'));
    store.db.pragma('wal_checkpoint(TRUNCATE)');
    await store.close();

    expect(persistedBytes(filename)).not.toContain(marker);
  });

  it('matches FTS query syntax characters literally', async () => {
    const store = createSqliteStore({ autoMigrate: true });
    const memnest = createMemnest({ store, clock: fixedClock() });
    await memnest.addMemories({ containerTag: user.containerTag, memories: [{ content: 'The user likes C++ and "NEAR" queries.' }] });
    for (const query of ['C++ AND OR NOT', '"near" (queries)', 'user* -likes', '"']) {
      await expect(memnest.search(query, user)).resolves.toBeDefined();
    }
    await store.close();
  });
});
