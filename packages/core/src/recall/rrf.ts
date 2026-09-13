import type { Scored } from '../types';

export const RRF_K = 60;

export interface FusedHit<T> {
  row: T;
  rrfScore: number;
  lexicalRank?: number;
  lexicalScore?: number;
  vectorRank?: number;
  vectorScore?: number;
}

/**
 * Reciprocal rank fusion: score = Σ 1 / (k + rank) over the lists a row appears in.
 * Rank-based, so lexical and vector scores never need to share a scale. Ties break
 * on the best single rank, then id, so the output is deterministic.
 */
export function fuseRrf<T extends { id: string }>(
  lexical: readonly Scored<T>[],
  vector: readonly Scored<T>[],
  k = RRF_K,
): FusedHit<T>[] {
  const byId = new Map<string, FusedHit<T>>();
  const entry = (row: T) => {
    let hit = byId.get(row.id);
    if (!hit) {
      hit = { row, rrfScore: 0 };
      byId.set(row.id, hit);
    }
    return hit;
  };
  for (const h of lexical) {
    const hit = entry(h.row);
    hit.lexicalRank = h.rank;
    hit.lexicalScore = h.score;
    hit.rrfScore += 1 / (k + h.rank);
  }
  for (const h of vector) {
    const hit = entry(h.row);
    hit.vectorRank = h.rank;
    hit.vectorScore = h.score;
    hit.rrfScore += 1 / (k + h.rank);
  }
  const bestRank = (h: FusedHit<T>) => Math.min(h.lexicalRank ?? Infinity, h.vectorRank ?? Infinity);
  return [...byId.values()].sort(
    (a, z) => z.rrfScore - a.rrfScore || bestRank(a) - bestRank(z) || (a.row.id < z.row.id ? -1 : a.row.id > z.row.id ? 1 : 0),
  );
}

/** A single retriever's list, unfused: its own score stands in for the fused score. */
export function passThrough<T extends { id: string }>(hits: readonly Scored<T>[], source: 'lexical' | 'vector'): FusedHit<T>[] {
  return hits.map((h) =>
    source === 'lexical'
      ? { row: h.row, rrfScore: h.score, lexicalRank: h.rank, lexicalScore: h.score }
      : { row: h.row, rrfScore: h.score, vectorRank: h.rank, vectorScore: h.score },
  );
}
