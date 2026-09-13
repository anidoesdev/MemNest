import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_EXTRACTION_OPTIONS,
  createInMemoryJobQueue,
  createMemnest,
  errorMessage,
  scopeOf,
  unresolvedPronouns,
  type CompletionProvider,
  type EmbeddingProvider,
  type JobQueue,
  type MemoryStore,
  type SearchResponse,
} from '@memnest/core';
import { createInMemoryStore, fixedClock, hashEmbedder, scriptedModel, sequentialIds } from '@memnest/core/testing';
import { createPostgresStore, quoteSchema } from '@memnest/store-postgres';
import { createSqliteStore } from '@memnest/store-sqlite';
import { randomUUID } from 'node:crypto';
import { EVAL_CASES } from './cases';
import type { EvalAssertion, EvalCase, EvalReport, EvalResult } from './types';

/** Milestones built in this version. Cases requiring anything else report as pending. */
export const BUILT_MILESTONES: ReadonlySet<string> = new Set(['M0', 'M1', 'M2', 'M3', 'M4']);

export const EVAL_START = '2026-03-10T09:00:00.000Z';
const CONTAINER = 'user:eval';

export interface RunEvalsOptions {
  /** 'mock' uses each case's scripted model output. 'live' needs `completion`. */
  mode: 'mock' | 'live';
  /** 'memory' has exact vector search; 'sqlite' is lexical-only; 'postgres' needs databaseUrl. Default 'memory'. */
  store?: 'memory' | 'sqlite' | 'postgres';
  databaseUrl?: string;
  completion?: CompletionProvider;
  /** Live mode: your embedding provider. Mock mode uses a deterministic hash embedder on vector-capable stores. */
  embedder?: EmbeddingProvider;
  cases?: EvalCase[];
  /** Run only cases whose name includes this. */
  filter?: string;
  onResult?: (result: EvalResult) => void;
}

interface Harness {
  store: MemoryStore;
  queue: JobQueue;
  persistedBytes(): string | Promise<string>;
  dispose(): Promise<void>;
}

