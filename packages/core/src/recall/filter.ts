import type { ExcludedReason, Memory } from '../types';

/**
 * Why a memory may not be served as "true now", or undefined if it may.
 * Forgotten outranks not-latest outranks expired: the most deliberate reason wins.
 */
export function exclusionReason(memory: Memory, now: string): ExcludedReason | undefined {
  if (memory.forgottenAt) return 'forgotten';
  if (!memory.isLatest) return 'not-latest';
  if (memory.validUntil && Date.parse(memory.validUntil) <= Date.parse(now)) return 'expired';
  return undefined;
}
