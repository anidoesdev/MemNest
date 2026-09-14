export type MemnestErrorCode =
  | 'not_implemented'
  | 'validation'
  | 'not_found'
  | 'scope_violation'
  | 'provenance'
  | 'transactions_unsupported'
  | 'configuration'
  | 'provider'
  | 'unauthorized'
  /** An unexpected failure. Servers report it without detail; retrying may help. */
  | 'internal';

export class MemnestError extends Error {
  readonly code: MemnestErrorCode;

  constructor(code: MemnestErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A deliberate gap. Thrown instead of stubbing so missing work fails loudly. */
export class NotImplementedError extends MemnestError {
  readonly milestone: string;

  constructor(milestone: `M${number}`, what: string) {
    super('not_implemented', `${what} is not implemented yet (milestone ${milestone})`);
    this.milestone = milestone;
  }
}

export class ValidationError extends MemnestError {
  constructor(message: string) {
    super('validation', message);
  }
}

export class NotFoundError extends MemnestError {
  constructor(what: string, id: string) {
    super('not_found', `${what} ${id} not found`);
  }
}

export class ScopeViolationError extends MemnestError {
  constructor(expected: string, actual: string, what: string) {
    super(
      'scope_violation',
      `${what} belongs to container "${actual}" but the operation is scoped to "${expected}"`,
    );
  }
}

export class ProvenanceError extends MemnestError {
  constructor(memoryId: string, detail: string) {
    super('provenance', `memory ${memoryId} has no traceable source: ${detail}`);
  }
}

export class TransactionsUnsupportedError extends MemnestError {
  constructor() {
    super(
      'transactions_unsupported',
      'this store does not support transactions; Memnest refuses to write partial graphs',
    );
  }
}

export class ConfigurationError extends MemnestError {
  constructor(message: string) {
    super('configuration', message);
  }
}

/** Missing, malformed, revoked or expired credentials. */
export class UnauthorizedError extends MemnestError {
  constructor(message = 'a valid API key or session is required') {
    super('unauthorized', message);
  }
}

/**
 * Vectors from two embedding providers are not comparable. A container is locked to the
 * provider that first wrote to it; anything else is refused rather than silently mixed.
 */
export class EmbeddingProviderMismatchError extends MemnestError {
  constructor(containerTag: string, locked: { id: string; dimensions: number }, requested: { id: string; dimensions: number }) {
    super(
      'configuration',
      `container "${containerTag}" is locked to embedding provider ${locked.id} (${locked.dimensions} dims); ` +
        `refusing ${requested.id} (${requested.dimensions} dims). Use the original provider, or re-embed into a new container.`,
    );
  }
}

/** A model provider call failed. `retryable` tells the job queue whether backing off can help. */
export class ProviderError extends MemnestError {
  readonly provider: string;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(provider: string, message: string, options: { status?: number; retryable: boolean }) {
    super('provider', `${provider}: ${message}`);
    this.provider = provider;
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

const PERMANENT_CODES: ReadonlySet<MemnestErrorCode> = new Set([
  'not_implemented',
  'validation',
  'not_found',
  'scope_violation',
  'provenance',
  'transactions_unsupported',
  'configuration',
  'unauthorized',
]);

/**
 * Whether retrying the same work later could succeed. Provider errors say so
 * themselves; other Memnest errors are permanent; unknown errors (a busy database,
 * a dropped connection) are assumed transient.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable;
  if (error instanceof MemnestError) return !PERMANENT_CODES.has(error.code);
  return true;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
