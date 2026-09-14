import { MEMORY_KINDS, type GraphNode, type MemoryKind } from '@memnest/core';
import { CLUSTER_THRESHOLD, type Workspace } from '@memnest/ui-core';
import { GraphCanvas, useController } from '@memnest/ui-react';
import { useMemo } from 'react';
import { ErrorNote, KindDot } from '../components';
import { KIND_LABEL, formatNumber, memoryStatus } from '../format';
import { useGraphTheme } from '../theme';

export function GraphView({ workspace }: { workspace: Workspace }) {
  const { graph } = workspace;
  const state = useController(graph);
  const theme = useGraphTheme();
  const byId = useMemo(() => new Map<string, GraphNode>(state.nodes.map((n) => [n.id, n])), [state.nodes]);
  const { filter } = state;

  const toggleKind = (kind: MemoryKind) => {
    const active = filter.kinds.length === 0 ? [...MEMORY_KINDS] : filter.kinds;
    const next = active.includes(kind) ? active.filter((k) => k !== kind) : [...active, kind];
    graph.setFilter({ kinds: next.length === MEMORY_KINDS.length ? [] : next });
  };
  const kindActive = (kind: MemoryKind) => filter.kinds.length === 0 || filter.kinds.includes(kind);

  const hovered = state.hover;
  const hoveredNode = hovered?.pick.type === 'node' ? byId.get(hovered.pick.id) : undefined;
  const hoveredCluster = hovered?.pick.type === 'cluster' ? state.clusters.find((c) => c.id === hovered.pick.id) : undefined;

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
              <KindDot kind={kind} decorative />
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
          <button className="button ghost small" onClick={() => graph.collapseLineage()}>
            Clear lineage
          </button>
        )}
        {(filter.search || filter.kinds.length > 0) && (
          <button className="button ghost small" onClick={() => graph.setFilter({ search: '', kinds: [] })}>
            Reset
          </button>
        )}
        <button className="button ghost small" onClick={() => graph.fit()}>
          Fit
        </button>
      </div>

      <p className="summary" aria-live="polite">
        {state.status === 'loading' && 'Loading memories…'}
        {state.status !== 'loading' && (
          <>
            {formatNumber(state.matching)} of {formatNumber(state.totalMemories)} memories
            {state.truncated ? ` (newest ${formatNumber(state.loaded)} loaded)` : ''}
            {state.mode === 'clusters'
              ? ` · ${state.clusters.length} topics. More than ${formatNumber(CLUSTER_THRESHOLD)} match, so memories are grouped: click a topic or filter to expand.`
              : ''}
            {state.status === 'layout' ? ' · laying out…' : ''}
          </>
        )}
      </p>
      <ErrorNote message={state.error} />

      <div className={`canvas-wrap ${state.status === 'layout' || state.status === 'loading' ? 'refreshing' : ''}`}>
        <GraphCanvas controller={graph} theme={theme} aria-label={`Memory graph of ${state.containerTag}`} />
        {hovered && (hoveredNode || hoveredCluster) && (
          <div className="tooltip" style={{ left: hovered.x, top: hovered.y }} role="tooltip">
            {hoveredNode && (
              <>
                <strong>{hoveredNode.content}</strong>
                <span>
                  {KIND_LABEL[hoveredNode.kind]} · reinforced {hoveredNode.reinforcementCount}×
                  {memoryStatus({ isLatest: hoveredNode.isLatest, forgottenAt: hoveredNode.forgotten ? 'yes' : undefined, validUntil: hoveredNode.validUntil }).map((s) => ` · ${s}`)}
                </span>
              </>
            )}
            {hoveredCluster && (
              <>
                <strong>
                  {formatNumber(hoveredCluster.count)} memories · “{hoveredCluster.label}”
                </strong>
                <span>
                  {MEMORY_KINDS.filter((k) => hoveredCluster.kinds[k] > 0)
                    .map((k) => `${formatNumber(hoveredCluster.kinds[k])} ${KIND_LABEL[k].toLowerCase()}`)
                    .join(' · ')}
                </span>
                <span className="muted">{hoveredCluster.key ? 'Click to expand' : 'Filter by words to narrow these down'}</span>
              </>
            )}
          </div>
        )}
        <div className="legend" aria-label="Legend">
          {state.mode === 'clusters' ? (
            <span>Each glowing region is a topic, sized by its memories. Lines: updates and extends between topics.</span>
          ) : (
            <>
              {MEMORY_KINDS.map((kind) => (
                <span key={kind} className="legend-item">
                  <KindDot kind={kind} decorative />
                  {KIND_LABEL[kind]}
                </span>
              ))}
              <span className="legend-item">
                <svg width="26" height="8" aria-hidden="true">
                  <line x1="1" y1="4" x2="19" y2="4" className="edge-updates" />
                  <path d="M19 1 L25 4 L19 7 Z" className="edge-updates-head" />
                </svg>
                updates
              </span>
              <span className="legend-item">
                <svg width="26" height="8" aria-hidden="true">
                  <line x1="2" y1="4" x2="24" y2="4" className="edge-extends" />
                </svg>
                extends
              </span>
              <span className="legend-item muted">Bigger and brighter: reinforced · Faded: superseded · Dark ring: forgotten</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
