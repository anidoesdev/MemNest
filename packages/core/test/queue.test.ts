import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  ValidationError,
  createInMemoryJobQueue,
  createInMemoryJobStorage,
  createJobQueue,
  type Job,
  type JobEvent,
} from '../src/index';
import { fixedClock } from '../src/testing/index';

const job = (id: string, runAt = '2026-01-01T00:00:00.000Z'): Job => ({
  id,
  type: 'extract',
  containerTag: 'user:1',
  documentId: `doc_${id}`,
  mode: 'instant',
  runAt,
});

describe('job queue', () => {
  it('runs due jobs only, in runAt order', async () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z');
    const queue = createInMemoryJobQueue({ clock });
    await queue.enqueue(job('later', '2026-01-01T00:05:00.000Z'));
    await queue.enqueue(job('b', '2026-01-01T00:00:00.000Z'));
    await queue.enqueue(job('a', '2025-12-31T23:59:00.000Z'));
    const ran: string[] = [];

    expect(await queue.runDue(async (j) => void ran.push(j.id))).toMatchObject({ processed: 2, succeeded: 2 });
    expect(ran).toEqual(['a', 'b']);
    clock.advance(5 * 60_000);
    await queue.runDue(async (j) => void ran.push(j.id));
    expect(ran).toEqual(['a', 'b', 'later']);
    expect(queue.list().map((r) => r.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  });

  it('retries transient failures with exponential backoff, then fails', async () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z');
    const events: JobEvent[] = [];
    const queue = createInMemoryJobQueue({ clock, maxAttempts: 3, backoffBaseMs: 1000, onEvent: (e) => events.push(e) });
    await queue.enqueue(job('flaky'));
    const failing = async () => {
      throw new ProviderError('test', 'upstream 503', { status: 503, retryable: true });
    };

    expect(await queue.runDue(failing)).toMatchObject({ processed: 1, retried: 1 });
    expect(queue.list()[0]).toMatchObject({ status: 'pending', attempts: 1, runAt: '2026-01-01T00:00:01.000Z', lastError: 'test: upstream 503' });
    expect(await queue.runDue(failing)).toMatchObject({ processed: 0 });

    clock.advance(1000);
    await queue.runDue(failing);
    expect(queue.list()[0]).toMatchObject({ attempts: 2, runAt: '2026-01-01T00:00:03.000Z' });

    clock.advance(2000);
    expect(await queue.runDue(failing)).toMatchObject({ failed: 1 });
    expect(queue.list()[0]).toMatchObject({ status: 'failed', attempts: 3 });
    expect(events.map((e) => e.type)).toEqual(['started', 'retrying', 'started', 'retrying', 'started', 'failed']);
  });

  it('fails permanent errors immediately', async () => {
    const queue = createInMemoryJobQueue({ clock: fixedClock() });
    await queue.enqueue(job('bad', '2025-01-01T00:00:00.000Z'));
    const summary = await queue.runDue(async () => {
      throw new ValidationError('broken input');
    });
    expect(summary).toMatchObject({ failed: 1, retried: 0 });
    expect(queue.list()[0]).toMatchObject({ status: 'failed', attempts: 1, lastError: 'broken input' });
  });

  it('defers without spending attempts', async () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z');
    const queue = createInMemoryJobQueue({ clock, maxAttempts: 1 });
    await queue.enqueue(job('waits'));
    let ready = false;
    const handler = async () => (ready ? undefined : { deferUntil: '2026-01-01T00:00:30.000Z' });

    expect(await queue.runDue(handler)).toMatchObject({ deferred: 1 });
    expect(queue.list()[0]).toMatchObject({ status: 'pending', attempts: 0, runAt: '2026-01-01T00:00:30.000Z' });
    expect(await queue.runDue(handler)).toMatchObject({ processed: 0 });
    // Deferred again and again: still no attempts spent, even with maxAttempts 1.
    clock.advance(30_000);
    const later = async () => ({ deferUntil: '2026-01-01T00:01:00.000Z' });
    expect(await queue.runDue(later)).toMatchObject({ deferred: 1 });
    clock.advance(30_000);
    expect(queue.list()[0]).toMatchObject({ attempts: 0 });
    ready = true;
    expect(await queue.runDue(handler)).toMatchObject({ succeeded: 1 });
  });

  it('never defers into the past', async () => {
    const queue = createInMemoryJobQueue({ clock: fixedClock('2026-01-01T00:00:00.000Z') });
    await queue.enqueue(job('j'));
    expect(await queue.runDue(async () => ({ deferUntil: '2020-01-01T00:00:00.000Z' }))).toMatchObject({ processed: 1, deferred: 1 });
  });

  it('reclaims a job whose worker died once its lease expires', async () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z');
    const storage = createInMemoryJobStorage();
    const queue = createJobQueue(storage, { clock, leaseMs: 60_000 });
    await queue.enqueue(job('orphan'));
    // A worker claims it and crashes before finishing.
    expect(await storage.claim(clock.now(), '2026-01-01T00:01:00.000Z')).not.toBeNull();

    expect(await queue.runDue(async () => undefined)).toMatchObject({ processed: 0 });
    clock.advance(61_000);
    expect(await queue.runDue(async () => undefined)).toMatchObject({ succeeded: 1 });
    expect(storage.list()[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('processes in the background until stopped, waiting for the job in flight', async () => {
    const queue = createInMemoryJobQueue({ pollIntervalMs: 5 });
    const done: string[] = [];
    queue.process(async (j) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      done.push(j.id);
    });
    await queue.enqueue(job('bg', new Date().toISOString()));
    for (let i = 0; i < 100 && done.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await queue.enqueue(job('in-flight', new Date().toISOString()));
    await new Promise((resolve) => setTimeout(resolve, 15));
    await queue.stop();
    expect(done).toContain('bg');
    const statuses = queue.list().map((r) => r.status);
    expect(statuses).not.toContain('running');
  });
});
