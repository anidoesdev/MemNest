import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInMemoryAuthStore,
  createInMemoryJobQueue,
  createMemnest,
  type AuthStore,
  type JobQueue,
  type Memnest,
  type MemoryStore,
} from '@memnest/core';
import { createInMemoryStore, fixedClock, hashEmbedder, scriptedModel, sequentialIds, type FixedClock, type ScriptedModelScript } from '@memnest/core/testing';
import { createPostgresStore, quoteSchema } from '@memnest/store-postgres';
import { createSqliteStore } from '@memnest/store-sqlite';
import { CSRF_HEADER, createServer, type MemnestServer, type ServerOptions } from '../src/index';

export type StoreKind = 'memory' | 'sqlite' | 'postgres';
const databaseUrl = process.env.MEMNEST_TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) throw new Error('MEMNEST_TEST_DATABASE_URL must be set in CI: the server leakage suite gates merges on every store');
/** Postgres joins when MEMNEST_TEST_DATABASE_URL points at a database with pgvector. */
export const STORE_KINDS: StoreKind[] = ['memory', 'sqlite', ...(databaseUrl ? (['postgres'] as const) : [])];

/** Cheap argon2id parameters so tests stay fast. `auth.test.ts` checks the production ones. */
export const FAST_ARGON2 = { algorithm: 2 as const, memoryCost: 1024, timeCost: 1, parallelism: 1 };

export interface Harness {
  kind: StoreKind;
  store: MemoryStore;
  auth: AuthStore;
  queue: JobQueue;
  memnest: Memnest;
  server: MemnestServer;
  clock: FixedClock;
  /** SQLite only: the database file. */
  filename?: string;
  request(method: string, path: string, init?: RequestInit & { key?: string; cookie?: string; json?: unknown }): Promise<Response>;
  cleanup(): Promise<void>;
}

export async function createHarness(
  kind: StoreKind,
  options: { script?: ScriptedModelScript; server?: Partial<ServerOptions> } = {},
): Promise<Harness> {
  const clock = fixedClock('2026-03-01T09:00:00.000Z');
  let dir: string | undefined;
  let filename: string | undefined;
  let store: MemoryStore;
  let auth: AuthStore;
  let queue: JobQueue;
  let dropSchema: (() => Promise<void>) | undefined;
  const server = { current: undefined as MemnestServer | undefined };
  const onEvent = (event: Parameters<MemnestServer['events']['publish']>[0]) => server.current?.events.publish(event);

  if (kind === 'sqlite') {
    dir = mkdtempSync(join(tmpdir(), 'memnest-server-'));
    filename = join(dir, 'memnest.db');
    const sqlite = createSqliteStore({ filename, autoMigrate: true, clock });
    store = sqlite;
    auth = sqlite.authStore();
    queue = sqlite.jobQueue({ onEvent });
  } else if (kind === 'postgres') {
    const schema = `memnest_t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const pg = await createPostgresStore({ connectionString: databaseUrl!, schema, autoMigrate: true, maxConnections: 4, clock });
    store = pg;
    auth = pg.authStore();
    queue = pg.jobQueue({ onEvent });
    dropSchema = async () => {
      const admin = await createPostgresStore({ connectionString: databaseUrl!, schema, maxConnections: 1 });
      await admin.pool.query(`DROP SCHEMA IF EXISTS ${quoteSchema(schema)} CASCADE`);
      await admin.close();
    };
  } else {
    store = createInMemoryStore({ vector: true });
    auth = createInMemoryAuthStore();
    queue = createInMemoryJobQueue({ clock, onEvent });
  }

  const memnest = createMemnest({
    store,
    queue,
    clock,
    ids: sequentialIds(),
    ...(store.capabilities().vector ? { embedder: hashEmbedder() } : {}),
    ...(options.script ? { completion: scriptedModel(options.script) } : {}),
    profile: { builder: 'deterministic' },
  });
  server.current = createServer({ memnest, auth, clock, heartbeatMs: 50, keyring: { argon2: FAST_ARGON2 }, ...options.server });

  return {
    kind,
    store,
    auth,
    queue,
    memnest,
    server: server.current,
    clock,
    ...(filename ? { filename } : {}),
    async request(method, path, init = {}) {
      const { key, cookie, json, headers, ...rest } = init;
      const h = new Headers(headers);
      if (key) h.set('authorization', `Bearer ${key}`);
      if (cookie) {
        h.set('cookie', cookie);
        if (!h.has(CSRF_HEADER)) h.set(CSRF_HEADER, '1');
      }
      if (json !== undefined) h.set('content-type', 'application/json');
      return server.current!.app.request(`http://memnest.test${path}`, {
        method,
        headers: h,
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
        ...rest,
      });
    },
    async cleanup() {
      await memnest.close();
      await dropSchema?.();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The `{ error: { code, message } }` body every failed request returns. */
export async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

/** Reads SSE events from a streaming response until `until` returns true or the timeout passes, then cancels the stream. */
export async function readEvents(
  response: Response,
  options: { until?: (events: Array<{ event: string; data: string }>) => boolean; timeoutMs?: number } = {},
): Promise<Array<{ event: string; data: string }>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: string }> = [];
  let buffer = '';
  const deadline = Date.now() + (options.timeoutMs ?? 500);
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(1, deadline - Date.now()))),
      ]);
      if (next === null || next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
        const data = [...block.matchAll(/^data: ?(.*)$/gm)].map((m) => m[1]).join('\n');
        events.push({ event, data });
      }
      if (options.until?.(events)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return events;
}
