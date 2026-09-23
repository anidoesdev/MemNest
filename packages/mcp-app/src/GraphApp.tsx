import { MEMORY_KINDS, type GraphNode, type MemnestApi, type MemoryKind } from '@memnest/core';
import { CLUSTER_THRESHOLD, createGraphController, type GraphController, type Store } from '@memnest/ui-core';
import { GraphCanvas, useController } from '@memnest/ui-react';
import type { App, McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { useEffect, useMemo, useRef, useState } from 'react';
import { mcpGraphSource } from './bridge';
import { GRAPH_THEMES, systemTheme } from './theme';

export interface HostState {
  status: 'connecting' | 'ready' | 'error';
  error: string | null;
  context: McpUiHostContext;
  /** The `show_graph` arguments the model chose. */
  input: { search?: string; memoryId?: string };
}

const KIND_LABEL: Record<MemoryKind, string> = { fact: 'Fact', preference: 'Preference', episode: 'Episode' };
const INLINE_HEIGHT = 560;
const formatNumber = (n: number) => n.toLocaleString('en');
const formatDate = (iso: string) => new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(iso));

function nodeStatus(node: GraphNode): string[] {
  const status: string[] = [];
  if (node.forgotten) status.push('Forgotten');
  if (!node.isLatest) status.push('Superseded');
  if (node.validUntil && node.validUntil <= new Date().toISOString()) status.push('Expired');
  return status;
}

export function GraphApp({ app, host }: { app: App; host: Store<HostState> }) {
  const { status, error, context } = useController(host);
  const themeName = context.theme ?? systemTheme();
  useEffect(() => {
    document.documentElement.dataset.theme = themeName;
  }, [themeName]);

  const [containerTag, setContainerTag] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphController | null>(null);
  useEffect(() => {
    if (status !== 'ready') return;
    // The controller reads through the host; it only calls `graph` and `getLineage`.
    const source = mcpGraphSource(app, setContainerTag) as MemnestApi;
    // The server fixes the container; this tag only satisfies the controller's scope.
    const created = createGraphController({ client: source, containerTag: 'mcp:graph' });
    setGraph(created);
    return () => created.dispose();
  }, [app, status]);

  const fullscreen = context.displayMode === 'fullscreen';
  const height = fullscreen ? '100vh' : `${INLINE_HEIGHT}px`;

  return (
    <main className="app" style={{ height }}>
      {status === 'connecting' && <p className="note">Connecting…</p>}
      {status === 'error' && <p className="note error">Could not connect to Claude: {error}</p>}
      {graph && <GraphPanel app={app} host={host} graph={graph} containerTag={containerTag} themeName={themeName} />}
    </main>
  );
}

