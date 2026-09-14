import { scopeOf, type MemnestApi, type Memory } from '@memnest/core';
import { createSequencer, createStore, errorText, type Observable } from '../store';

export interface FinderState {
  query: string;
  /** Include superseded and forgotten memories. */
  includeHistory: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  items: Memory[];
  /** More pages exist (browsing without a query). */
  hasMore: boolean;
}

export interface FinderController extends Observable<FinderState> {
  setQuery(query: string): void;
  setIncludeHistory(include: boolean): void;
  /** Searches when there is a query; otherwise lists the newest memories. */
  run(): Promise<void>;
  loadMore(): Promise<void>;
  dispose(): void;
}

const PAGE = 50;

/** Finds memories to inspect: by search (with every candidate the trace names), or by browsing newest first. */
export function createFinderController(options: { client: MemnestApi; containerTag: string }): FinderController {
  const { client } = options;
  const scope = scopeOf(options.containerTag);
  const store = createStore<FinderState>({ query: '', includeHistory: false, status: 'idle', error: null, items: [], hasMore: false });
  const seq = createSequencer();
  const visible = (m: Memory, includeHistory: boolean) => includeHistory || (m.isLatest && !m.forgottenAt);

  async function search(query: string, includeHistory: boolean, token: number) {
    const response = await client.search(query, scope, { tokenBudget: 1_000_000, candidates: PAGE });
    const found = new Map(response.memories.map((r) => [r.memory.id, r.memory]));
    const ids = response.trace.candidates.map((c) => c.memoryId);
    const missing = ids.filter((id) => !found.has(id));
    for (const memory of await Promise.all(missing.map((id) => client.getMemory(scope, id)))) if (memory) found.set(memory.id, memory);
    if (!seq.isCurrent(token)) return;
    store.set({ status: 'ready', hasMore: false, items: ids.flatMap((id) => (found.has(id) && visible(found.get(id)!, includeHistory) ? [found.get(id)!] : [])) });
  }

  /** Pages in creation order, oldest first (listMemories' keyset order). */
  async function browse(includeHistory: boolean, token: number, after?: string) {
    const page = await client.listMemories(scope, { limit: PAGE, ...(after ? { after } : {}) }, { latestOnly: !includeHistory, includeForgotten: includeHistory });
    if (!seq.isCurrent(token)) return;
    store.set((s) => ({ status: 'ready', items: after ? [...s.items, ...page] : page, hasMore: page.length === PAGE }));
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    setQuery: (query) => store.set({ query }),
    setIncludeHistory: (includeHistory) => store.set({ includeHistory }),
    async run() {
      const token = seq.next();
      const { query, includeHistory } = store.getState();
      store.set({ status: 'loading', error: null });
      try {
        if (query.trim()) await search(query, includeHistory, token);
        else await browse(includeHistory, token);
      } catch (error) {
        if (seq.isCurrent(token)) store.set({ status: 'error', error: errorText(error) });
      }
    },
    async loadMore() {
      const { items, hasMore, includeHistory, query, status } = store.getState();
      if (!hasMore || query.trim() || status === 'loading' || items.length === 0) return;
      const token = seq.next();
      store.set({ status: 'loading' });
      try {
        await browse(includeHistory, token, items.at(-1)!.id);
      } catch (error) {
        if (seq.isCurrent(token)) store.set({ status: 'error', error: errorText(error) });
      }
    },
    dispose: () => seq.cancel(),
  };
}
