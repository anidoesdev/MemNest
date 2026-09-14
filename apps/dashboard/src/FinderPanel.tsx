import type { Workspace } from '@memnest/ui-core';
import { useController } from '@memnest/ui-react';
import { useEffect, useRef } from 'react';
import { ErrorNote, KindDot, StatusTags } from './components';
import { formatDate, memoryStatus } from './format';

/** Find memories to inspect: search by words, or browse. The list is also the table view of what is stored. */
export function FinderPanel({ workspace }: { workspace: Workspace }) {
  const { finder } = workspace;
  const state = useController(finder);
  const { memoryId } = useController(workspace.selection);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(debounce.current), []);

  const search = (query: string) => {
    finder.setQuery(query);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void finder.run(), 250);
  };

  return (
    <aside className="finder" aria-label="Memories">
      <form
        className="finder-form"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          clearTimeout(debounce.current);
          void finder.run();
        }}
      >
        <input type="search" aria-label="Search memories" placeholder="Search memories" value={state.query} onChange={(e) => search(e.target.value)} />
        <label className="check">
          <input
            type="checkbox"
            checked={state.includeHistory}
            onChange={(e) => {
              finder.setIncludeHistory(e.target.checked);
              void finder.run();
            }}
          />
          Include superseded and forgotten
        </label>
      </form>
      <ErrorNote message={state.error} />
      <ul className={`finder-list ${state.status === 'loading' ? 'refreshing' : ''}`} aria-busy={state.status === 'loading'}>
        {state.items.map((memory) => (
          <li key={memory.id}>
            <button className={`finder-item ${memory.id === memoryId ? 'selected' : ''}`} onClick={() => workspace.select(memory.id)} aria-current={memory.id === memoryId}>
              <KindDot kind={memory.kind} />
              <span className="finder-text">
                <span className="finder-content">{memory.content}</span>
                <span className="finder-meta">
                  {formatDate(memory.validFrom)}
                  <StatusTags status={memoryStatus(memory)} />
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {state.status === 'ready' && state.items.length === 0 && <p className="muted pad">{state.query ? 'No memories match.' : 'No memories yet.'}</p>}
      {state.hasMore && (
        <button className="button ghost small pad" onClick={() => void finder.loadMore()} disabled={state.status === 'loading'}>
          Load more
        </button>
      )}
    </aside>
  );
}