function GraphPanel({
  app,
  host,
  graph,
  containerTag,
  themeName,
}: {
  app: App;
  host: Store<HostState>;
  graph: GraphController;
  containerTag: string | null;
  themeName: 'light' | 'dark';
}) {
  const { context, input } = useController(host);
  const state = useController(graph);
  const theme = GRAPH_THEMES[themeName];
  const byId = useMemo(() => new Map<string, GraphNode>(state.nodes.map((n) => [n.id, n])), [state.nodes]);
  const { filter } = state;

  // Apply what the model asked for: the search right away, the highlighted memory once the graph has loaded.
  useEffect(() => {
    if (input.search !== undefined) graph.setFilter({ search: input.search });
  }, [graph, input.search]);
  const focused = useRef<string | null>(null);
  useEffect(() => {
    const id = input.memoryId;
    if (!id || focused.current === id || state.status !== 'ready') return;
    focused.current = id;
    graph.select(id);
    void graph.expandLineage(id);
  }, [graph, input.memoryId, state.status]);

  const toggleKind = (kind: MemoryKind) => {
    const active = filter.kinds.length === 0 ? [...MEMORY_KINDS] : filter.kinds;
    const next = active.includes(kind) ? active.filter((k) => k !== kind) : [...active, kind];
    graph.setFilter({ kinds: next.length === MEMORY_KINDS.length ? [] : next });
  };
  const kindActive = (kind: MemoryKind) => filter.kinds.length === 0 || filter.kinds.includes(kind);

  const canFullscreen = context.availableDisplayModes?.includes('fullscreen') ?? false;
  const fullscreen = context.displayMode === 'fullscreen';
  const toggleFullscreen = () => void app.requestDisplayMode({ mode: fullscreen ? 'inline' : 'fullscreen' }).catch(() => {});

  const hovered = state.hover;
  const hoveredNode = hovered?.pick.type === 'node' ? byId.get(hovered.pick.id) : undefined;
  const hoveredCluster = hovered?.pick.type === 'cluster' ? state.clusters.find((c) => c.id === hovered.pick.id) : undefined;
  const selected = state.selectedId ? byId.get(state.selectedId) : undefined;

  const askAbout = (node: GraphNode) =>
    void app
      .sendMessage({ role: 'user', content: [{ type: 'text', text: `Tell me about this memory (${node.id}) and its history: "${node.content}"` }] })
      .catch(() => {});

  return (
    <div className="graph-view">
      <div className="filters" role="toolbar" aria-label="Graph filters">
        <input
          type="search"
          aria-label="Filter the graph"
          placeholder="Filter by words or id"
          value={filter.search}
          onChange={(e) => graph.setFilter({ search: e.target.value })}
        />
        <div className="chips" role="group" aria-label="Kinds">
          {MEMORY_KINDS.map((kind) => (
            <button key={kind} className={`chip ${kindActive(kind) ? 'on' : 'off'}`} aria-pressed={kindActive(kind)} onClick={() => toggleKind(kind)}>
              <span className={`kind-dot kind-${kind}`} aria-hidden="true" />
              {KIND_LABEL[kind]}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={filter.includeSuperseded} onChange={(e) => graph.setFilter({ includeSuperseded: e.target.checked })} />
          Superseded
        </label>
        <label className="check">
          <input type="checkbox" checked={filter.includeForgotten} onChange={(e) => graph.setFilter({ includeForgotten: e.target.checked })} />
          Forgotten
        </label>
        <span className="spacer" />
        {state.lineage && (
          <button className="button" onClick={() => graph.collapseLineage()}>
            Clear history
          </button>
        )}
        <button className="button" onClick={() => graph.fit()}>
          Fit
        </button>
        <button className="button" onClick={() => void graph.load()} title="Load memories added since the graph opened">
          Refresh
        </button>
        {canFullscreen && (
          <button className="button" onClick={toggleFullscreen}>
            {fullscreen ? 'Exit full screen' : 'Full screen'}
          </button>
        )}
      </div>

      <p className="summary" aria-live="polite">
        {state.status === 'loading' || state.status === 'idle'
          ? 'Loading memories…'
          : state.status === 'error'
            ? `Could not load the graph: ${state.error}`
            : (
              <>
                {containerTag && <strong>{containerTag} · </strong>}
                {formatNumber(state.matching)} of {formatNumber(state.totalMemories)} memories
                {state.truncated ? ` (newest ${formatNumber(state.loaded)} loaded)` : ''}
                {state.mode === 'clusters' ? ` · ${state.clusters.length} topics: more than ${formatNumber(CLUSTER_THRESHOLD)} match, click a topic or filter to expand.` : ''}
                {state.status === 'layout' ? ' · laying out…' : ''}
              </>
            )}
      </p>

      <div className="canvas-wrap">
        {state.status === 'ready' && state.totalMemories === 0 ? (
          <p className="note">Nothing is remembered yet. Ask Claude to remember something, then press Refresh.</p>
        ) : (
          <GraphCanvas controller={graph} theme={theme} aria-label={`Memory graph${containerTag ? ` of ${containerTag}` : ''}`} />
        )}
        {hovered && (hoveredNode || hoveredCluster) && (
          <div className="tooltip" style={{ left: hovered.x, top: hovered.y }} role="tooltip">
            {hoveredNode && (
              <>
                <strong>{hoveredNode.content}</strong>
                <span>
                  {KIND_LABEL[hoveredNode.kind]} · reinforced {hoveredNode.reinforcementCount}×{nodeStatus(hoveredNode).map((s) => ` · ${s}`)}
                </span>
              </>
            )}
            {hoveredCluster && (
              <>
                <strong>
                  {formatNumber(hoveredCluster.count)} memories · “{hoveredCluster.label}”
                </strong>
                <span className="muted">{hoveredCluster.key ? 'Click to expand' : 'Filter by words to narrow these down'}</span>
              </>
            )}
          </div>
        )}

        {selected && (
          <aside className="detail" aria-label="Selected memory">
            <div className="detail-head">
              <span className={`kind-dot kind-${selected.kind}`} aria-hidden="true" />
              <span>{KIND_LABEL[selected.kind]}</span>
              {nodeStatus(selected).map((s) => (
                <span key={s} className="tag">
                  {s}
                </span>
              ))}
              <span className="spacer" />
              <button className="close" aria-label="Close" onClick={() => graph.select(null)}>
                ×
              </button>
            </div>
            <p className="detail-content">{selected.content}</p>
            <p className="muted">
              Since {formatDate(selected.validFrom)}
              {selected.validUntil ? ` · until ${formatDate(selected.validUntil)}` : ''} · reinforced {selected.reinforcementCount}×
            </p>
            <div className="detail-actions">
              <button className="button" onClick={() => void graph.expandLineage(selected.id)}>
                Show history
              </button>
              <button className="button" onClick={() => askAbout(selected)}>
                Ask Claude
              </button>
            </div>
          </aside>
        )}

        <div className="legend" aria-label="Legend">
          {state.mode === 'clusters' ? (
            <span>Each glowing region is a topic, sized by its memories.</span>
          ) : (
            <>
              {MEMORY_KINDS.map((kind) => (
                <span key={kind} className="legend-item">
                  <span className={`kind-dot kind-${kind}`} aria-hidden="true" />
                  {KIND_LABEL[kind]}
                </span>
              ))}
              <span className="legend-item">→ updates</span>
              <span className="legend-item">⋯ extends</span>
              <span className="legend-item muted">Brighter: reinforced · Faded: superseded</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
