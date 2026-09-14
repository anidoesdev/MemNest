import { scopeOf, type Chunk, type DocumentRef, type LineageGraph, type MemnestApi, type Memory } from '@memnest/core';
import { createSequencer, createStore, errorText, type Observable } from '../store';

export interface SourceDocument {
  document: DocumentRef;
  /** Loaded on request: the document text (redacted; empty once deleted). */
  content: string | null;
  /** Loaded on request: the raw chunks the memory was extracted from. Direct writes have none. */
  chunks: Chunk[] | null;
  loading: boolean;
  error: string | null;
}

export interface DetailState {
  status: 'idle' | 'loading' | 'ready' | 'not-found' | 'error';
  error: string | null;
  memoryId: string | null;
  memory: Memory | null;
  /** The full version history this memory belongs to (UPDATES chain), oldest first. */
  versions: Memory[];
  /** Memories this one enriches, and memories that enrich it. */
  extends: Memory[];
  extendedBy: Memory[];
  sources: SourceDocument[];
  /** Forget is two steps: request, then confirm (D5). */
  forget: 'idle' | 'confirming' | 'forgetting';
  forgetError: string | null;
}

export interface DetailController extends Observable<DetailState> {
  load(memoryId: string): Promise<void>;
  reload(): Promise<void>;
  clear(): void;
  loadSource(documentId: string): Promise<void>;
  requestForget(): void;
  cancelForget(): void;
  confirmForget(): Promise<Memory | null>;
  dispose(): void;
}

/** The UPDATES chain through `rootId`, oldest first. */
export function versionChain(graph: LineageGraph, rootId: string): Memory[] {
  const byId = new Map(graph.memories.map((m) => [m.id, m]));
  const newerOf = new Map<string, Memory>();
  for (const m of graph.memories) if (m.supersedes) newerOf.set(m.supersedes, m);
  const root = byId.get(rootId);
  if (!root) return [];
  const chain = [root];
  const seen = new Set([root.id]);
  for (let older = root.supersedes ? byId.get(root.supersedes) : undefined; older && !seen.has(older.id); older = older.supersedes ? byId.get(older.supersedes) : undefined) {
    chain.unshift(older);
    seen.add(older.id);
  }
  for (let newer = newerOf.get(root.id); newer && !seen.has(newer.id); newer = newerOf.get(newer.id)) {
    chain.push(newer);
    seen.add(newer.id);
  }
  return chain;
}

const EMPTY: DetailState = {
  status: 'idle',
  error: null,
  memoryId: null,
  memory: null,
  versions: [],
  extends: [],
  extendedBy: [],
  sources: [],
  forget: 'idle',
  forgetError: null,
};

export function createDetailController(options: {
  client: MemnestApi;
  containerTag: string;
  /** Called after a memory is forgotten, so other views can refresh. */
  onForgotten?: (memory: Memory) => void;
}): DetailController {
  const { client } = options;
  const scope = scopeOf(options.containerTag);
  const store = createStore<DetailState>(EMPTY);
  const seq = createSequencer();

  const updateSource = (documentId: string, patch: Partial<SourceDocument>) =>
    store.set((s) => ({ sources: s.sources.map((source) => (source.document.id === documentId ? { ...source, ...patch } : source)) }));

  const controller: DetailController = {
    getState: store.getState,
    subscribe: store.subscribe,

    async load(memoryId) {
      const token = seq.next();
      store.set({ ...EMPTY, status: 'loading', memoryId });
      try {
        const [memory, graph] = await Promise.all([client.getMemory(scope, memoryId), client.getLineage(scope, memoryId)]);
        if (!seq.isCurrent(token)) return;
        if (!memory || !graph) {
          store.set({ status: 'not-found' });
          return;
        }
        const byId = new Map(graph.memories.map((m) => [m.id, m]));
        const sourceIds = new Set(graph.edges.filter((e) => e.relation === 'source' && e.from === memoryId).map((e) => e.to));
        store.set({
          status: 'ready',
          memory,
          versions: versionChain(graph, memoryId),
          extends: memory.extendsIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
          extendedBy: graph.memories.filter((m) => m.extendsIds.includes(memoryId)),
          sources: graph.documents
            .filter((d) => sourceIds.has(d.id))
            .map((document) => ({ document, content: null, chunks: null, loading: false, error: null })),
        });
      } catch (error) {
        if (seq.isCurrent(token)) store.set({ status: 'error', error: errorText(error) });
      }
    },

    async reload() {
      const { memoryId } = store.getState();
      if (memoryId) await controller.load(memoryId);
    },

    clear() {
      seq.cancel();
      store.set(EMPTY);
    },

    async loadSource(documentId) {
      // Guarded by the memory id, not the sequencer: loading a source must not cancel the memory load.
      const memoryId = store.getState().memoryId;
      updateSource(documentId, { loading: true, error: null });
      try {
        const found = await client.getDocument(scope, documentId);
        if (store.getState().memoryId !== memoryId) return;
        updateSource(documentId, {
          loading: false,
          content: found?.document.content ?? null,
          chunks: found?.chunks ?? [],
          ...(found ? {} : { error: 'document not found' }),
        });
      } catch (error) {
        if (store.getState().memoryId === memoryId) updateSource(documentId, { loading: false, error: errorText(error) });
      }
    },

    requestForget() {
      const { memory, forget } = store.getState();
      if (!memory || memory.forgottenAt || forget !== 'idle') return;
      store.set({ forget: 'confirming', forgetError: null });
    },

    cancelForget() {
      if (store.getState().forget === 'confirming') store.set({ forget: 'idle' });
    },

    async confirmForget() {
      const { memory, forget } = store.getState();
      if (!memory || forget !== 'confirming') return null;
      store.set({ forget: 'forgetting', forgetError: null });
      try {
        const forgotten = await client.forget(scope, memory.id);
        if (store.getState().memoryId !== memory.id) return forgotten;
        store.set((s) => ({
          forget: 'idle',
          memory: forgotten,
          versions: s.versions.map((v) => (v.id === forgotten.id ? forgotten : v)),
        }));
        options.onForgotten?.(forgotten);
        return forgotten;
      } catch (error) {
        store.set({ forget: 'confirming', forgetError: errorText(error) });
        return null;
      }
    },

    dispose: () => seq.cancel(),
  };
  return controller;
}
