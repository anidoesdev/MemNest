// Rule 2: ui-core imports no framework and touches no DOM. These are the only runtime
// globals it may use, all available in browsers, workers, Node, Deno and Bun.

declare var performance: { now(): number };

declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;
