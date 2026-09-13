import { ProvenanceError, ValidationError } from './errors';
import { assertInScope } from './scope';
import { MEMORY_KINDS, type Memory, type Scope } from './types';

/**
 * Stores call this for every memory they persist. A memory with no traceable
 * source is a bug; it never reaches disk.
 */
export function assertWritableMemory(scope: Scope, memory: Memory): void {
  assertInScope(scope, memory.containerTag, `memory ${memory.id}`);
  if (!Array.isArray(memory.sourceDocumentIds) || memory.sourceDocumentIds.length === 0) {
    throw new ProvenanceError(memory.id, 'sourceDocumentIds is empty');
  }
  if (!memory.extractionRunId) {
    throw new ProvenanceError(memory.id, 'extractionRunId is missing');
  }
  if (!MEMORY_KINDS.includes(memory.kind)) {
    throw new ValidationError(`memory ${memory.id} has invalid kind ${JSON.stringify(memory.kind)}`);
  }
  if (!(memory.confidence >= 0 && memory.confidence <= 1)) {
    throw new ValidationError(`memory ${memory.id} confidence must be within 0..1`);
  }
  if (memory.content.trim().length === 0) {
    throw new ValidationError(`memory ${memory.id} has empty content`);
  }
}

export function assertIsoDate(value: string | undefined, field: string): void {
  if (value === undefined) return;
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO 8601 date, got ${JSON.stringify(value)}`);
  }
}
