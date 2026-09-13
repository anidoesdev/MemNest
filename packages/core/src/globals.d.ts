// The only runtime globals core may touch. All are pure computation, available in
// Node 20+, Deno, Bun, workers and browsers. Anything that reaches a socket or a
// disk is a port, not a global.

declare var crypto: {
  randomUUID(): string;
  subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> };
};

declare class TextEncoder {
  encode(input: string): Uint8Array;
}

declare var performance: { now(): number };

// Timers schedule the job queue's polling loop. Waiting is not I/O.
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;