async function openHarness(kind: 'memory' | 'sqlite' | 'postgres', clock: ReturnType<typeof fixedClock>, databaseUrl?: string): Promise<Harness> {
  if (kind === 'postgres') {
    if (!databaseUrl) throw new Error('the postgres eval store needs databaseUrl');
    const schema = `memnest_eval_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const store = await createPostgresStore({ connectionString: databaseUrl, schema, autoMigrate: true, clock, maxConnections: 4 });
    const s = quoteSchema(schema);
    return {
      store,
      queue: store.jobQueue(),
      persistedBytes: async () => {
        const tables = await store.pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [schema]);
        const rows: string[] = [];
        for (const { table_name } of tables.rows) {
          rows.push(...(await store.pool.query(`SELECT row_to_json(t)::text AS r FROM ${s}."${table_name}" t`)).rows.map((r) => r.r as string));
        }
        return rows.join('\n');
      },
      dispose: async () => {
        await store.pool.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
        await store.close();
      },
    };
  }
  if (kind === 'memory') {
    const store = createInMemoryStore({ vector: true });
    return {
      store,
      queue: createInMemoryJobQueue({ clock }),
      persistedBytes: () => store.dump(),
      dispose: () => store.close(),
    };
  }
  const dir = mkdtempSync(join(tmpdir(), 'memnest-eval-'));
  const filename = join(dir, 'eval.db');
  const store = createSqliteStore({ filename, autoMigrate: true, clock });
  return {
    store,
    queue: store.jobQueue(),
    persistedBytes: () => {
      store.db.pragma('wal_checkpoint(TRUNCATE)');
      return ['', '-wal', '-shm']
        .map((suffix) => filename + suffix)
        .filter((path) => existsSync(path))
        .map((path) => readFileSync(path).toString('latin1'))
        .join('\n');
    },
    dispose: async () => {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const pattern = (source: string) => new RegExp(source, 'i');

export async function runCase(evalCase: EvalCase, options: RunEvalsOptions): Promise<EvalResult> {
  const started = performance.now();
  const base: Omit<EvalResult, 'status' | 'durationMs'> = {
    name: evalCase.name,
    summary: evalCase.summary,
    failures: [],
    skipped: 0,
    completionCalls: { extraction: 0, resolution: 0 },
    memories: [],
  };
  if (evalCase.requires && !BUILT_MILESTONES.has(evalCase.requires)) {
    return { ...base, status: 'pending', pendingReason: `needs ${evalCase.requires}`, durationMs: 0 };
  }
  if (evalCase.liveOnly && options.mode !== 'live') {
    return { ...base, status: 'skipped', pendingReason: 'needs a real model: scripted output cannot test meaning', durationMs: 0 };
  }
  if (evalCase.liveOnly && !options.embedder) {
    return { ...base, status: 'skipped', pendingReason: 'needs an embedding provider', durationMs: 0 };
  }
  if (options.mode === 'live' && !options.completion) throw new Error('live evals need a completion provider');

  const clock = fixedClock(EVAL_START);
  const harness = await openHarness(options.store ?? 'memory', clock, options.databaseUrl);
  const scope = scopeOf(CONTAINER);
  const calls = { extraction: 0, resolution: 0 };
  const inner =
    options.mode === 'live'
      ? options.completion!
      : scriptedModel({ extraction: evalCase.mock?.extraction ?? [], ...(evalCase.mock?.resolution ? { resolution: evalCase.mock.resolution } : {}) });
  const completion: CompletionProvider = {
    ...(inner.id ? { id: inner.id } : {}),
    complete: (request) => {
      if (request.schemaName === 'memnest_resolution') calls.resolution++;
      if (request.schemaName === 'memnest_candidates') calls.extraction++;
      return inner.complete(request);
    },
  };
  const embedder = options.mode === 'live' ? options.embedder : hashEmbedder();
  const memnest = createMemnest({
    store: harness.store,
    queue: harness.queue,
    clock,
    completion,
    ids: sequentialIds(),
    ...(embedder ? { embedder } : {}),
  });
  const failures = base.failures;

  try {
    for (const step of evalCase.steps) {
      if ('add' in step) await memnest.add({ ...step.add, containerTag: CONTAINER });
      else if ('memories' in step) await memnest.addMemories({ containerTag: CONTAINER, memories: step.memories });
      else if ('advance' in step) clock.advance(step.advance);
      else {
        clock.advance(DEFAULT_EXTRACTION_OPTIONS.maxBatchDelayMs + 1000);
        for (let round = 0; round < 10; round++) {
          const summary = await memnest.processDueJobs();
          if (summary.failed > 0) failures.push(`${summary.failed} extraction job(s) failed`);
          if (summary.processed === 0) break;
        }
      }
    }

    const all = await memnest.listMemories(scope, { limit: 1000 }, { includeForgotten: true });
    const latest = all.filter((m) => m.isLatest && !m.forgottenAt);
    base.memories = latest.map((m) => m.content);
    const runs = await memnest.listExtractionRuns(scope, { limit: 1000 });
    for (const run of runs) if (run.status === 'failed') failures.push(`extraction run failed: ${run.error}`);
    const response: SearchResponse | undefined = evalCase.query
      ? await memnest.search(evalCase.query.text, scope, { tokenBudget: evalCase.query.tokenBudget ?? 2000 })
      : undefined;
    let profileText: string | undefined;
    const readProfile = async () => {
      if (profileText === undefined) {
        await memnest.processDueJobs();
        profileText = (await memnest.profile(scope)).text;
      }
      return profileText;
    };
    const needsQuery = (a: EvalAssertion) => {
      if (!response) throw new Error(`assertion ${a.type} needs the case to define a query`);
      return response;
    };

    for (const assertion of evalCase.assertions) {
      if (assertion.mockOnly && options.mode === 'live') {
        base.skipped++;
        continue;
      }
      switch (assertion.type) {
        case 'memory-count': {
          const n = (assertion.latestOnly ? latest : all.filter((m) => !m.forgottenAt)).length;
          if (assertion.eq !== undefined && n !== assertion.eq) failures.push(`expected ${assertion.eq} memories, got ${n}`);
          if (assertion.min !== undefined && n < assertion.min) failures.push(`expected at least ${assertion.min} memories, got ${n}`);
          if (assertion.max !== undefined && n > assertion.max) failures.push(`expected at most ${assertion.max} memories, got ${n}`);
          break;
        }
        case 'memory-exists': {
          const found = all.find(
            (m) =>
              pattern(assertion.matches).test(m.content) &&
              !m.forgottenAt &&
              (assertion.kind === undefined || m.kind === assertion.kind) &&
              (assertion.latest === undefined || m.isLatest === assertion.latest) &&
              (assertion.minReinforcement === undefined || m.reinforcementCount >= assertion.minReinforcement),
          );
          if (!found) failures.push(`no memory matching /${assertion.matches}/i${assertion.kind ? ` of kind ${assertion.kind}` : ''}`);
          break;
        }
        case 'memory-absent': {
          const found = latest.find((m) => pattern(assertion.matches).test(m.content));
          if (found) failures.push(`unexpected memory matching /${assertion.matches}/i: "${found.content}"`);
          break;
        }
        case 'no-unresolved-pronouns':
          for (const m of all) {
            const pronouns = unresolvedPronouns(m.content);
            if (pronouns.length > 0) failures.push(`unresolved pronoun(s) ${pronouns.join(', ')} in "${m.content}"`);
          }
          break;
        case 'no-secrets-persisted': {
          const bytes = await harness.persistedBytes();
          for (const secret of assertion.secrets) if (bytes.includes(secret)) failures.push(`secret persisted: ${secret.slice(0, 8)}…`);
          break;
        }
        case 'rejected': {
          const n = runs.flatMap((r) => r.stats?.rejected ?? []).filter((r) => r.reason === assertion.reason).length;
          if (n < (assertion.min ?? 1)) failures.push(`expected at least ${assertion.min ?? 1} candidate(s) rejected as ${assertion.reason}, got ${n}`);
          break;
        }
        case 'completion-calls': {
          const kind = assertion.kind ?? 'extraction';
          const n = calls[kind];
          if (assertion.eq !== undefined && n !== assertion.eq) failures.push(`expected ${assertion.eq} ${kind} call(s), got ${n}`);
          if (assertion.max !== undefined && n > assertion.max) failures.push(`expected at most ${assertion.max} ${kind} call(s), got ${n}`);
          break;
        }
        case 'relation-exists': {
          const from = all.filter((m) => pattern(assertion.from).test(m.content));
          const to = new Set(all.filter((m) => pattern(assertion.to).test(m.content)).map((m) => m.id));
          const ok = from.some((m) =>
            assertion.relation === 'updates' ? m.supersedes !== undefined && to.has(m.supersedes) : m.extendsIds.some((id) => to.has(id)),
          );
          if (!ok) failures.push(`no ${assertion.relation} edge from /${assertion.from}/i to /${assertion.to}/i`);
          break;
        }
        case 'recall-includes': {
          const results = needsQuery(assertion).memories.slice(0, assertion.topK ?? Infinity);
          if (!results.some((r) => pattern(assertion.matches).test(r.memory.content))) {
            failures.push(`recall${assertion.topK ? ` top ${assertion.topK}` : ''} has nothing matching /${assertion.matches}/i`);
          }
          break;
        }
        case 'profile-includes':
          if (!pattern(assertion.matches).test(await readProfile())) failures.push(`profile has nothing matching /${assertion.matches}/i`);
          break;
        case 'profile-excludes':
          if (pattern(assertion.matches).test(await readProfile())) failures.push(`profile still states /${assertion.matches}/i`);
          break;
        case 'recall-excludes': {
          const res = needsQuery(assertion);
          const served = res.memories.find((r) => pattern(assertion.matches).test(r.memory.content));
          if (served) failures.push(`recall served "${served.memory.content}"`);
          if (assertion.reason) {
            const ids = new Set(all.filter((m) => pattern(assertion.matches).test(m.content)).map((m) => m.id));
            const traced = res.trace.candidates.filter((c) => ids.has(c.memoryId));
            if (!traced.some((c) => c.excludedReason === assertion.reason)) {
              failures.push(
                `trace does not show /${assertion.matches}/i excluded as ${assertion.reason} (saw: ${traced.map((c) => c.excludedReason ?? 'included').join(', ') || 'no candidate'})`,
              );
            }
          }
          break;
        }
      }
    }
  } catch (error) {
    failures.push(`error: ${errorMessage(error)}`);
  } finally {
    await harness.dispose();
  }

  return {
    ...base,
    completionCalls: calls,
    status: failures.length === 0 ? 'passed' : 'failed',
    durationMs: Math.round(performance.now() - started),
  };
}

export async function runEvals(options: RunEvalsOptions): Promise<EvalReport> {
  const cases = (options.cases ?? EVAL_CASES).filter((c) => !options.filter || c.name.includes(options.filter));
  const results: EvalResult[] = [];
  for (const evalCase of cases) {
    const result = await runCase(evalCase, options);
    results.push(result);
    options.onResult?.(result);
  }
  return {
    mode: options.mode,
    store: options.store ?? 'memory',
    ...(options.mode === 'live' && options.completion?.id ? { model: options.completion.id } : {}),
    results,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    pending: results.filter((r) => r.status === 'pending').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };
}

export function formatResult(result: EvalResult): string {
  const icon = { passed: '✓', failed: '✗', pending: '○', skipped: '–' }[result.status];
  const detail =
    result.status === 'pending' || result.status === 'skipped'
      ? `${result.status} (${result.pendingReason})`
      : `${result.durationMs}ms, ${result.completionCalls.extraction}+${result.completionCalls.resolution} model call(s), ${result.memories.length} memories${result.skipped ? `, ${result.skipped} mock-only skipped` : ''}`;
  const lines = [`${icon} ${result.name.padEnd(20)} ${result.summary}`, `  ${detail}`];
  for (const failure of result.failures) lines.push(`    - ${failure}`);
  return lines.join('\n');
}

export function formatReport(report: EvalReport): string {
  const header = `Memnest evals — ${report.mode}${report.model ? ` (${report.model})` : ''}, ${report.store} store`;
  const footer = `${report.passed} passed, ${report.failed} failed, ${report.pending} pending, ${report.skipped} skipped`;
  return [header, '', ...report.results.map(formatResult), '', footer].join('\n');
}
