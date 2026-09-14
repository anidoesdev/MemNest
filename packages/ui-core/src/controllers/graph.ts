import { scopeOf, type GraphEdge, type GraphNode, type GraphSnapshot, type LineageEdge, type MemnestApi, type MemoryKind } from '@memnest/core';
import { clusterNodes, type Cluster, type ClusterEdge } from '../cluster';
import { clusterRadius, nodeRadius } from '../encoding';
import { IDENTITY_VIEWPORT, boundsOf, fitViewport, panBy, toWorld, zoomAt, type Point, type Size, type Viewport } from '../geometry';
import { createHitIndex, type HitIndex } from '../hit';
import { inlineLayoutRunner, type LayoutRunner } from '../layout/runner';
import { createSequencer, createStore, errorText, type Observable } from '../store';

export const CLUSTER_THRESHOLD = 2000;
export const GRAPH_LOAD_LIMIT = 10_000;

export interface GraphFilter {
  /** Empty: every kind. */
  kinds: MemoryKind[];
  includeSuperseded: boolean;
  includeForgotten: boolean;
  /** Words that must all appear in the memory (case-insensitive), or an exact memory id. */
  search: string;
}

export interface GraphLineageOverlay {
  rootId: string;
  memoryIds: ReadonlySet<string>;
  edges: LineageEdge[];
}

export interface GraphState {
  containerTag: string;
  status: 'idle' | 'loading' | 'layout' | 'ready' | 'error';
  error: string | null;
  filter: GraphFilter;
  /** Above the cluster threshold the graph shows topic clusters; a filter or search expands them. */
  mode: 'nodes' | 'clusters';
  totalMemories: number;
  /** Nodes fetched (at most the load limit). */
  loaded: number;
  /** True when the container holds more memories than were fetched. */
  truncated: boolean;
  /** Nodes matching the filter, before clustering. */
  matching: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: Cluster[];
  clusterEdges: ClusterEdge[];
  positions: ReadonlyMap<string, Point>;
  selectedId: string | null;
  lineage: GraphLineageOverlay | null;
  viewport: Viewport;
  size: Size;
  layoutMs: number | null;
  /** What the pointer is over, and where (screen coordinates), for tooltips. */
  hover: { pick: NonNullable<GraphPick>; x: number; y: number } | null;
}

export type GraphPick = { type: 'node'; id: string } | { type: 'cluster'; id: string; key: string } | null;

export interface GraphController extends Observable<GraphState> {
  load(): Promise<void>;
  setFilter(filter: Partial<GraphFilter>): void;
  select(memoryId: string | null): void;
  expandLineage(memoryId: string): Promise<void>;
  collapseLineage(): void;
  /** Searches for the cluster's term, which shows its members (or finer clusters). */
  expandCluster(clusterId: string): void;
  setSize(width: number, height: number): void;
  panBy(dx: number, dy: number): void;
  zoomAt(screen: Point, factor: number): void;
  fit(): void;
  /** What is under a screen point. */
  pick(screen: Point): GraphPick;
  /** Tracks the pointer for tooltips; null when it leaves. Updates state only when the target changes. */
  hover(screen: Point | null): void;
  dispose(): void;
}

export interface GraphControllerOptions {
  client: MemnestApi;
  containerTag: string;
  layout?: LayoutRunner;
  clusterThreshold?: number;
  limit?: number;
  filter?: Partial<GraphFilter>;
  /** Called when a node is picked or selected, so other views can follow. */
  onSelect?: (memoryId: string | null) => void;
  /** Default true. */
  autoload?: boolean;
}

export const DEFAULT_GRAPH_FILTER: GraphFilter = { kinds: [], includeSuperseded: true, includeForgotten: false, search: '' };

export function matchesFilter(node: GraphNode, filter: GraphFilter): boolean {
  if (filter.kinds.length > 0 && !filter.kinds.includes(node.kind)) return false;
  if (!node.isLatest && !filter.includeSuperseded) return false;
  if (node.forgotten && !filter.includeForgotten) return false;
  const search = filter.search.trim().toLowerCase();
  if (!search) return true;
  if (node.id === filter.search.trim()) return true;
  const content = node.content.toLowerCase();
  return search.split(/\s+/).every((word) => content.includes(word));
}

