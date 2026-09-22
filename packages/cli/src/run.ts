import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import {
  createMemnest,
  MEMORY_KINDS,
  MemnestError,
  scopeOf,
  type AuthStore,
  type ConversationTurn,
  type ExtractionMode,
  type InspectableJobQueue,
  type JobEvent,
  type MemoryStore,
  type JobStatus,
  type MemoryKind,
  type Memnest,
  type MemnestApi,
  type SearchResponse,
} from '@memnest/core';
import { createMemnestClient } from '@memnest/client';
import { formatResult, runEvals } from '@memnest/evals';
import { serveMemnestStdio } from '@memnest/mcp/stdio';
import { PROVIDER_ENV_VARS, providersFromEnv } from '@memnest/providers';
import { createJobEventHub, createKeyring, createServer, listen } from '@memnest/server';
import { createPostgresStore, migrateDatabase } from '@memnest/store-postgres';
import { createSqliteStore, migrateFile } from '@memnest/store-sqlite';
import { seedMemories } from './seed';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  /** Stops long-running commands (`worker`). The real CLI uses SIGINT/SIGTERM. */
  signal?: AbortSignal;
  /** The MCP protocol channel for `mcp`. Default process.stdin / process.stdout. */
  stdin?: Readable;
  stdout?: Writable;
}

function describeJobEvent(event: JobEvent): string {
  switch (event.type) {
    case 'started':
      return `→ ${event.job.id} ${event.job.type === 'extract' ? `extracting ${event.job.documentId}` : 'rebuilding the profile'} (attempt ${event.attempt})`;
    case 'succeeded':
      return `✓ ${event.job.id} done`;
    case 'deferred':
      return `… ${event.job.id} waiting for the session to go quiet until ${event.until}`;
    case 'retrying':
      return `↻ ${event.job.id} failed (attempt ${event.attempt}), retrying at ${event.at}: ${event.error}`;
    case 'failed':
      return `✗ ${event.job.id} failed permanently after ${event.attempt} attempt(s): ${event.error}`;
    case 'error':
      return `! queue error: ${event.error}`;
  }
}

function waitForShutdown(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal) {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
      return;
    }
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

const processIO: CliIO = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  env: process.env,
};

export const USAGE = `memnest — context memory engine

Usage: memnest <command> [options]

Commands:
  migrate                               Apply pending schema migrations
  ingest <file...> --container <tag>    Add documents (.json conversation, .md, .txt)
  search <query> --container <tag>      Recall memories and chunks, with the trace
  memories list --container <tag>       List memories
  memories add <content> --container   Write a memory directly, bypassing extraction
  forget <memoryId> --container <tag>   Soft-delete a memory
  lineage <memoryId> --container <tag>  Show a memory's lineage DAG
  jobs --container <tag>                List extraction jobs (with --status)
  jobs run                              Process every job that is due now, then exit
  jobs retry <jobId> --container <tag>  Put a failed job back in the queue
  worker                                Process extraction jobs until stopped
  runs --container <tag>                Extraction runs with stats and rejected candidates
  profile --container <tag>             The cached profile (--rebuild to build it now)
  backfill --container <tag>            Embed memories and chunks that have no vectors yet
  seed --container <tag> --count <n>    Write synthetic memories with structure
  providers check                       Call the configured completion and embedding endpoints
  providers env                         List the environment variables that configure providers
  serve                                 Run the HTTP server (REST + SSE) and, with a completion provider, the worker
  mcp --container <tag>                 Run an MCP server over stdio: memory tools for Claude, Cursor, VS Code, agents
  keys create --name <name>             Create an API key (--container to scope it); shown once
  keys list                             List API keys
  keys revoke <keyId>                   Revoke a key and end its sessions
  eval [--live] [--store <kind>]        Run the eval suite (scripted models, or --live with yours)

Options:
  --db <path>            SQLite database (default: $MEMNEST_DB or ./memnest.db)
  --database-url <url>   Postgres instead of SQLite (default: $MEMNEST_DATABASE_URL); schema from $MEMNEST_PG_SCHEMA
  --container <tag>      Container tag, e.g. user:123
  --custom-id <id>       ingest: stable document identity
  --extraction <mode>    ingest: batched | instant | none (default batched)
  --date <iso>           ingest: when the content is about
  --budget <tokens>      search: token budget (default 2000)
  --candidates <n>       search: candidate pool per retriever (default 50)
  --kind <kind>          memories: fact | preference | episode
  --confidence <0..1>    memories add
  --supersedes <id>      memories add: the memory this updates
  --extends <id,id>      memories add: memories this enriches
  --valid-until <iso>    memories add: expiry
  --limit <n>            list limits
  --all                  memories list: include superseded and forgotten
  --rebuild              profile: build now instead of reading the cache
  --status <status>      jobs: pending | running | succeeded | failed
  --count <n>            seed: number of memories (default 1000)
  --document <id>        runs: only runs that used this document
  --live                 eval: use the configured model instead of scripted output
  --store <kind>         eval: memory (default) | sqlite | postgres
  --case <name>          eval: only cases whose name contains this
  --name <name>          keys create: what the key is for
  --port <port>          serve: default $MEMNEST_PORT or 8787
  --host <host>          serve: default $MEMNEST_HOST or 127.0.0.1
  --dashboard <dir>      serve: a built dashboard to serve (default $MEMNEST_DASHBOARD_DIR)
  --url <url>            mcp: use a Memnest server (default $MEMNEST_SERVER_URL) with $MEMNEST_KEY, instead of a local database
  --read-only            mcp: only recall, history and profile (default $MEMNEST_MCP_READ_ONLY)
  --json                 Machine-readable output
  -h, --help             Show this help`;

