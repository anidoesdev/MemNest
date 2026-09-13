import { systemClock } from './defaults';
import { ConfigurationError, errorMessage, isRetryable } from './errors';
import type { ClaimedJob, Clock, JobQueue, JobStorage } from './ports';
import type { Job, JobEvent, JobHandler, JobRecord, JobRunSummary, Scope } from './types';

export interface JobQueueOptions {
  clock?: Clock;
  /** Default 5. */
  maxAttempts?: number;
  /** Background polling interval. Default 1000ms. */
  pollIntervalMs?: number;
  /** How long a claimed job is reserved before another worker may take it over. Default 10 minutes. */
  leaseMs?: number;
  /** First retry delay; doubles per attempt. Default 5s. */
  backoffBaseMs?: number;
  /** Default 10 minutes. */
  backoffMaxMs?: number;
  /** Job lifecycle events, e.g. for SSE. Must not throw. */
  onEvent?: (event: JobEvent) => void;
}

export interface ManagedJobQueue extends JobQueue {
  runDue(handler?: JobHandler): Promise<JobRunSummary>;
  stop(): Promise<void>;
}

/**
 * A durable-enough queue over any JobStorage: attempts, exponential backoff,
 * leases for crashed workers, and deferral for jobs that are not ready yet.
 * Processes one job at a time; extraction is model-bound, not CPU-bound.
 */
export function createJobQueue(storage: JobStorage, options: JobQueueOptions = {}): ManagedJobQueue {
  const clock = options.clock ?? systemClock;
  const maxAttempts = options.maxAttempts ?? 5;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const leaseMs = options.leaseMs ?? 10 * 60_000;
  const backoffBaseMs = options.backoffBaseMs ?? 5000;
  const backoffMaxMs = options.backoffMaxMs ?? 10 * 60_000;
  const emit = (event: JobEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // A broken listener must not break the queue.
    }
  };
  const at = (base: string, ms: number) => new Date(Date.parse(base) + ms).toISOString();

  let registered: JobHandler | undefined;
  let stopped = true;
  let timer: unknown;
  let inFlight: Promise<unknown> = Promise.resolve();

  async function runClaimed(claimed: ClaimedJob, handler: JobHandler, summary: JobRunSummary): Promise<void> {
    const { job, attempts } = claimed;
    emit({ type: 'started', job, attempt: attempts });
    try {
      const result = await handler(job);
      const now = clock.now();
      if (result && typeof result === 'object' && 'deferUntil' in result) {
        // Never reschedule into the past, or the job would be reclaimed in the same loop forever.
        const until = Date.parse(result.deferUntil) > Date.parse(now) ? result.deferUntil : at(now, 1);
        await storage.reschedule(job.id, until, { now, countAttempt: false });
        summary.deferred++;
        emit({ type: 'deferred', job, until });
      } else {
        await storage.complete(job.id, now);
        summary.succeeded++;
        emit({ type: 'succeeded', job, attempt: attempts });
      }
    } catch (error) {
      const now = clock.now();
      const message = errorMessage(error);
      if (isRetryable(error) && attempts < claimed.maxAttempts) {
        const retryAt = at(now, Math.min(backoffMaxMs, backoffBaseMs * 2 ** (attempts - 1)));
        await storage.reschedule(job.id, retryAt, { now, error: message, countAttempt: true });
        summary.retried++;
        emit({ type: 'retrying', job, attempt: attempts, at: retryAt, error: message });
      } else {
        await storage.fail(job.id, message, now);
        summary.failed++;
        emit({ type: 'failed', job, attempt: attempts, error: message });
      }
    }
  }

  async function runDue(handler: JobHandler | undefined = registered): Promise<JobRunSummary> {
    if (!handler) throw new ConfigurationError('no job handler: pass one to runDue() or call process() first');
    const summary: JobRunSummary = { processed: 0, succeeded: 0, deferred: 0, retried: 0, failed: 0 };
    for (;;) {
      const now = clock.now();
      const claimed = await storage.claim(now, at(now, leaseMs));
      if (!claimed) return summary;
      summary.processed++;
      await runClaimed(claimed, handler, summary);
    }
  }

  function loop(): void {
    if (stopped) return;
    inFlight = runDue()
      .catch((error: unknown) => emit({ type: 'error', error: errorMessage(error) }))
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, pollIntervalMs);
      });
  }

  return {
    async enqueue(job: Job) {
      await storage.insert(job, { maxAttempts, now: clock.now() });
    },
    process(handler) {
      registered = handler;
      if (!stopped) return;
      stopped = false;
      loop();
    },
    runDue,
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
      await inFlight;
    },
  };
}

interface StoredJob extends JobRecord {
  lockedUntil?: string;
  seq: number;
}

export interface InMemoryJobStorage extends JobStorage {
  list(scope?: Scope): JobRecord[];
}

export function createInMemoryJobStorage(): InMemoryJobStorage {
  const rows = new Map<string, StoredJob>();
  let seq = 0;
  const row = (id: string) => {
    const found = rows.get(id);
    if (!found) throw new ConfigurationError(`job ${id} does not exist`);
    return found;
  };
  const toRecord = ({ lockedUntil: _l, seq: _s, ...record }: StoredJob): JobRecord => ({ ...record, job: { ...record.job } });

  return {
    async insert(job, { maxAttempts, now }) {
      rows.set(job.id, {
        job: { ...job },
        status: 'pending',
        attempts: 0,
        maxAttempts,
        runAt: job.runAt,
        createdAt: now,
        updatedAt: now,
        seq: seq++,
      });
    },
    async claim(now, lockedUntil) {
      const due = [...rows.values()]
        .filter((r) => (r.status === 'pending' && r.runAt <= now) || (r.status === 'running' && (r.lockedUntil ?? '') < now))
        .sort((a, z) => (a.runAt < z.runAt ? -1 : a.runAt > z.runAt ? 1 : a.seq - z.seq))[0];
      if (!due) return null;
      due.status = 'running';
      due.attempts += 1;
      due.lockedUntil = lockedUntil;
      due.updatedAt = now;
      return { job: { ...due.job }, attempts: due.attempts, maxAttempts: due.maxAttempts };
    },
    async complete(id, now) {
      Object.assign(row(id), { status: 'succeeded', lockedUntil: undefined, updatedAt: now });
    },
    async reschedule(id, runAt, { now, error, countAttempt }) {
      const existing = row(id);
      Object.assign(existing, {
        status: 'pending',
        runAt,
        lockedUntil: undefined,
        updatedAt: now,
        attempts: countAttempt ? existing.attempts : existing.attempts - 1,
        ...(error !== undefined ? { lastError: error } : {}),
      });
    },
    async fail(id, error, now) {
      Object.assign(row(id), { status: 'failed', lastError: error, lockedUntil: undefined, updatedAt: now });
    },
    list: (scope) =>
      [...rows.values()]
        .filter((r) => !scope || r.job.containerTag === scope.containerTag)
        .sort((a, z) => a.seq - z.seq)
        .map(toRecord),
  };
}

export interface InMemoryJobQueue extends ManagedJobQueue {
  list(scope?: Scope): JobRecord[];
}

/** Process-local queue. Jobs are lost on restart; persistent stores ship a queue on their own jobs table. */
export function createInMemoryJobQueue(options: JobQueueOptions = {}): InMemoryJobQueue {
  const storage = createInMemoryJobStorage();
  return { ...createJobQueue(storage, options), list: storage.list };
}
