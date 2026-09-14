import type { DocumentRef, Memory } from '@memnest/core';
import { documentRadius, nodeRadius, shorten, type Workspace } from '@memnest/ui-core';
import { useController } from '@memnest/ui-react';
import { EmptyState, ErrorNote } from '../components';
import { KIND_LABEL, formatDate, memoryStatus } from '../format';

const PAD = 110;

/** One memory, what it superseded, what extends it, and which documents produced it: a small layered DAG. */
export function LineageView({ workspace }: { workspace: Workspace }) {
  const state = useController(workspace.lineage);
  const { memoryId } = useController(workspace.selection);

  if (!memoryId) {
    return (
      <EmptyState title="Select a memory to see its lineage">
        Pick one from the list, the graph or the trace. Lineage shows what it replaced, what enriches it, and the documents it came from.
      </EmptyState>
    );
  }
  if (state.status === 'loading' && !state.graph) return <p className="muted pad">Loading lineage…</p>;
  if (state.status === 'not-found') return <EmptyState title="This memory no longer exists" />;
  if (!state.graph || !state.bounds) return <ErrorNote message={state.error} />;

  const { graph, positions, bounds } = state;
  const memories = new Map(graph.memories.map((m) => [m.id, m]));
  const documents = new Map(graph.documents.map((d) => [d.id, d]));
  const minX = bounds.minX - PAD / 2;
  const minY = bounds.minY - 30;
  const width = bounds.maxX - bounds.minX + PAD;
  const height = bounds.maxY - bounds.minY + 60;

  return (
    <div className={`lineage-view ${state.status === 'loading' ? 'refreshing' : ''}`}>
      <p className="summary">
        {graph.memories.length} {graph.memories.length === 1 ? 'memory' : 'memories'} from {graph.documents.length}{' '}
        {graph.documents.length === 1 ? 'document' : 'documents'}. Newer on the left; sources on the right.
      </p>
      <div className="lineage-scroll">
        <svg
          className="lineage"
          viewBox={`${minX} ${minY} ${width} ${height}`}
          style={{ width: '100%', maxWidth: Math.max(width, 320), height: 'auto' }}
          role="img"
          aria-label="Lineage graph"
        >
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M0 0 L8 4 L0 8 Z" className="edge-updates-head" />
            </marker>
          </defs>
          {graph.edges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            const r = edge.relation === 'source' ? documentRadius : nodeRadius(memories.get(edge.to) ?? { reinforcementCount: 1 });
            const angle = Math.atan2(to.y - from.y, to.x - from.x);
            return (
              <line
                key={`${edge.from}-${edge.to}-${edge.relation}`}
                x1={from.x}
                y1={from.y}
                x2={to.x - Math.cos(angle) * (r + 3)}
                y2={to.y - Math.sin(angle) * (r + 3)}
                className={`edge-${edge.relation}`}
                {...(edge.relation === 'updates' ? { markerEnd: 'url(#arrow)' } : {})}
              >
                <title>{edge.relation === 'source' ? 'extracted from' : edge.relation}</title>
              </line>
            );
          })}
          {[...positions].map(([id, p]) => {
            const memory = memories.get(id);
            if (memory) return <MemoryNode key={id} memory={memory} x={p.x} y={p.y} root={id === graph.rootId} onSelect={() => workspace.select(id)} />;
            const document = documents.get(id);
            return document ? <DocumentNode key={id} document={document} x={p.x} y={p.y} /> : null;
          })}
        </svg>
      </div>
      <div className="legend">
        <span className="legend-item">
          <svg width="26" height="8" aria-hidden="true">
            <line x1="1" y1="4" x2="19" y2="4" className="edge-updates" />
            <path d="M19 1 L25 4 L19 7 Z" className="edge-updates-head" />
          </svg>
          updates (replaces)
        </span>
        <span className="legend-item">
          <svg width="26" height="8" aria-hidden="true">
            <line x1="1" y1="4" x2="25" y2="4" className="edge-extends" />
          </svg>
          extends (enriches)
        </span>
        <span className="legend-item">
          <svg width="26" height="8" aria-hidden="true">
            <line x1="1" y1="4" x2="25" y2="4" className="edge-source" />
          </svg>
          extracted from
        </span>
        <span className="legend-item muted">Faded: superseded · Hollow: forgotten</span>
      </div>
    </div>
  );
}

function MemoryNode({ memory, x, y, root, onSelect }: { memory: Memory; x: number; y: number; root: boolean; onSelect: () => void }) {
  const r = nodeRadius(memory);
  const status = memoryStatus(memory);
  const label = `${KIND_LABEL[memory.kind]}: ${memory.content}${status.length ? ` (${status.join(', ')})` : ''}`;
  return (
    <g
      className={`lineage-node ${root ? 'root' : ''} ${memory.isLatest ? '' : 'superseded'} ${memory.forgottenAt ? 'forgotten' : ''}`}
      transform={`translate(${x} ${y})`}
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect())}
    >
      <title>{label}</title>
      <circle r={r + 10} className="hit" />
      {root && <circle r={r + 4} className="root-ring" />}
      <circle r={r} className={`kind-fill kind-${memory.kind}`} />
      <text y={r + 16} className="node-label">
        {shorten(memory.content, 34)}
      </text>
      <text y={r + 30} className="node-meta">
        v{memory.version} · {formatDate(memory.validFrom)}
        {status.length ? ` · ${status.join(', ').toLowerCase()}` : ''}
      </text>
    </g>
  );
}

function DocumentNode({ document, x, y }: { document: DocumentRef; x: number; y: number }) {
  const label = `${document.kind === 'direct' ? 'Direct write' : `Document (${document.kind})`}${document.customId ? ` ${document.customId}` : ''}, ${formatDate(document.documentDate ?? document.createdAt)}`;
  return (
    <g className={`document-node ${document.deletedAt ? 'deleted' : ''}`} transform={`translate(${x} ${y})`}>
      <title>{label}</title>
      <rect x={-documentRadius} y={-documentRadius} width={documentRadius * 2} height={documentRadius * 2} rx="2" />
      <text y={documentRadius + 16} className="node-label">
        {document.customId ? shorten(document.customId, 24) : document.kind === 'direct' ? 'direct write' : document.kind}
      </text>
      <text y={documentRadius + 30} className="node-meta">
        {formatDate(document.documentDate ?? document.createdAt)}
        {document.deletedAt ? ' · deleted' : ''}
      </text>
    </g>
  );
}