class UsageError extends Error {}

const OPTIONS = {
  db: { type: 'string' },
  'database-url': { type: 'string' },
  container: { type: 'string' },
  'custom-id': { type: 'string' },
  extraction: { type: 'string' },
  date: { type: 'string' },
  budget: { type: 'string' },
  candidates: { type: 'string' },
  kind: { type: 'string' },
  confidence: { type: 'string' },
  supersedes: { type: 'string' },
  extends: { type: 'string' },
  'valid-until': { type: 'string' },
  limit: { type: 'string' },
  all: { type: 'boolean' },
  rebuild: { type: 'boolean' },
  status: { type: 'string' },
  count: { type: 'string' },
  document: { type: 'string' },
  live: { type: 'boolean' },
  store: { type: 'string' },
  case: { type: 'string' },
  name: { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  dashboard: { type: 'string' },
  url: { type: 'string' },
  'read-only': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

function int(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a non-negative integer`);
  return n;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new UsageError(`--${name} is required`);
  return value;
}

function readDocument(path: string): string | ConversationTurn[] {
  const text = readFileSync(path, 'utf8');
  if (extname(path).toLowerCase() !== '.json') return text;
  const parsed: unknown = JSON.parse(text);
  const turns = Array.isArray(parsed)
    ? parsed
    : (parsed as { turns?: unknown; messages?: unknown }).turns ?? (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(turns)) throw new UsageError(`${path}: expected an array of {role, content} turns`);
  return turns as ConversationTurn[];
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function formatSearch(response: SearchResponse): string {
  const { memories, chunks, trace } = response;
  const lines: string[] = [];
  lines.push(`Memories (${memories.length})`);
  memories.forEach((m, i) =>
    lines.push(`  ${i + 1}. [${m.memory.kind}] ${m.memory.content}  (${m.memory.id}, ${m.tokens} tok)`),
  );
  lines.push(`Chunks (${chunks.length})`);
  chunks.forEach((c, i) =>
    lines.push(`  ${i + 1}. ${c.chunk.documentId}#${c.chunk.index}  ${truncate(c.chunk.content.replace(/\s+/g, ' '), 90)}  (${c.tokens} tok)`),
  );
  lines.push('');
  lines.push(
    `Trace  query="${trace.query}"${trace.degraded ? `  degraded=${trace.degraded}` : ''}  budget ${trace.budget.used}/${trace.budget.limit} tok  ${trace.timings.total ?? 0}ms`,
  );
  lines.push('  lex#  lexScore   fused      tok  status        memory');
  for (const c of trace.candidates) {
    const status = c.included ? 'included' : `✗ ${c.excludedReason}`;
    lines.push(
      `  ${String(c.lexicalRank ?? '-').padStart(4)}  ${(c.lexicalScore ?? 0).toFixed(4).padStart(8)}  ${c.rrfScore.toFixed(4).padStart(8)}  ${String(c.tokens).padStart(5)}  ${status.padEnd(12)}  ${c.memoryId}`,
    );
  }
  return lines.join('\n');
}

interface CheckResult {
  kind: 'completion' | 'embeddings';
  id: string;
  ok: boolean;
  ms: number;
  detail: string;
}

async function checkProviders(io: CliIO, emit: (human: string, data: unknown) => void): Promise<number> {
  const { completion, embedder, summary } = providersFromEnv(io.env);
  const results: CheckResult[] = [];
  const time = async (kind: CheckResult['kind'], id: string, fn: () => Promise<string>) => {
    const started = performance.now();
    try {
      const detail = await fn();
      results.push({ kind, id, ok: true, ms: Math.round(performance.now() - started), detail });
    } catch (error) {
      results.push({ kind, id, ok: false, ms: Math.round(performance.now() - started), detail: (error as Error).message });
    }
  };

  if (completion) {
    await time('completion', completion.id, async () => {
      const response = await completion.complete({
        system: 'You are a health check. Answer only with the requested JSON.',
        messages: [{ role: 'user', content: 'Return {"ok": true}.' }],
        jsonSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        schemaName: 'memnest_health_check',
        maxTokens: 64,
      });
      if ((response.json as { ok?: unknown })?.ok !== true) {
        throw new Error(`structured output did not match the schema: ${JSON.stringify(response.json)}`);
      }
      return `structured JSON ok (model ${response.model})`;
    });
  }
  if (embedder) {
    await time('embeddings', embedder.id, async () => {
      const [vector] = await embedder.embed(['Memnest provider check']);
      return `${vector!.length} dimensions`;
    });
  }

  const lines = [...summary, ''];
  for (const r of results) lines.push(`${r.ok ? '✓' : '✗'} ${r.kind.padEnd(10)} ${r.id}  ${r.ms}ms  ${r.detail}`);
  if (results.length === 0) lines.push('Nothing to check. Run `memnest providers env` to see the settings.');
  emit(lines.join('\n'), { summary, results });
  return results.length > 0 && results.every((r) => r.ok) ? 0 : 1;
}

export async function run(argv: string[], io: CliIO = processIO): Promise<number> {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    io.err(`error: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    io.out(USAGE);
    return values.help ? 0 : 2;
  }

  // MCP clients launch servers from any directory, so `mcp` keeps its database in the home directory.
  const dbPath =
    values.db ?? io.env.MEMNEST_DB ?? (command === 'mcp' ? join(homedir(), '.memnest', 'memnest.db') : 'memnest.db');
  const emit = (human: string, data: unknown) => io.out(values.json ? JSON.stringify(data, null, 2) : human);

  const databaseUrl = values['database-url'] ?? io.env.MEMNEST_DATABASE_URL;
  const pgSchema = io.env.MEMNEST_PG_SCHEMA ?? 'memnest';
  const target = databaseUrl ? `postgres schema ${pgSchema}` : dbPath;

  let store: MemoryStore | undefined;
  const open = async (
    opts: { withCompletion?: boolean; onEvent?: (event: JobEvent) => void; autoMigrate?: boolean } = {},
  ): Promise<{ memnest: Memnest; store: MemoryStore; queue: InspectableJobQueue; auth: AuthStore; hasCompletion: boolean }> => {
    // Resolve providers before touching the database, so a bad configuration fails first.
    const providers = providersFromEnv(io.env);
    if (opts.withCompletion && !providers.completion) {
      throw new UsageError('this command needs a completion provider; run `memnest providers env` to see the settings');
    }
    const queueOptions = opts.onEvent ? { onEvent: opts.onEvent } : {};
    let queue: InspectableJobQueue;
    let auth: AuthStore;
    if (databaseUrl) {
      const pgStore = await createPostgresStore({ connectionString: databaseUrl, schema: pgSchema });
      store = pgStore;
      queue = pgStore.jobQueue(queueOptions);
      auth = pgStore.authStore();
    } else {
      if (opts.autoMigrate) mkdirSync(dirname(dbPath), { recursive: true });
      const sqliteStore = createSqliteStore({ filename: dbPath, ...(opts.autoMigrate ? { autoMigrate: true } : {}) });
      store = sqliteStore;
      queue = sqliteStore.jobQueue(queueOptions);
      auth = sqliteStore.authStore();
    }
    const memnest = createMemnest({
      store,
      queue,
      ...(providers.completion ? { completion: providers.completion } : {}),
      ...(providers.embedder ? { embedder: providers.embedder } : {}),
    });
    return { memnest, store, queue, auth, hasCompletion: !!providers.completion };
  };

  try {
    switch (command) {
      case 'migrate': {
        let applied: Array<{ id: number; name: string }>;
        let current: number;
        if (databaseUrl) {
          const result = await migrateDatabase(databaseUrl, pgSchema);
          applied = result.applied;
          current = result.status.current;
        } else {
          const result = migrateFile(dbPath);
          applied = result.applied;
          current = result.status.current;
        }
        const status = { current };
        emit(
          applied.length === 0
            ? `Schema up to date at version ${status.current} (${target})`
            : `Applied ${applied.map((m) => `${m.id}_${m.name}`).join(', ')}; schema at version ${status.current} (${target})`,
          { applied: applied.map(({ id, name }) => ({ id, name })), version: status.current },
        );
        return 0;
      }

      case 'ingest': {
        if (rest.length === 0) throw new UsageError('ingest needs at least one file');
        const containerTag = required(values.container, 'container');
        if (values['custom-id'] && rest.length > 1) throw new UsageError('--custom-id applies to a single file');
        const { memnest } = await open();
        const results = [];
        for (const file of rest) {
          const result = await memnest.add({
            containerTag,
            content: readDocument(file),
            ...(values['custom-id'] ? { customId: values['custom-id'] } : {}),
            ...(values.extraction ? { extraction: values.extraction as ExtractionMode } : {}),
            ...(values.date ? { documentDate: values.date } : {}),
            metadata: { source: file },
          });
          results.push({ file, ...result });
        }
        emit(
          results
            .map(
              (r) =>
                `${r.file}: ${r.deduplicated ? 'unchanged' : r.status} ${r.documentId} v${r.version}` +
                (r.jobId ? ` (extraction job ${r.jobId} queued)` : ''),
            )
            .join('\n'),
          results,
        );
        return 0;
      }

      case 'search': {
        const query = rest.join(' ');
        if (!query) throw new UsageError('search needs a query');
        const scope = scopeOf(required(values.container, 'container'));
        const { memnest } = await open();
        const response = await memnest.search(query, scope, {
          tokenBudget: int(values.budget, 'budget', 2000),
          candidates: int(values.candidates, 'candidates', 50),
        });
        emit(formatSearch(response), response);
        return 0;
      }

      case 'memories': {
        const [sub, ...args] = rest;
        const containerTag = required(values.container, 'container');
        const { memnest } = await open();
        if (sub === 'list') {
          const kind = values.kind as MemoryKind | undefined;
          const memories = await memnest.listMemories(
            scopeOf(containerTag),
            { limit: int(values.limit, 'limit', 100) },
            { ...(kind ? { kind } : {}), latestOnly: !values.all, includeForgotten: !!values.all },
          );
          emit(
            memories
              .map(
                (m) =>
                  `${m.id}  [${m.kind}] v${m.version}${m.isLatest ? '' : ' superseded'}${m.forgottenAt ? ' forgotten' : ''}  ${m.content}`,
              )
              .join('\n') || '(no memories)',
            memories,
          );
          return 0;
        }
        if (sub === 'add') {
          const content = args.join(' ');
          if (!content) throw new UsageError('memories add needs content');
          if (values.kind && !MEMORY_KINDS.includes(values.kind as MemoryKind)) {
            throw new UsageError(`--kind must be one of ${MEMORY_KINDS.join(', ')}`);
          }
          const [memory] = await memnest.addMemories({
            containerTag,
            memories: [
              {
                content,
                ...(values.kind ? { kind: values.kind as MemoryKind } : {}),
                ...(values.confidence ? { confidence: Number(values.confidence) } : {}),
                ...(values.supersedes ? { supersedes: values.supersedes } : {}),
                ...(values.extends ? { extendsIds: values.extends.split(',').filter(Boolean) } : {}),
                ...(values['valid-until'] ? { validUntil: values['valid-until'] } : {}),
              },
            ],
          });
          emit(`${memory!.id}  [${memory!.kind}] v${memory!.version}  ${memory!.content}`, memory);
          return 0;
        }
        throw new UsageError('memories needs a subcommand: list | add');
      }

      case 'forget': {
        const [memoryId] = rest;
        if (!memoryId) throw new UsageError('forget needs a memory id');
        const { memnest } = await open();
        const memory = await memnest.forget(scopeOf(required(values.container, 'container')), memoryId);
        emit(`Forgot ${memory.id} at ${memory.forgottenAt}`, memory);
        return 0;
      }

      case 'lineage': {
        const [memoryId] = rest;
        if (!memoryId) throw new UsageError('lineage needs a memory id');
        const { memnest } = await open();
        const lineage = await memnest.getLineage(scopeOf(required(values.container, 'container')), memoryId);
        if (!lineage) {
          io.err(`error: memory ${memoryId} not found`);
          return 1;
        }
        const byId = new Map(lineage.memories.map((m) => [m.id, m]));
        const lines = lineage.memories.map(
          (m) => `${m.id === lineage.rootId ? '*' : ' '} ${m.id}  v${m.version}${m.isLatest ? '' : ' (superseded)'}${m.forgottenAt ? ' (forgotten)' : ''}  ${m.content}`,
        );
        lines.push('', 'Edges');
        for (const e of lineage.edges) {
          const target = byId.get(e.to)?.content ?? e.to;
          lines.push(`  ${e.from} ${e.relation === 'source' ? '← from document' : e.relation} ${e.relation === 'source' ? e.to : `→ ${truncate(target, 60)}`}`);
        }
        emit(lines.join('\n'), lineage);
        return 0;
      }

      case 'jobs': {
        const [sub = 'list', jobId] = rest;
        if (sub === 'run') {
          const { memnest } = await open({ withCompletion: true, onEvent: (event) => io.err(describeJobEvent(event)) });
          const summary = await memnest.processDueJobs();
          emit(
            `Processed ${summary.processed}: ${summary.succeeded} succeeded, ${summary.deferred} deferred, ${summary.retried} will retry, ${summary.failed} failed`,
            summary,
          );
          return summary.failed > 0 ? 1 : 0;
        }
        const scope = scopeOf(required(values.container, 'container'));
        const { queue: jobQueue } = await open();
        if (sub === 'retry') {
          if (!jobId) throw new UsageError('jobs retry needs a job id');
          await jobQueue.retry(scope, jobId);
          emit(`Job ${jobId} is pending again; run \`memnest jobs run\` or \`memnest worker\``, { jobId, status: 'pending' });
          return 0;
        }
        if (sub !== 'list') throw new UsageError('jobs subcommands: list | run | retry <jobId>');
        const jobs = await jobQueue.list(scope, {
          ...(values.status ? { status: values.status as JobStatus } : {}),
          limit: int(values.limit, 'limit', 100),
        });
        emit(
          jobs
            .map(
              (j) =>
                `${j.job.id}  ${j.status.padEnd(9)} attempts=${j.attempts}/${j.maxAttempts}  ${j.job.type === 'extract' ? `${j.job.mode} ${j.job.documentId}` : 'profile rebuild'}  runAt=${j.runAt}` +
                (j.lastError ? `\n    last error: ${j.lastError}` : ''),
            )
            .join('\n') || '(no jobs)',
          jobs,
        );
        return 0;
      }

      case 'worker': {
        const { memnest } = await open({ withCompletion: true, onEvent: (event) => io.err(describeJobEvent(event)) });
        memnest.startWorker();
        io.err(`Worker running on ${target}. Ctrl+C to stop.`);
        await waitForShutdown(io.signal);
        io.err('Stopping: waiting for the job in flight…');
        await memnest.close();
        store = undefined;
        return 0;
      }

      case 'serve': {
        const workerMode = io.env.MEMNEST_WORKER ?? 'auto';
        if (!['auto', 'on', 'off'].includes(workerMode)) throw new UsageError('MEMNEST_WORKER must be auto, on or off');
        const dashboardDir = values.dashboard ?? io.env.MEMNEST_DASHBOARD_DIR;
        if (dashboardDir && !existsSync(join(dashboardDir, 'index.html'))) throw new UsageError(`no dashboard build at ${dashboardDir} (index.html missing)`);
        const events = createJobEventHub();
        const { memnest, auth, hasCompletion } = await open({
          withCompletion: workerMode === 'on',
          onEvent: (event) => {
            events.publish(event);
            io.err(describeJobEvent(event));
          },
        });
        const server = createServer({
          memnest,
          auth,
          events,
          session: { secureCookie: io.env.MEMNEST_COOKIE_SECURE !== 'false' },
        });
        const http = await listen(server, {
          port: int(values.port ?? io.env.MEMNEST_PORT, 'port', 8787),
          hostname: values.host ?? io.env.MEMNEST_HOST ?? '127.0.0.1',
          ...(dashboardDir ? { dashboard: dashboardDir } : {}),
        });
        const runWorker = workerMode !== 'off' && hasCompletion;
        if (dashboardDir) io.err(`Dashboard: ${http.url}/ (from ${dashboardDir})`);
        if (runWorker) memnest.startWorker();
        io.err(`Memnest server listening on ${http.url} (${target})`);
        io.err(
          runWorker
            ? 'Worker running: extraction jobs are processed in this process.'
            : workerMode === 'off'
              ? 'Worker off (MEMNEST_WORKER=off): run `memnest worker` elsewhere to process extraction jobs.'
              : 'Worker off: no completion provider, so extraction jobs wait. Run `memnest providers env` to configure one.',
        );
        if ((await auth.listApiKeys()).every((k) => k.revokedAt)) {
          io.err('No active API keys yet. Create one with `memnest keys create --name admin`.');
        }
        await waitForShutdown(io.signal);
        io.err('Stopping…');
        await http.close();
        await memnest.close();
        store = undefined;
        return 0;
      }

      case 'mcp': {
        // stdout carries the protocol: everything human-readable goes to stderr.
        const readOnly = values['read-only'] ?? ['1', 'true'].includes(io.env.MEMNEST_MCP_READ_ONLY ?? '');
        const url = values.url ?? io.env.MEMNEST_SERVER_URL;
        let api: MemnestApi;
        let containerTag = values.container ?? io.env.MEMNEST_CONTAINER;
        let where: string;
        if (url) {
          const apiKey = io.env.MEMNEST_KEY;
          if (!apiKey) throw new UsageError('--url needs an API key in MEMNEST_KEY (create one with `memnest keys create --container <tag>`)');
          const client = createMemnestClient({ baseUrl: url, apiKey });
          const session = await client.session();
          if (session.containerTag && containerTag && session.containerTag !== containerTag) {
            throw new UsageError(`the key is scoped to ${session.containerTag}, not ${containerTag}`);
          }
          containerTag = session.containerTag ?? containerTag;
          api = client;
          where = url;
        } else {
          // A personal, local database: migrate it on first use instead of failing.
          const workerMode = io.env.MEMNEST_WORKER ?? 'auto';
          if (!['auto', 'on', 'off'].includes(workerMode)) throw new UsageError('MEMNEST_WORKER must be auto, on or off');
          const opened = await open({
            withCompletion: workerMode === 'on',
            autoMigrate: !databaseUrl,
            onEvent: (event) => io.err(describeJobEvent(event)),
          });
          if (workerMode !== 'off' && opened.hasCompletion) opened.memnest.startWorker();
          else io.err('No extraction worker: `ingest` stores text, but memories are only extracted once a completion provider is configured.');
          api = opened.memnest;
          where = target;
        }
        if (!containerTag) throw new UsageError('--container is required (or MEMNEST_CONTAINER, or a key scoped to one container)');
        scopeOf(containerTag);

        const mcp = serveMemnestStdio({
          memnest: api,
          containerTag,
          readOnly,
          ...(io.stdin ? { stdin: io.stdin } : {}),
          ...(io.stdout ? { stdout: io.stdout } : {}),
          onerror: (error) => io.err(`mcp: ${error.message}`),
        });
        io.err(`Memnest MCP server on stdio: ${containerTag} (${where})${readOnly ? ', read-only' : ''}`);
        await Promise.race([mcp.closed, waitForShutdown(io.signal)]);
        await mcp.close();
        await api.close();
        store = undefined;
        return 0;
      }

      case 'keys': {
        const [sub = 'list', keyId] = rest;
        const { auth } = await open();
        const keyring = createKeyring({ auth });
        if (sub === 'create') {
          const name = required(values.name, 'name');
          const { key, record } = await keyring.issue({ name, ...(values.container ? { containerTag: values.container } : {}) });
          emit(
            [
              key,
              '',
              `Key ${record.id} "${record.name}" ${record.containerTag ? `scoped to ${record.containerTag}` : 'unscoped: it can reach every container'}.`,
              'Store it now: only its hash is kept, so it cannot be shown again.',
            ].join('\n'),
            { key, id: record.id, name: record.name, containerTag: record.containerTag ?? null, createdAt: record.createdAt },
          );
          return 0;
        }
        if (sub === 'list') {
          // Hashes are not secrets, but nothing reading this output needs them.
          const keys = (await keyring.list()).map(({ secretHash: _hash, ...visible }) => visible);
          emit(
            keys
              .map(
                (k) =>
                  `${k.id}  ${(k.revokedAt ? 'revoked' : 'active').padEnd(7)}  ${(k.containerTag ?? '(all containers)').padEnd(20)}  ${k.name}  created ${k.createdAt}` +
                  (k.lastUsedAt ? `  last used ${k.lastUsedAt}` : ''),
              )
              .join('\n') || '(no API keys)',
            keys,
          );
          return 0;
        }
        if (sub === 'revoke') {
          if (!keyId) throw new UsageError('keys revoke needs a key id');
          if (!(await keyring.revoke(keyId))) {
            io.err(`error: no active API key ${keyId}`);
            return 1;
          }
          emit(`Revoked ${keyId}; its sessions have ended`, { id: keyId, revoked: true });
          return 0;
        }
        throw new UsageError('keys subcommands: create | list | revoke <keyId>');
      }

      case 'runs': {
        const scope = scopeOf(required(values.container, 'container'));
        const { memnest } = await open();
        const runs = await memnest.listExtractionRuns(scope, {
          limit: int(values.limit, 'limit', 20),
          ...(values.document ? { documentId: values.document } : {}),
        });
        const lines = runs.map((r) => {
          const s = r.stats;
          const head = `${r.id}  ${r.status.padEnd(9)} ${r.method} ${r.model ?? ''}  ${r.startedAt}  docs=${r.documentIds.join(',')}`;
          const body = s
            ? `    ${s.calls} extraction + ${s.resolutionCalls ?? 0} resolution call(s): ${s.candidates} candidates → ${s.accepted} accepted ` +
              `(${s.created} new, ${s.updated} updates, ${s.extended} extends, ${s.reinforced} reinforced), ${s.rejected.length} rejected`
            : '';
          const decisions = (s?.decisions ?? []).map(
            (d) =>
              `      ${d.relation.padEnd(9)} ${d.content}` +
              (d.memoryId ? `\n                → ${d.memoryId}` : '') +
              ` [${d.via}]` +
              (d.reason ? ` ${d.reason}` : ''),
          );
          const rejected = (s?.rejected ?? []).map((x) => `      ✗ ${x.reason.padEnd(18)} ${x.content}`);
          return [head, body, ...decisions, ...rejected, ...(r.error ? [`    error: ${r.error}`] : [])].filter(Boolean).join('\n');
        });
        emit(lines.join('\n') || '(no extraction runs)', runs);
        return 0;
      }

      case 'profile': {
        const scope = scopeOf(required(values.container, 'container'));
        const { memnest } = await open();
        const profile = values.rebuild ? await memnest.rebuildProfile(scope) : await memnest.profile(scope);
        const header = profile.builtAt
          ? `Profile for ${scope.containerTag}: ${profile.builder} build at ${profile.builtAt}, ${profile.memoryCount} memories, ${profile.tokens} tokens${profile.stale ? ' (rebuild pending)' : ''}`
          : `No profile for ${scope.containerTag} yet${profile.stale ? '; a rebuild is queued (run \`memnest jobs run\`, or --rebuild)' : ''}`;
        emit([header, '', profile.text || '(empty)'].join('\n'), profile);
        return 0;
      }

      case 'backfill': {
        const scope = scopeOf(required(values.container, 'container'));
        const { memnest } = await open();
        const counts = await memnest.backfillEmbeddings(scope);
        emit(`Embedded ${counts.memories} memories and ${counts.chunks} chunks in ${scope.containerTag}`, counts);
        return 0;
      }

      case 'seed': {
        const containerTag = required(values.container, 'container');
        const count = int(values.count, 'count', 1000);
        const { memnest } = await open();
        const started = Date.now();
        const memories = await seedMemories(memnest, { containerTag, count });
        emit(`Seeded ${memories.length} memories into ${containerTag} in ${Date.now() - started}ms`, {
          containerTag,
          count: memories.length,
        });
        return 0;
      }

      case 'providers': {
        const [sub] = rest;
        if (sub === 'env') {
          emit(
            Object.entries(PROVIDER_ENV_VARS)
              .map(([name, doc]) => `${name.padEnd(28)} ${doc}`)
              .join('\n'),
            PROVIDER_ENV_VARS,
          );
          return 0;
        }
        if (sub !== 'check') throw new UsageError('providers needs a subcommand: check | env');
        return await checkProviders(io, emit);
      }

      case 'eval': {
        const storeKind = values.store ?? 'memory';
        if (storeKind !== 'memory' && storeKind !== 'sqlite' && storeKind !== 'postgres') {
          throw new UsageError('--store must be memory, sqlite or postgres');
        }
        if (storeKind === 'postgres' && !databaseUrl) throw new UsageError('--store postgres needs --database-url or MEMNEST_DATABASE_URL');
        let completion;
        let embedder;
        if (values.live) {
          ({ completion, embedder } = providersFromEnv(io.env));
          if (!completion) {
            throw new UsageError('--live needs a completion provider; run `memnest providers env` to see the settings');
          }
        }
        const report = await runEvals({
          mode: values.live ? 'live' : 'mock',
          store: storeKind,
          ...(databaseUrl ? { databaseUrl } : {}),
          ...(completion ? { completion } : {}),
          ...(embedder ? { embedder } : {}),
          ...(values.case ? { filter: values.case } : {}),
          ...(values.json ? {} : { onResult: (result) => io.err(formatResult(result)) }),
        });
        if (values.json) io.out(JSON.stringify(report, null, 2));
        else io.out(`\n${report.passed} passed, ${report.failed} failed, ${report.pending} pending, ${report.skipped} skipped (${report.mode}, ${report.store} store${report.model ? `, ${report.model}` : ''})`);
        return report.failed > 0 ? 1 : 0;
      }

      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`error: ${error.message}\n\nRun \`memnest --help\` for usage.`);
      return 2;
    }
    if (error instanceof MemnestError) {
      io.err(`error [${error.code}]: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await store?.close();
  }
}
