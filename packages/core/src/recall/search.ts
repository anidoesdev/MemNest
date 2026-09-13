import { ConfigurationError, ValidationError, errorMessage } from '../errors';
import type { Clock, CompletionProvider, EmbeddingProvider, MemoryStore, TokenCounter } from '../ports';
import type {
  ChunkResult,
  MemoryResult,
  RecallTrace,
  Scope,
  SearchOptions,
  SearchResponse,
  TraceCandidate,
} from '../types';
import { exclusionReason } from './filter';
import { packByBudget } from './pack';
import { rerank } from './rerank';
import { retrieve, vectorPlan } from './retrieve';

export const DEFAULT_TOKEN_BUDGET = 2000;
export const DEFAULT_CANDIDATES = 50;
export const DEFAULT_RERANK_TOP_N = 20;
export const DEFAULT_RERANK_MIN_SCORE = 0.2;

export interface RecallDeps {
  store: MemoryStore;
  tokenCounter: TokenCounter;
  clock: Clock;
  embedder?: EmbeddingProvider | undefined;
  completion?: CompletionProvider | undefined;
}

export interface RecallTargets {
  memories: boolean;
  chunks: boolean;
}

const round = (ms: number) => Math.round(ms * 100) / 100;

function validateOptions(query: string, opts: SearchOptions, deps: RecallDeps) {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new ValidationError('query must be a non-empty string');
  }
  const budget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const k = opts.candidates ?? DEFAULT_CANDIDATES;
  if (!Number.isInteger(budget) || budget < 0) throw new ValidationError('tokenBudget must be a non-negative integer');
  if (!Number.isInteger(k) || k < 1 || k > 1000) throw new ValidationError('candidates must be an integer in 1..1000');
  const minVectorScore = opts.minVectorScore ?? 0;
  if (typeof minVectorScore !== 'number' || minVectorScore < -1 || minVectorScore > 1) {
    throw new ValidationError('minVectorScore must be within -1..1');
  }
  let rerankConfig: { topN: number; minScore: number } | undefined;
  if (opts.rerank) {
    if (!deps.completion) throw new ConfigurationError('rerank needs a completion provider: pass `completion` to createMemnest');
    const custom = typeof opts.rerank === 'object' ? opts.rerank : {};
    rerankConfig = { topN: custom.topN ?? DEFAULT_RERANK_TOP_N, minScore: custom.minScore ?? DEFAULT_RERANK_MIN_SCORE };
    if (!Number.isInteger(rerankConfig.topN) || rerankConfig.topN < 1 || rerankConfig.topN > 100) {
      throw new ValidationError('rerank.topN must be an integer in 1..100');
    }
  }
  return { budget, k, minVectorScore, rerankConfig };
}

/**
 * query → { lexical, vector } in parallel → RRF → filter (latest, remembered, unexpired)
 * → optional rerank → budget-aware pack → results + trace.
 * Memories are packed first; chunks get whatever budget remains.
 */
export async function recall(
  deps: RecallDeps,
  query: string,
  scope: Scope,
  opts: SearchOptions,
  targets: RecallTargets,
): Promise<SearchResponse> {
  const started = performance.now();
  const { budget, k, minVectorScore, rerankConfig } = validateOptions(query, opts, deps);
  const timings: Record<string, number> = {};
  const plan = await vectorPlan(deps, scope);
  const now = deps.clock.now();
  const notes: string[] = [];
  let embedding: Float32Array | undefined;

  const trace: RecallTrace = { query, candidates: [], budget: { limit: budget, used: 0 }, timings };
  const memories: MemoryResult[] = [];

  if (targets.memories) {
    const retrieved = await retrieve(deps, query, scope, 'memories', { k, plan, minVectorScore });
    embedding = retrieved.embedding;
    if (retrieved.degraded) notes.push(retrieved.degraded);
    for (const [name, ms] of Object.entries(retrieved.timings)) timings[name === 'embed' ? name : `${name}Memories`] = ms;

    const t1 = performance.now();
    let entries = retrieved.hits.map((hit) => {
      const reason = exclusionReason(hit.row, now);
      const candidate: TraceCandidate = {
        memoryId: hit.row.id,
        ...(hit.lexicalRank !== undefined ? { lexicalRank: hit.lexicalRank, lexicalScore: hit.lexicalScore! } : {}),
        ...(hit.vectorRank !== undefined ? { vectorRank: hit.vectorRank, vectorScore: hit.vectorScore! } : {}),
        rrfScore: hit.rrfScore,
        included: false,
        ...(reason ? { excludedReason: reason } : {}),
        tokens: deps.tokenCounter.count(hit.row.content),
      };
      return { candidate, memory: hit.row };
    });

    if (rerankConfig) {
      const t2 = performance.now();
      const top = entries.filter((e) => !e.candidate.excludedReason).slice(0, rerankConfig.topN);
      let scores: Awaited<ReturnType<typeof rerank>> = null;
      try {
        scores = await rerank(deps.completion!, query, top.map((e) => e.memory));
      } catch (error) {
        notes.push(`rerank failed (${errorMessage(error)}); fused order kept`);
      }
      if (scores === null && top.length > 0 && !notes.some((n) => n.startsWith('rerank failed'))) {
        notes.push('rerank failed (unusable output); fused order kept');
      }
      if (scores) {
        top.forEach((e, i) => {
          const score = scores![i];
          if (score === undefined) return;
          e.candidate.rerankScore = score;
          if (score < rerankConfig.minScore) e.candidate.excludedReason = 'rerank';
        });
        // Reranked candidates first, by rerank score; everything else keeps its fused position after them.
        const reranked = new Set(top);
        const ordered = [...top].sort((a, z) => (z.candidate.rerankScore ?? -1) - (a.candidate.rerankScore ?? -1));
        entries = [...ordered, ...entries.filter((e) => !reranked.has(e))];
      }
      timings.rerank = round(performance.now() - t2);
    }

    const eligible = entries.filter((e) => !e.candidate.excludedReason);
    const packed = packByBudget(eligible.map((e) => e.candidate), budget);
    eligible.forEach((e, i) => {
      if (packed.included.has(i)) {
        e.candidate.included = true;
        memories.push({ memory: e.memory, score: e.candidate.rerankScore ?? e.candidate.rrfScore, tokens: e.candidate.tokens });
      } else {
        e.candidate.excludedReason = 'budget';
      }
    });
    trace.candidates = entries.map((e) => e.candidate);
    trace.budget.used = packed.used;
    timings.filterAndPack = round(performance.now() - t1 - (timings.rerank ?? 0));
  }

  const chunks: ChunkResult[] = [];
  if (targets.chunks) {
    const retrieved = await retrieve(deps, query, scope, 'chunks', { k, plan, minVectorScore, ...(embedding ? { embedding } : {}) });
    if (retrieved.degraded && !notes.includes(retrieved.degraded)) notes.push(retrieved.degraded);
    for (const [name, ms] of Object.entries(retrieved.timings)) timings[name === 'embed' ? name : `${name}Chunks`] = ms;
    const sized = retrieved.hits.map((hit) => ({ hit, tokens: deps.tokenCounter.count(hit.row.content) }));
    const packed = packByBudget(sized, budget, trace.budget.used);
    sized.forEach(({ hit, tokens }, i) => {
      if (packed.included.has(i)) chunks.push({ chunk: hit.row, score: hit.rrfScore, tokens });
    });
    trace.budget.used = packed.used;
  }

  if (notes.length > 0) trace.degraded = notes.join('; ');
  timings.total = round(performance.now() - started);
  return { memories, chunks, trace };
}
