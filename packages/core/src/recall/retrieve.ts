import { ConfigurationError, EmbeddingProviderMismatchError, errorMessage } from '../errors';
import type { EmbeddingProvider, MemoryStore, MemoryStoreOps } from '../ports';
import type { RowByTarget, Scope, Scored, SearchTarget } from '../types';
import { fuseRrf, passThrough, type FusedHit } from './rrf';

export interface RetrievalDeps {
  store: MemoryStore;
  embedder?: EmbeddingProvider | undefined;
}

export interface RetrievalOptions {
  k: number;
  /** Reuse an embedding already computed for this text (the query, or a candidate). */
  embedding?: Float32Array;
  /** Vector hits at or below this similarity are dropped. Default 0. */
  minVectorScore?: number;
  /** Read through a transaction instead of the store. */
  via?: MemoryStoreOps;
}

export interface Retrieval<T> {
  hits: FusedHit<T>[];
  /** Set whenever retrieval ran with fewer retrievers than the store and engine could offer. */
  degraded?: string;
  /** The query embedding, when one was computed or supplied, for reuse. */
  embedding?: Float32Array;
  timings: Record<string, number>;
}

const round = (ms: number) => Math.round(ms * 100) / 100;

/**
 * Decides once per query whether vector search can run, and why not. The answer is the
 * same for memories and chunks, so recall asks once and passes it to both retrievals.
 */
export async function vectorPlan(
  deps: RetrievalDeps,
  scope: Scope,
): Promise<{ enabled: true } | { enabled: false; reason: string | undefined }> {
  const caps = deps.store.capabilities();
  if (!caps.vector) return { enabled: false, reason: caps.fullText ? 'lexical-only' : undefined };
  if (!deps.embedder) return { enabled: false, reason: 'lexical-only: no embedding provider configured' };
  const container = await deps.store.getContainer(scope);
  if (!container?.embeddingProviderId) return { enabled: false, reason: 'lexical-only: container has no embeddings yet' };
  if (container.embeddingProviderId !== deps.embedder.id) {
    // Querying with another model's vectors returns confident garbage. Fail loudly instead.
    throw new EmbeddingProviderMismatchError(
      scope.containerTag,
      { id: container.embeddingProviderId, dimensions: container.embeddingDimensions ?? 0 },
      { id: deps.embedder.id, dimensions: deps.embedder.dimensions },
    );
  }
  return { enabled: true };
}

/**
 * Lexical and vector search in parallel, fused with RRF. Degrades to whichever retriever
 * is available and says so; never branches on the store's type, only its capabilities.
 */
export async function retrieve<T extends SearchTarget>(
  deps: RetrievalDeps,
  text: string,
  scope: Scope,
  target: T,
  options: RetrievalOptions & { plan?: Awaited<ReturnType<typeof vectorPlan>> },
): Promise<Retrieval<RowByTarget[T]>> {
  const caps = deps.store.capabilities();
  const reader = options.via ?? deps.store;
  const timings: Record<string, number> = {};
  const plan = options.plan ?? (await vectorPlan(deps, scope));
  let degraded = plan.enabled ? undefined : plan.reason;

  let embedding = options.embedding;
  let vectorEnabled = plan.enabled;
  if (vectorEnabled && !embedding) {
    const t0 = performance.now();
    try {
      [embedding] = await deps.embedder!.embed([text]);
    } catch (error) {
      vectorEnabled = false;
      degraded = `lexical-only: query embedding failed (${errorMessage(error)})`;
    }
    timings.embed = round(performance.now() - t0);
  }
  if (!caps.fullText && !vectorEnabled) {
    throw new ConfigurationError(`recall is impossible: the store has no full-text search and ${degraded ?? 'no vector search'}`);
  }

  const timed = async (name: string, run: () => Promise<Scored<RowByTarget[T]>[]>) => {
    const t0 = performance.now();
    const result = await run();
    timings[name] = round(performance.now() - t0);
    return result;
  };
  const [lexical, vector] = await Promise.all([
    caps.fullText ? timed('lexical', () => reader.lexicalSearch(text, scope, { target, k: options.k })) : Promise.resolve(null),
    vectorEnabled
      ? timed('vector', () => reader.vectorSearch(embedding!, scope, { target, k: options.k }))
      : Promise.resolve(null),
  ]);

  const minVectorScore = options.minVectorScore ?? 0;
  const vectorHits = vector?.filter((h) => h.score > minVectorScore).map((h, i) => ({ ...h, rank: i + 1 })) ?? null;

  let hits: FusedHit<RowByTarget[T]>[];
  if (lexical && vectorHits) hits = fuseRrf(lexical, vectorHits);
  else if (lexical) hits = passThrough(lexical, 'lexical');
  else {
    hits = passThrough(vectorHits!, 'vector');
    degraded = 'vector-only';
  }
  return { hits, ...(degraded ? { degraded } : {}), ...(embedding ? { embedding } : {}), timings };
}
