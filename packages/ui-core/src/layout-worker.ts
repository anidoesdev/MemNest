/**
 * Worker entry: `new Worker(new URL('@memnest/ui-core/layout-worker', import.meta.url), { type: 'module' })`,
 * then `createWorkerLayoutRunner(worker)`.
 */
import { serveLayoutRequests, type MessagePortLike } from './layout/runner';

declare const self: MessagePortLike | undefined;

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') serveLayoutRequests(self);

export { serveLayoutRequests };