export function createGraphController(options: GraphControllerOptions): GraphController {
  const { client } = options;
  const scope = scopeOf(options.containerTag);
  const runner = options.layout ?? inlineLayoutRunner;
  const threshold = options.clusterThreshold ?? CLUSTER_THRESHOLD;
  const limit = options.limit ?? GRAPH_LOAD_LIMIT;
  const store = createStore<GraphState>({
    containerTag: scope.containerTag,
    status: 'idle',
    error: null,
    filter: { ...DEFAULT_GRAPH_FILTER, ...options.filter },
    mode: 'nodes',
    totalMemories: 0,
    loaded: 0,
    truncated: false,
    matching: 0,
    nodes: [],
    edges: [],
    clusters: [],
    clusterEdges: [],
    positions: new Map(),
    selectedId: null,
    lineage: null,
    viewport: IDENTITY_VIEWPORT,
    size: { width: 0, height: 0 },
    layoutMs: null,
    hover: null,
  });
  const loads = createSequencer();
  const layouts = createSequencer();
  let snapshot: GraphSnapshot | null = null;
  let hits: HitIndex = createHitIndex([]);
  let userMoved = false;
  let disposed = false;

  /** Filters, clusters if needed, and lays out. Keeps previous positions as the starting point. */
  async function recompute(): Promise<void> {
    if (!snapshot) return;
    const token = layouts.next();
    const { filter, lineage, positions: previous, mode: previousMode } = store.getState();
    let nodes = snapshot.nodes.filter((n) => matchesFilter(n, filter));
    const matching = nodes.length;
    if (lineage) {
      const present = new Set(nodes.map((n) => n.id));
      nodes = nodes.concat(snapshot.nodes.filter((n) => lineage.memoryIds.has(n.id) && !present.has(n.id)));
    }
    const ids = new Set(nodes.map((n) => n.id));
    const edges = snapshot.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const mode = nodes.length > threshold ? 'clusters' : 'nodes';

    let clusters: Cluster[] = [];
    let clusterEdges: ClusterEdge[] = [];
    let layoutNodes: Array<{ id: string; r: number }>;
    let layoutEdges: Array<{ from: string; to: string }>;
    if (mode === 'clusters') {
      ({ clusters, edges: clusterEdges } = clusterNodes(nodes, edges, { exclude: filter.search ? [filter.search] : [] }));
      layoutNodes = clusters.map((c) => ({ id: c.id, r: clusterRadius(c.count) }));
      layoutEdges = clusterEdges;
    } else {
      layoutNodes = nodes.map((n) => ({ id: n.id, r: nodeRadius(n) }));
      layoutEdges = edges;
    }

    store.set({ status: 'layout', hover: null, matching, mode, nodes: mode === 'nodes' ? nodes : [], edges: mode === 'nodes' ? edges : [], clusters, clusterEdges });
    const started = performance.now();
    let positions: Map<string, { x: number; y: number }>;
    const laidOut = new Set(layoutNodes.map((n) => n.id));
    try {
      positions = await runner.run({
        algorithm: 'force',
        nodes: layoutNodes,
        edges: layoutEdges,
        options: {
          initial: [...previous].filter(([id]) => laidOut.has(id)),
          // Clusters are big circles that must not overlap; a handful of nodes needs room for labels.
          ...(mode === 'clusters'
            ? { linkDistance: 180, charge: -900, collidePadding: 28, collideIterations: 4 }
            : layoutNodes.length <= 40
              ? { linkDistance: 90, charge: -320, collidePadding: 24 }
              : {}),
        },
      });
    } catch (error) {
      if (layouts.isCurrent(token) && !disposed) store.set({ status: 'error', error: errorText(error) });
      return;
    }
    if (!layouts.isCurrent(token) || disposed) return;

    const radius = new Map(layoutNodes.map((n) => [n.id, n.r]));
    const circles = [...positions].map(([id, p]) => ({ id, x: p.x, y: p.y, r: radius.get(id) ?? 6 }));
    hits = createHitIndex(circles);
    const state = store.getState();
    const refit = !userMoved || previousMode !== mode;
    store.set({
      status: 'ready',
      error: null,
      positions,
      layoutMs: Math.round(performance.now() - started),
      ...(refit ? { viewport: fitViewport(boundsOf(circles), state.size) } : {}),
    });
    if (refit) userMoved = false;
  }

  const controller: GraphController = {
    getState: store.getState,
    subscribe: store.subscribe,

    async load() {
      const token = loads.next();
      store.set({ status: 'loading', error: null });
      try {
        const loaded = await client.graph(scope, { limit, includeSuperseded: true, includeForgotten: true });
        if (!loads.isCurrent(token) || disposed) return;
        snapshot = loaded;
        const { selectedId, lineage } = store.getState();
        const present = new Set(loaded.nodes.map((n) => n.id));
        store.set({
          totalMemories: loaded.totalMemories,
          loaded: loaded.nodes.length,
          truncated: loaded.truncated,
          selectedId: selectedId && present.has(selectedId) ? selectedId : null,
          lineage: lineage && present.has(lineage.rootId) ? lineage : null,
        });
        await recompute();
      } catch (error) {
        if (loads.isCurrent(token) && !disposed) store.set({ status: 'error', error: errorText(error) });
      }
    },

    setFilter(patch) {
      store.set((s) => ({ filter: { ...s.filter, ...patch } }));
      void recompute();
    },

    select(memoryId) {
      if (store.getState().selectedId === memoryId) return;
      store.set({ selectedId: memoryId });
      options.onSelect?.(memoryId);
    },

    async expandLineage(memoryId) {
      const token = loads.next();
      try {
        const graph = await client.getLineage(scope, memoryId);
        if (!loads.isCurrent(token) || disposed) return;
        if (!graph) {
          store.set({ lineage: null });
          return;
        }
        store.set({
          lineage: {
            rootId: memoryId,
            memoryIds: new Set(graph.memories.map((m) => m.id)),
            edges: graph.edges.filter((e) => e.relation !== 'source'),
          },
        });
        // Lineage members hidden by the filter or clustering are shown alongside the matches.
        const { mode } = store.getState();
        if (mode === 'clusters') store.set((s) => ({ filter: { ...s.filter, search: memoryId } }));
        await recompute();
      } catch (error) {
        if (loads.isCurrent(token) && !disposed) store.set({ status: 'error', error: errorText(error) });
      }
    },

    collapseLineage() {
      if (!store.getState().lineage) return;
      store.set({ lineage: null });
      void recompute();
    },

    expandCluster(clusterId) {
      const cluster = store.getState().clusters.find((c) => c.id === clusterId);
      if (!cluster || !cluster.key) return;
      const current = store.getState().filter.search.trim();
      controller.setFilter({ search: current ? `${current} ${cluster.key}` : cluster.key });
    },

    setSize(width, height) {
      const { size, viewport } = store.getState();
      if (size.width === width && size.height === height) return;
      const first = size.width === 0 || size.height === 0;
      // Keep the centre where it was when the canvas resizes.
      const next = first ? viewport : panBy(viewport, (width - size.width) / 2, (height - size.height) / 2);
      store.set({ size: { width, height }, viewport: next });
      if (first && !userMoved) controller.fit();
    },

    panBy(dx, dy) {
      userMoved = true;
      store.set((s) => ({ viewport: panBy(s.viewport, dx, dy), hover: null }));
    },

    zoomAt(screen, factor) {
      userMoved = true;
      store.set((s) => ({ viewport: zoomAt(s.viewport, screen, factor), hover: null }));
    },

    fit() {
      const { positions, size, mode, clusters, nodes } = store.getState();
      const radius = new Map<string, number>(
        mode === 'clusters' ? clusters.map((c) => [c.id, clusterRadius(c.count)]) : nodes.map((n) => [n.id, nodeRadius(n)]),
      );
      userMoved = false;
      store.set({ viewport: fitViewport(boundsOf([...positions].map(([id, p]) => ({ ...p, r: radius.get(id) ?? 6 }))), size) });
    },

    pick(screen) {
      const { viewport, mode, clusters } = store.getState();
      // Four screen pixels of slop, whatever the zoom.
      const hit = hits.pick(toWorld(viewport, screen), 4 / viewport.k);
      if (!hit) return null;
      if (mode === 'clusters') {
        const cluster = clusters.find((c) => c.id === hit.id);
        return cluster ? { type: 'cluster', id: cluster.id, key: cluster.key } : null;
      }
      return { type: 'node', id: hit.id };
    },

    hover(screen) {
      const previous = store.getState().hover;
      const pick = screen ? controller.pick(screen) : null;
      if (!pick) {
        if (previous) store.set({ hover: null });
        return;
      }
      // Anchor the tooltip to the target, not the pointer, so it holds still while the pointer moves over it.
      if (previous && previous.pick.id === pick.id) return;
      const { viewport, positions } = store.getState();
      const p = positions.get(pick.id)!;
      store.set({ hover: { pick, x: p.x * viewport.k + viewport.x, y: p.y * viewport.k + viewport.y } });
    },

    dispose() {
      disposed = true;
      loads.cancel();
      layouts.cancel();
    },
  };

  if (options.autoload !== false) void controller.load();
  return controller;
}
