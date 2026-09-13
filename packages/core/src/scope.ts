import { ScopeViolationError, ValidationError } from './errors';
import type { Scope } from './types';

const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_\-.:@/]{0,255}$/;

export function assertValidContainerTag(tag: unknown): asserts tag is string {
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
    throw new ValidationError(
      `invalid containerTag ${JSON.stringify(tag)}: expected 1-256 chars of [A-Za-z0-9_-.:@/], starting alphanumeric`,
    );
  }
}

/** The only way to build a Scope. Validates the tag and freezes the result. */
export function scopeOf(containerTag: string): Scope {
  assertValidContainerTag(containerTag);
  return Object.freeze({ containerTag });
}

/** Stores call this on every row they are asked to write. */
export function assertInScope(scope: Scope, rowContainerTag: string, what: string): void {
  if (rowContainerTag !== scope.containerTag) {
    throw new ScopeViolationError(scope.containerTag, rowContainerTag, what);
  }
}
