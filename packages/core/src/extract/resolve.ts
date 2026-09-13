import type { EmbeddingProvider, MemoryStore } from '../ports';
import { retrieve } from '../recall/retrieve';
import { queryTerms } from '../text';
import type { Memory, ResolutionDecision, Scope } from '../types';
import { comparableContent, type Candidate } from './screen';

export interface ResolveInput {
  candidate: Candidate;
  /**
   * Latest, remembered memories most similar to the candidate (stored ones, plus
   * memories planned earlier in the same extraction). Most similar first, at most 10.
   */
  neighbors: Memory[];
  /** When the candidate is true as of. */
  referenceDate: string;
}

export interface ResolverResult {
  relation: ResolutionDecision['relation'];
  /** Required for duplicate, updates and extends; always one of the neighbors' ids. */
  memoryId?: string;
  reason?: string;
  via: ResolutionDecision['via'];
  calls: number;
  usage: { inputTokens: number; outputTokens: number };
}

/** Decides how a candidate relates to what the container already knows. */
export interface Resolver {
  readonly id: string;
  resolve(input: ResolveInput): Promise<ResolverResult>;
}

export const NEIGHBOR_LIMIT = 10;

export interface NeighborSearch {
  store: MemoryStore;
  embedder?: EmbeddingProvider | undefined;
  /** The candidate's embedding, when already computed. */
  embedding?: Float32Array | undefined;
  /** Vector neighbors at or below this cosine similarity are ignored. */
  minVectorScore?: number;
}

/** Latest, remembered memories most similar to the candidate: hybrid when embeddings exist, lexical otherwise. */
export async function nearestLatestMemories(
  candidate: Pick<Candidate, 'content'>,
  scope: Scope,
  search: NeighborSearch,
  limit = NEIGHBOR_LIMIT,
): Promise<Memory[]> {
  const retrieved = await retrieve({ store: search.store, embedder: search.embedder }, candidate.content, scope, 'memories', {
    k: limit * 5,
    ...(search.embedding ? { embedding: search.embedding } : {}),
    ...(search.minVectorScore !== undefined ? { minVectorScore: search.minVectorScore } : {}),
  });
  return retrieved.hits
    .map((h) => h.row)
    .filter((m) => m.isLatest && !m.forgottenAt)
    .slice(0, limit);
}

/** Whether two texts share a meaningful term. Used to pick same-batch neighbors. */
export function sharesTerms(a: string, b: string): boolean {
  const terms = new Set(queryTerms(a));
  return queryTerms(b).some((t) => terms.has(t));
}

const none = { calls: 0, usage: { inputTokens: 0, outputTokens: 0 } };

/** A neighbor with the same text, ignoring case, whitespace and trailing punctuation. */
export function exactMatch(input: ResolveInput): Memory | undefined {
  const key = comparableContent(input.candidate.content);
  return input.neighbors.find((m) => comparableContent(m.content) === key);
}

/**
 * Conservative resolver: exact text matches are duplicates, everything else is new.
 * It never invents UPDATES or EXTENDS, so it cannot corrupt the graph, but it misses
 * rephrasings and contradictions. Used when no completion provider is available.
 */
export const exactDuplicateResolver: Resolver = {
  id: 'exact-duplicate',
  async resolve(input) {
    if (input.neighbors.length === 0) return { relation: 'new', via: 'no-neighbors', ...none };
    const match = exactMatch(input);
    return match ? { relation: 'duplicate', memoryId: match.id, via: 'exact', ...none } : { relation: 'new', via: 'exact', ...none };
  },
};
