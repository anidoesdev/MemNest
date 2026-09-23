import type { Workspace } from '@memnest/ui-core';
import { useController } from '@memnest/ui-react';
import { useEffect } from 'react';
import { DetailPanel } from './DetailPanel';
import { FinderPanel } from './FinderPanel';
import { GraphView } from './views/GraphView';
import { LineageView } from './views/LineageView';
import { TimelineView } from './views/TimelineView';
import { TraceView } from './views/TraceView';

export const TABS = [
  { id: 'graph', label: 'Graph' },
  { id: 'lineage', label: 'Lineage' },
  { id: 'trace', label: 'Retrieval trace' },
  { id: 'timeline', label: 'Timeline' },
] as const;
export type TabId = (typeof TABS)[number]['id'];

/** Finder, views and detail for one workspace: the dashboard below its top bar. Also rendered inside MCP hosts. */
export function DashboardBody({ workspace, tab, openTab }: { workspace: Workspace; tab: TabId; openTab: (id: TabId) => void }) {
  const { memoryId } = useController(workspace.selection);

  useEffect(() => {
    void workspace.finder.run();
  }, [workspace]);

  return (
    <div className={`body ${memoryId ? 'with-detail' : ''}`}>
      <FinderPanel workspace={workspace} />
      <main className="stage">
        <nav className="tabs" role="tablist" aria-label="Views">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              className={`tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => openTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <section className="panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'graph' && <GraphView workspace={workspace} />}
          {tab === 'lineage' && <LineageView workspace={workspace} />}
          {tab === 'trace' && <TraceView workspace={workspace} />}
          {tab === 'timeline' && <TimelineView workspace={workspace} />}
        </section>
      </main>
      {memoryId && <DetailPanel workspace={workspace} onShowLineage={() => openTab('lineage')} onShowInGraph={() => openTab('graph')} />}
    </div>
  );
}
