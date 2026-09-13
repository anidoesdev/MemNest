import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LineageGraph, Memory, SearchResponse } from '@memnest/core';
import { createPostgresStore } from '@memnest/store-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type CliIO } from '../src/index';

let dir: string;
let db: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memnest-cli-'));
  db = join(dir, 'memnest.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function memnest(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (t) => out.push(t), err: (t) => err.push(t), env: {} };
  const code = await run([...argv, '--db', db], io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const json = async <T>(...argv: string[]): Promise<T> => {
  const result = await memnest(...argv, '--json');
  expect(result.err).toBe('');
  expect(result.code).toBe(0);
  return JSON.parse(result.out) as T;
};

describe('memnest cli', () => {
  it('requires migrations before use, and migrates idempotently', async () => {
    const before = await memnest('search', 'anything', '--container', 'user:123');
    expect(before.code).toBe(1);
    expect(before.err).toMatch(/memnest migrate/);

    expect(await json('migrate')).toMatchObject({
      applied: [
        { id: 1, name: 'initial' },
        { id: 2, name: 'extraction_stats_and_job_leases' },
        { id: 3, name: 'containers' },
        { id: 4, name: 'profiles' },
      ],
      version: 4,
    });
    expect(await json('migrate')).toMatchObject({ applied: [], version: 4 });
  });

  it('runs the database-switch story end to end', async () => {
    await memnest('migrate');
    const transcript = join(dir, 'session-1.json');
    writeFileSync(
      transcript,
      JSON.stringify([
        { role: 'user', content: 'I am building a payments service. I prefer Postgres over MongoDB as its database.' },
        { role: 'assistant', content: 'Postgres it is.' },
      ]),
    );
    const [ingested] = await json<Array<{ documentId: string; jobId: string; status: string }>>(
      'ingest', transcript, '--container', 'user:123', '--custom-id', 'session-1',
    );
    expect(ingested).toMatchObject({ status: 'indexed', jobId: expect.any(String) });

    const jobs = await json<Array<{ status: string }>>('jobs', '--container', 'user:123');
    expect(jobs).toEqual([expect.objectContaining({ status: 'pending' })]);

    const postgres = await json<Memory>(
      'memories', 'add', 'The user prefers Postgres over MongoDB for the payments service database.',
      '--container', 'user:123', '--kind', 'preference',
    );
    const mysql = await json<Memory>(
      'memories', 'add', 'The user moved the payments service database to MySQL.',
      '--container', 'user:123', '--supersedes', postgres.id,
    );

    const response = await json<SearchResponse>(
      'search', 'what database does this user use?', '--container', 'user:123', '--budget', '200',
    );
    expect(response.memories.map((m) => m.memory.id)).toEqual([mysql.id]);
    expect(response.chunks[0]?.chunk.documentId).toBe(ingested!.documentId);
    expect(response.trace.candidates).toContainEqual(
      expect.objectContaining({ memoryId: postgres.id, excludedReason: 'not-latest' }),
    );

    const human = await memnest('search', 'what database does this user use?', '--container', 'user:123', '--budget', '200');
    expect(human.out).toContain('✗ not-latest');
    expect(human.out).toContain('degraded=lexical-only');

    const lineage = await json<LineageGraph>('lineage', mysql.id, '--container', 'user:123');
    expect(lineage.edges).toContainEqual({ from: mysql.id, to: postgres.id, relation: 'updates' });

    await json('forget', mysql.id, '--container', 'user:123');
    const after = await json<SearchResponse>('search', 'database', '--container', 'user:123');
    expect(after.memories).toEqual([]);
    expect(after.trace.candidates).toContainEqual(expect.objectContaining({ memoryId: mysql.id, excludedReason: 'forgotten' }));

    const profile = await json<{ builder: string; text: string; stable: Array<{ memoryIds: string[] }> }>('profile', '--container', 'user:123');
    expect(profile.builder).toBe('deterministic');
    expect(profile.text).not.toContain('MySQL'); // forgotten
    expect(profile.text).not.toContain('Postgres over MongoDB'); // superseded
    const rebuilt = await memnest('profile', '--container', 'user:123', '--rebuild');
    expect(rebuilt.out).toMatch(/^Profile for user:123: deterministic build at .+, 0 memories/);

    // Other containers see nothing.
    const other = await json<SearchResponse>('search', 'database payments', '--container', 'user:999');
    expect([other.memories, other.chunks, other.trace.candidates]).toEqual([[], [], []]);
  });

  it('seeds structured synthetic memories', async () => {
    await memnest('migrate');
    expect(await json('seed', '--container', 'fixture:1k', '--count', '1000')).toEqual({ containerTag: 'fixture:1k', count: 1000 });
    const all = await json<Memory[]>('memories', 'list', '--container', 'fixture:1k', '--all', '--limit', '1000');
    expect(all).toHaveLength(1000);
    expect(all.filter((m) => m.supersedes)).toHaveLength(100);
    expect(all.filter((m) => m.extendsIds.length > 0)).toHaveLength(100);
    expect(all.filter((m) => m.forgottenAt)).toHaveLength(20);
    expect(all.filter((m) => !m.isLatest)).toHaveLength(100);
  });

  it('checks both Ollama and OpenAI-compatible providers', async () => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        const reply =
          req.url === '/api/chat'
            ? { model: body.model, message: { content: '{"ok":true}' }, done_reason: 'stop' }
            : req.url === '/api/embed'
              ? { embeddings: body.input.map(() => Array(768).fill(0.1)) }
              : req.url === '/v1/chat/completions'
                ? { model: body.model, choices: [{ finish_reason: 'stop', message: { content: '{"ok":false}' } }] }
                : { data: body.input.map((_: string, index: number) => ({ index, embedding: [1, 2, 3] })) };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const check = async (env: Record<string, string>) => {
      const out: string[] = [];
      const code = await run(['providers', 'check', '--json'], { out: (t) => out.push(t), err: () => undefined, env });
      return { code, report: JSON.parse(out.join('\n')) as { results: Array<{ kind: string; id: string; ok: boolean; detail: string }> } };
    };

    try {
      const ollama = await check({ MEMNEST_PROVIDER: 'ollama', MEMNEST_BASE_URL: base, MEMNEST_COMPLETION_MODEL: 'llama3.1:8b' });
      expect(ollama.code).toBe(0);
      expect(ollama.report.results).toEqual([
        expect.objectContaining({ kind: 'completion', id: 'ollama:llama3.1:8b', ok: true }),
        expect.objectContaining({ kind: 'embeddings', id: 'ollama:nomic-embed-text', ok: true, detail: '768 dimensions' }),
      ]);

      // This fake OpenAI-compatible server answers with the wrong JSON: the check must say so.
      const compatible = await check({
        MEMNEST_BASE_URL: `${base}/v1`,
        MEMNEST_COMPLETION_MODEL: 'local-model',
        MEMNEST_EMBEDDING_MODEL: 'local-embed',
        MEMNEST_EMBEDDING_DIMENSIONS: '3',
      });
      expect(compatible.code).toBe(1);
      expect(compatible.report.results).toEqual([
        expect.objectContaining({ kind: 'completion', id: 'openai:local-model', ok: false, detail: expect.stringContaining('did not match') }),
        expect.objectContaining({ kind: 'embeddings', id: 'openai:local-embed', ok: true, detail: '3 dimensions' }),
      ]);

      expect((await check({})).code).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('extracts memories through a real Ollama-style endpoint: jobs run, runs, retry, worker', async () => {
    let mode: 'ok' | 'down' = 'down';
    const candidates = {
      candidates: [
        { content: 'The user works at Stripe as a product manager.', kind: 'fact', confidence: 0.95, validUntil: null },
        { content: 'She manages it.', kind: 'fact', confidence: 0.8, validUntil: null },
      ],
    };
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (mode === 'down') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end('{"error":"model not found"}');
          return;
        }
        const body = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: body.model, message: { content: JSON.stringify(candidates) }, done_reason: 'stop' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const env = {
      MEMNEST_PROVIDER: 'ollama',
      MEMNEST_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      MEMNEST_COMPLETION_MODEL: 'llama3.1:8b',
    };
    const withEnv = async (argv: string[], signal?: AbortSignal) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run([...argv, '--db', db], { out: (t) => out.push(t), err: (t) => err.push(t), env, ...(signal ? { signal } : {}) });
      return { code, out: out.join('\n'), err: err.join('\n') };
    };

    try {
      await memnest('migrate');
      const transcript = join(dir, 'call.json');
      writeFileSync(transcript, JSON.stringify([{ role: 'user', content: 'I just joined Stripe as a PM. My boss Dana runs payments.' }]));
      await memnest('ingest', transcript, '--container', 'user:1', '--extraction', 'instant');

      // Model endpoint rejects the request: a permanent failure, visible in jobs and runs.
      const failed = await withEnv(['jobs', 'run']);
      expect(failed.code).toBe(1);
      expect(failed.err).toContain('failed permanently');
      const [job] = await json<Array<{ job: { id: string }; status: string; lastError: string }>>('jobs', '--container', 'user:1', '--status', 'failed');
      expect(job!.lastError).toContain('model not found');

      // Fix the endpoint, retry the job, run it.
      mode = 'ok';
      expect((await memnest('jobs', 'retry', job!.job.id, '--container', 'user:1')).code).toBe(0);
      expect(await withEnv(['jobs', 'run', '--json'])).toMatchObject({ code: 0 });
      const memories = await json<Memory[]>('memories', 'list', '--container', 'user:1');
      expect(memories.map((m) => m.content)).toEqual(['The user works at Stripe as a product manager.']);

      const runs = await memnest('runs', '--container', 'user:1');
      expect(runs.out).toContain('succeeded');
      expect(runs.out).toMatch(/unresolved-pronoun\s+She manages it\./);
      expect(runs.out).toContain('model not found');

      // The worker picks up new work in the background and stops cleanly.
      await memnest('memories', 'add', 'Placeholder so the container exists.', '--container', 'user:2');
      writeFileSync(transcript, JSON.stringify([{ role: 'user', content: 'I work at Stripe now.' }]));
      await memnest('ingest', transcript, '--container', 'user:2', '--extraction', 'instant');
      const controller = new AbortController();
      const worker = withEnv(['worker'], controller.signal);
      for (let i = 0; i < 200; i++) {
        const listed = await json<Memory[]>('memories', 'list', '--container', 'user:2');
        if (listed.length > 1) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      controller.abort();
      const stopped = await worker;
      expect(stopped.code).toBe(0);
      expect(stopped.err).toContain('Worker running');
      expect(await json<Memory[]>('memories', 'list', '--container', 'user:2')).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('runs the eval suite with scripted models', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(['eval', '--case', 'noise'], { out: (t) => out.push(t), err: (t) => err.push(t), env: {} });
    expect(code).toBe(0);
    expect(err.join('\n')).toContain('✓ noise-rejection');
    expect(out.join('\n')).toContain('1 passed, 0 failed, 0 pending, 0 skipped (mock, memory store)');

    const live = await run(['eval', '--live'], { out: () => undefined, err: (t) => err.push(t), env: {} });
    expect(live).toBe(2);
    expect(err.join('\n')).toContain('--live needs a completion provider');
  });

  const databaseUrl = process.env.MEMNEST_TEST_DATABASE_URL;
  (databaseUrl ? it : it.skip)('runs hybrid recall end to end on Postgres with an Ollama-style embedder', async () => {
    const dims = 768;
    const embed = (text: string) => {
      // Deterministic word hashing: enough for "shares words ⇒ similar".
      const v = new Array(dims).fill(0);
      for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
        let h = 0;
        for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % dims;
        v[h] += 1;
      }
      return v;
    };
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ embeddings: (body.input as string[]).map(embed) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const schema = `memnest_cli_${Date.now()}`;
    const env = {
      MEMNEST_DATABASE_URL: databaseUrl!,
      MEMNEST_PG_SCHEMA: schema,
      MEMNEST_EMBEDDING_PROVIDER: 'ollama',
      MEMNEST_EMBEDDING_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    };
    const pgRun = async (...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run([...argv, '--json'], { out: (t) => out.push(t), err: (t) => err.push(t), env });
      if (code !== 0) throw new Error(`memnest ${argv.join(' ')} exited ${code}: ${err.join('\n')}`);
      return JSON.parse(out.join('\n'));
    };

    try {
      expect(await pgRun('migrate')).toMatchObject({ version: 2 });
      const postgres = await pgRun('memories', 'add', 'The user prefers Postgres over MongoDB for the payments database.', '--container', 'user:123');
      const mysql = await pgRun('memories', 'add', 'The user moved the payments database to MySQL.', '--container', 'user:123', '--supersedes', postgres.id);
      const response = (await pgRun('search', 'what database does this user use?', '--container', 'user:123', '--budget', '200')) as SearchResponse;

      expect(response.trace.degraded).toBeUndefined();
      expect(response.memories.map((m) => m.memory.id)).toEqual([mysql.id]);
      expect(response.trace.candidates.find((c) => c.memoryId === postgres.id)).toMatchObject({ excludedReason: 'not-latest', vectorRank: expect.any(Number) });
      expect(response.trace.candidates.find((c) => c.memoryId === mysql.id)).toMatchObject({ included: true, lexicalRank: expect.any(Number), vectorRank: expect.any(Number) });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      const store = await createPostgresStore({ connectionString: databaseUrl!, schema });
      await store.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await store.close();
    }
  }, 60_000);

  it('fails loudly on bad usage', async () => {
    await memnest('migrate');
    expect((await memnest('jobs', 'run')).err).toMatch(/needs a completion provider/);

    expect((await memnest('frobnicate')).code).toBe(2);
    expect((await memnest('search', 'x')).err).toMatch(/--container is required/);
    expect((await memnest('search', 'x', '--container', 'user:1', '--nope')).code).toBe(2);
    expect((await memnest('forget', 'mem_missing', '--container', 'user:1')).err).toMatch(/not_found/);
  });
});
