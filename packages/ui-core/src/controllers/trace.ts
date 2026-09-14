import { scopeOf, type ExcludedReason, type MemnestApi, type Memory, type MemoryKind, type SearchResponse } from '@memnest/core';
import { createSequencer, createStore, errorText, type Observable } from '../store';

export interface TraceRow {
  memoryId: string;
  /** Null when the memory could not be loaded (e.g. deleted since). */
  content: string | null;
  kind: MemoryKind | null;
  lexicalRank?: number;
  lexicalScore?: number;
  vectorRank?: number;
  vectorScore?: number;
  rrfScore: number;
  rerankScore?: number;
  included: boolean;
  excludedReason?: ExcludedReason;
  tokens: number;
  /** Tokens used by included memories up to and including this row. */
  cumulativeTokens: number;
}

export interface TraceState {
  query: string;
  tokenBudget: number;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  response: SearchResponse | null;
  /** Every candidate from either retriever, in packing order. */
  rows: TraceRow[];
  /** Index of the first row the budget excluded: the budget line is drawn above it. Null when nothing was cut. */
  budgetLine: number | null;
  /** Budget spent on chunks, which share what memories leave. */
  chunkTokens: number;
}

export interface TraceController extends Observable<TraceState> {
  setQuery(query: string): void;
  setTokenBudget(tokens: number): void;
  run(): Promise<void>;
  /** Runs the last query again, e.g. after a forget. No-op before the first run. */
  rerun(): Promise<void>;
  dispose(): void;
}

export const DEFAULT_TRACE_BUDGET = 2000;

/** Joins the trace with memory content and computes the budget line. Pure. */
export function buildTraceRows(response: SearchResponse, memories: ReadonlyMap<string, Memory>): { rows: TraceRow[]; budgetLine: number | null } {
  let used = 0;
  let budgetLine: number | null = null;
  const rows = response.trace.candidates.map((candidate, index) => {
    if (candidate.included) used += candidate.tokens;
    if (budgetLine === null && candidate.excludedReason === 'budget') budgetLine = index;
    const memory = memories.get(candidate.memoryId);
    return { ...candidate, content: memory?.content ?? null, kind: memory?.kind ?? null, cumulativeTokens: used };
  });
  return { rows, budgetLine };
}

export function createTraceController(options: { client: MemnestApi; containerTag: string; tokenBudget?: number }): TraceController {
  const { client } = options;
  const scope = scopeOf(options.containerTag);
  const store = createStore<TraceState>({
    query: '',
    tokenBudget: options.tokenBudget ?? DEFAULT_TRACE_BUDGET,
    status: 'idle',
    error: null,
    response: null,
    rows: [],
    budgetLine: null,
    chunkTokens: 0,
  });
  const seq = createSequencer();
  let lastRun: { query: string; tokenBudget: number } | null = null;

  async function execute(query: string, tokenBudget: number): Promise<void> {
    const token = seq.next();
    lastRun = { query, tokenBudget };
    store.set({ status: 'loading', error: null });
    try {
      const response = await client.search(query, scope, { tokenBudget });
      // Excluded candidates are not in the results; fetch them so every row has its text.
      const memories = new Map(response.memories.map((r) => [r.memory.id, r.memory]));
      const missing = response.trace.candidates.map((c) => c.memoryId).filter((id) => !memories.has(id));
      const fetched = await Promise.all(missing.map((id) => client.getMemory(scope, id)));
      if (!seq.isCurrent(token)) return;
      for (const memory of fetched) if (memory) memories.set(memory.id, memory);
      store.set({
        status: 'ready',
        response,
        ...buildTraceRows(response, memories),
        chunkTokens: response.chunks.reduce((sum, c) => sum + c.tokens, 0),
      });
    } catch (error) {
      if (seq.isCurrent(token)) store.set({ status: 'error', error: errorText(error) });
    }
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    setQuery: (query) => store.set({ query }),
    setTokenBudget: (tokenBudget) => store.set({ tokenBudget }),
    async run() {
      const { query, tokenBudget } = store.getState();
      if (!query.trim()) return;
      await execute(query, tokenBudget);
    },
    async rerun() {
      if (lastRun) await execute(lastRun.query, lastRun.tokenBudget);
    },
    dispose: () => seq.cancel(),
  };
}
