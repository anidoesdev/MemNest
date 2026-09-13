import { defaultRedactor, type JobEvent, type JobStatusEvent, type Redactor } from '@memnest/core';

export type JobEventListener = (event: JobStatusEvent) => void;

/**
 * Fans job lifecycle events out to SSE subscribers. Pass `hub.publish` as the queue's `onEvent`.
 * Only events from queues in this process arrive: a worker running elsewhere is not streamed.
 */
export interface JobEventHub {
  publish(event: JobEvent): void;
  subscribe(listener: JobEventListener): () => void;
  /** Number of live subscribers. */
  readonly size: number;
}

/** Queue-level `error` events have no container, so they are never streamed (a scope could not be checked). */
export function toStatusEvent(event: JobEvent, redactor: Redactor = defaultRedactor): JobStatusEvent | null {
  if (event.type === 'error') return null;
  const { job } = event;
  return {
    type: event.type,
    jobId: job.id,
    jobType: job.type,
    containerTag: job.containerTag,
    ...(job.type === 'extract' ? { documentId: job.documentId } : {}),
    ...('attempt' in event ? { attempt: event.attempt } : {}),
    ...(event.type === 'deferred' ? { at: event.until } : event.type === 'retrying' ? { at: event.at } : {}),
    ...('error' in event ? { error: redactor.redact(event.error) } : {}),
  };
}

export function createJobEventHub(options: { redactor?: Redactor } = {}): JobEventHub {
  const listeners = new Set<JobEventListener>();
  return {
    publish(event) {
      const status = toStatusEvent(event, options.redactor);
      if (!status) return;
      for (const listener of listeners) {
        try {
          listener(status);
        } catch {
          // One broken subscriber must not starve the others or the queue.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get size() {
      return listeners.size;
    },
  };
}
