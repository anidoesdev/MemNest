import type { Point } from '../geometry';
import { runLayoutRequest, type LayoutRequest } from './index';

/** Above this many nodes, layout runs off the main thread when a worker is available. */
export const WORKER_LAYOUT_THRESHOLD = 500;

export interface LayoutRunner {
  run(request: LayoutRequest): Promise<Map<string, Point>>;
  dispose?(): void;
}

/**
 * Runs layout on the calling thread, after yielding once so the caller's "laying out" state can
 * render first. The default, and what tests use; browsers should use a worker for large graphs.
 */
export const inlineLayoutRunner: LayoutRunner = {
  run: async (request) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return runLayoutRequest(request);
  },
};

/** The subset of Worker (main side) or the worker global (worker side) the protocol needs. */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  terminate?(): void;
}

export interface LayoutMessage {
  id: number;
  request: LayoutRequest;
}

export type LayoutReply = { id: number; ids: string[]; coords: Float64Array } | { id: number; error: string };

export function encodePositions(positions: Map<string, Point>): { ids: string[]; coords: Float64Array } {
  const ids = [...positions.keys()];
  const coords = new Float64Array(ids.length * 2);
  ids.forEach((id, i) => {
    const p = positions.get(id)!;
    coords[i * 2] = p.x;
    coords[i * 2 + 1] = p.y;
  });
  return { ids, coords };
}

export function decodePositions(ids: string[], coords: Float64Array): Map<string, Point> {
  const positions = new Map<string, Point>();
  ids.forEach((id, i) => positions.set(id, { x: coords[i * 2]!, y: coords[i * 2 + 1]! }));
  return positions;
}

/** Worker side: answers layout requests. `@memnest/ui-core/layout-worker` calls this on the worker global. */
export function serveLayoutRequests(port: MessagePortLike): () => void {
  const listener = (event: { data: unknown }) => {
    const { id, request } = event.data as LayoutMessage;
    try {
      const { ids, coords } = encodePositions(runLayoutRequest(request));
      port.postMessage({ id, ids, coords } satisfies LayoutReply);
    } catch (error) {
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies LayoutReply);
    }
  };
  port.addEventListener('message', listener);
  return () => port.removeEventListener('message', listener);
}

/**
 * Main side: small layouts run inline (posting would cost more than it saves); large ones are
 * sent to the worker, so a 2,000-node force layout never blocks input or painting.
 */
export function createWorkerLayoutRunner(port: MessagePortLike, options: { threshold?: number } = {}): LayoutRunner {
  const threshold = options.threshold ?? WORKER_LAYOUT_THRESHOLD;
  const pending = new Map<number, { resolve: (p: Map<string, Point>) => void; reject: (e: Error) => void }>();
  let nextId = 0;
  const listener = (event: { data: unknown }) => {
    const reply = event.data as LayoutReply;
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if ('error' in reply) waiter.reject(new Error(reply.error));
    else waiter.resolve(decodePositions(reply.ids, reply.coords));
  };
  port.addEventListener('message', listener);
  return {
    run(request) {
      if (request.nodes.length < threshold) return inlineLayoutRunner.run(request);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        port.postMessage({ id, request } satisfies LayoutMessage);
      });
    },
    dispose() {
      port.removeEventListener('message', listener);
      for (const waiter of pending.values()) waiter.reject(new Error('layout runner disposed'));
      pending.clear();
      port.terminate?.();
    },
  };
}
