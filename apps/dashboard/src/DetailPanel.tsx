import type { Memory } from '@memnest/core';
import type { Workspace } from '@memnest/ui-core';
import { useController } from '@memnest/ui-react';
import { useEffect, useRef } from 'react';
import { ErrorNote, KindBadge, KindDot, StatusTags } from './components';
import { formatDate, formatDateTime, memoryStatus } from './format';

interface DetailPanelProps {
  workspace: Workspace;
  onShowLineage: () => void;
  onShowInGraph: () => void;
}

export function DetailPanel({ workspace, onShowLineage, onShowInGraph }: DetailPanelProps) {
  const { detail } = workspace;
  const state = useController(detail);
  const { memory } = state;
  const confirmButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (state.forget === 'confirming') confirmButton.current?.focus();
  }, [state.forget]);

  return (
    <aside className="detail" aria-label="Memory detail">
      <div className="detail-head">
        <h2>Memory</h2>
        <button className="button ghost small" onClick={() => workspace.select(null)} aria-label="Close detail">
          Close
        </button>
      </div>
      {state.status === 'loading' && <p className="muted pad">Loading…</p>}
      {state.status === 'not-found' && <p className="muted pad">This memory no longer exists in the container.</p>}
      <ErrorNote message={state.error} />
      {memory && (
        <div className="detail-body">
          {memory.forgottenAt && (
            <p className="banner" role="status">
              Forgotten {formatDateTime(memory.forgottenAt)}. It is no longer recalled, and stays in the history.
            </p>
          )}
          <p className="detail-content">{memory.content}</p>
          <div className="detail-tags">
            <KindBadge kind={memory.kind} />
            <StatusTags status={memoryStatus(memory)} />
          </div>

          <dl className="facts">
            <dt>Confidence</dt>
            <dd>{Math.round(memory.confidence * 100)}%</dd>
            <dt>Valid</dt>
            <dd>
              {formatDate(memory.validFrom)} → {memory.validUntil ? formatDate(memory.validUntil) : 'no expiry'}
            </dd>
            <dt>Version</dt>
            <dd>
              {memory.version}
              {state.versions.length > 1 ? ` of ${state.versions.length}` : ''}
            </dd>
            <dt>Reinforced</dt>
            <dd>
              {memory.reinforcementCount} {memory.reinforcementCount === 1 ? 'time' : 'times'}
            </dd>
            <dt>Stored</dt>
            <dd>{formatDateTime(memory.createdAt)}</dd>
            <dt>Id</dt>
            <dd>
              <code>{memory.id}</code>
            </dd>
          </dl>

          <div className="actions">
            <button className="button small" onClick={onShowLineage}>
              Lineage
            </button>
            <button
              className="button small"
              onClick={() => {
                void workspace.graph.expandLineage(memory.id);
                onShowInGraph();
              }}
            >
              Show in graph
            </button>
          </div>

          {state.versions.length > 1 && (
            <section className="detail-section">
              <h3>Version history</h3>
              <ol className="versions">
                {state.versions.map((version) => (
                  <MemoryLink key={version.id} memory={version} workspace={workspace} current={version.id === memory.id} prefix={`v${version.version}`} />
                ))}
              </ol>
            </section>
          )}

          {(state.extends.length > 0 || state.extendedBy.length > 0) && (
            <section className="detail-section">
              <h3>Related</h3>
              <ul className="versions">
                {state.extends.map((m) => (
                  <MemoryLink key={m.id} memory={m} workspace={workspace} prefix="Extends" />
                ))}
                {state.extendedBy.map((m) => (
                  <MemoryLink key={m.id} memory={m} workspace={workspace} prefix="Extended by" />
                ))}
              </ul>
            </section>
          )}

          <section className="detail-section">
            <h3>Sources</h3>
            {state.sources.length === 0 && <p className="muted">No source documents recorded.</p>}
            <ul className="sources">
              {state.sources.map((source) => (
                <li key={source.document.id}>
                  <div className="source-head">
                    <span>
                      {source.document.kind === 'direct' ? 'Direct write' : source.document.kind}
                      {source.document.customId ? ` · ${source.document.customId}` : ''} · {formatDate(source.document.documentDate ?? source.document.createdAt)}
                      {source.document.deletedAt ? ' · deleted' : ''}
                    </span>
                    {source.content === null && source.chunks === null && (
                      <button className="button ghost small" onClick={() => void detail.loadSource(source.document.id)} disabled={source.loading}>
                        {source.loading ? 'Loading…' : 'Show text'}
                      </button>
                    )}
                  </div>
                  <ErrorNote message={source.error} />
                  {source.chunks && source.chunks.length > 0 ? (
                    <ol className="chunks">
                      {source.chunks.map((chunk) => (
                        <li key={chunk.id}>
                          <span className="muted small">Chunk {chunk.index + 1}</span>
                          <pre>{chunk.content}</pre>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    source.content !== null && <pre className="source-text">{source.content || '(content erased)'}</pre>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {!memory.forgottenAt && (
            <section className="detail-section forget">
              {state.forget === 'idle' && (
                <button className="button danger" onClick={() => detail.requestForget()}>
                  Forget…
                </button>
              )}
              {state.forget !== 'idle' && (
                <div className="confirm" role="alertdialog" aria-labelledby="forget-title" aria-describedby="forget-body">
                  <p id="forget-title" className="confirm-title">
                    Forget this memory?
                  </p>
                  <p id="forget-body" className="muted">
                    It will no longer be returned by search or stated in profiles. It is not rewritten or deleted: it stays in the history, marked forgotten.
                  </p>
                  <ErrorNote message={state.forgetError} />
                  <div className="actions">
                    <button className="button" onClick={() => detail.cancelForget()} disabled={state.forget === 'forgetting'}>
                      Cancel
                    </button>
                    <button ref={confirmButton} className="button danger" onClick={() => void detail.confirmForget()} disabled={state.forget === 'forgetting'}>
                      {state.forget === 'forgetting' ? 'Forgetting…' : 'Forget memory'}
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </aside>
  );
}

function MemoryLink({ memory, workspace, current = false, prefix }: { memory: Memory; workspace: Workspace; current?: boolean; prefix: string }) {
  return (
    <li>
      <button className={`memory-link ${current ? 'current' : ''}`} onClick={() => workspace.select(memory.id)} disabled={current} aria-current={current}>
        <span className="muted small">{prefix}</span>
        <KindDot kind={memory.kind} />
        <span className="memory-link-text">{memory.content}</span>
        <StatusTags status={memoryStatus(memory)} />
      </button>
    </li>
  );
}
