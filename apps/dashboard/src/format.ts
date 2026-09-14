import type { ExcludedReason, Memory, MemoryKind } from '@memnest/core';

const dateFormat = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' });
const dateTimeFormat = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const formatDate = (iso: string | null | undefined) => (iso ? dateFormat.format(new Date(iso)) : '—');
export const formatDateTime = (iso: string | null | undefined) => (iso ? dateTimeFormat.format(new Date(iso)) : '—');
export const formatNumber = (n: number) => n.toLocaleString('en');

export const KIND_LABEL: Record<MemoryKind, string> = { fact: 'Fact', preference: 'Preference', episode: 'Episode' };

export const EXCLUDED_LABEL: Record<ExcludedReason, string> = {
  'not-latest': 'Superseded',
  expired: 'Expired',
  forgotten: 'Forgotten',
  budget: 'Over budget',
  rerank: 'Reranked out',
};

/** The states a memory can be in, most important first. Text, never colour alone. */
export function memoryStatus(memory: Pick<Memory, 'isLatest' | 'forgottenAt' | 'validUntil'>, now = new Date().toISOString()): string[] {
  const status: string[] = [];
  if (memory.forgottenAt) status.push('Forgotten');
  if (!memory.isLatest) status.push('Superseded');
  if (memory.validUntil && memory.validUntil <= now) status.push('Expired');
  return status;
}
