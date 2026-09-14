import { scopeOf, type LineageGraph, type MemnestApi } from '@memnest/core';
import { documentRadius, nodeRadius } from '../encoding';
import { boundsOf, type Bounds, type Point } from '../geometry';
import { layeredLayout } from '../layout/layered';
import { createSequencer, createStore, errorText, type Observable } from '../store';

export interface LineageState {
  status: 'idle' | 'loading' | 'ready' | 'not-found' | 'error';
  error: string | null;
  rootId: string | null;
  graph: LineageGraph | null;
  /** Newer memories on the left, older ones and source documents to the right. */
  positions: ReadonlyMap<string, Point>;
  bounds: Bounds | null;
}

export interface LineageController extends Observable<LineageState> {
  load(memoryId: string): Promise<void>;
  reload(): Promise<void>;
  clear(): void;
  dispose(): void;
}

/** Lays out a lineage graph: memories and their source documents as a layered DAG. */
export function layoutLineage(graph: LineageGraph): { positions: Map<string, Point>; bounds: Bounds | null } {
  const nodes = [
    ...graph.memories.map((m) => ({ id: m.id, r: nodeRadius(m) })),
    ...graph.documents.map((d) => ({ id: d.id, r: documentRadius })),
  ];
  const positions = layeredLayout(nodes, graph.edges, { layerGap: 190, nodeGap: 96 });
  const radius = new Map(nodes.map((n) => [n.id, n.r]));
  return { positions, bounds: boundsOf([...positions].map(([id, p]) => ({ ...p, r: radius.get(id)! + 90 }))) };
}

export function createLineageController(options: { client: MemnestApi; containerTag: string }): LineageController {
  const scope = scopeOf(options.containerTag);
  const store = createStore<LineageState>({ status: 'idle', error: null, rootId: null, graph: null, positions: new Map(), bounds: null });
  const seq = createSequencer();

  const controller: LineageController = {
    getState: store.getState,
    subscribe: store.subscribe,
    async load(memoryId) {
      const token = seq.next();
      store.set({ status: 'loading', error: null, rootId: memoryId });
      try {
        const graph = await options.client.getLineage(scope, memoryId);
        if (!seq.isCurrent(token)) return;
        if (!graph) {
          store.set({ status: 'not-found', graph: null, positions: new Map(), bounds: null });
          return;
        }
        store.set({ status: 'ready', graph, ...layoutLineage(graph) });
      } catch (error) {
        if (seq.isCurrent(token)) store.set({ status: 'error', error: errorText(error) });
      }
    },
    async reload() {
      const { rootId } = store.getState();
      if (rootId) await controller.load(rootId);
    },
    clear() {
      seq.cancel();
      store.set({ status: 'idle', error: null, rootId: null, graph: null, positions: new Map(), bounds: null });
    },
    dispose: () => seq.cancel(),
  };
  return controller;
}
