import type { MemnestClient, SessionInfo } from '@memnest/client';
import { createWorkerLayoutRunner, inlineLayoutRunner, type LayoutRunner, type Workspace } from '@memnest/ui-core';
import { useController, useWorkspace } from '@memnest/ui-react';
import { useEffect, useState } from 'react';
import { Brand, ThemeToggle } from './components';
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

const tabFromHash = (): TabId => {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return (TABS.find((t) => t.id === hash)?.id ?? 'graph') as TabId;
};

function createLayoutRunner(): LayoutRunner {
  if (typeof Worker === 'undefined') return inlineLayoutRunner;
  try {
    return createWorkerLayoutRunner(new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' }));
  } catch {
    return inlineLayoutRunner;
  }
}

interface ShellProps {
  client: MemnestClient;
  session: SessionInfo;
  containerTag: string;
  onSignOut: () => void;
  /** Present when the key may open other containers. */
  onChangeContainer?: () => void;
}

export function Shell({ client, session, containerTag, onSignOut, onChangeContainer }: ShellProps) {
  const [layout] = useState(createLayoutRunner);
  useEffect(() => () => layout.dispose?.(), [layout]);
  const workspace = useWorkspace({ client, containerTag, layout });
  const [tab, setTab] = useState<TabId>(tabFromHash);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const openTab = (id: TabId) => {
    setTab(id);
    if (window.location.hash !== `#${id}`) window.history.replaceState(null, '', `#${id}`);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <Brand />
        <span className="container-tag" title="Container">
          <span className="live-dot" aria-hidden="true" />
          {containerTag}
        </span>
        {onChangeContainer && (
          <button className="button ghost small" onClick={onChangeContainer}>
            Change
          </button>
        )}
        <span className="spacer" />
        {workspace && (
          <button className="button ghost small" onClick={() => void workspace.refresh()}>
            Refresh
          </button>
        )}
        <ThemeToggle />
        <span className="session-name small" title={`Key ${session.keyId}`}>
          {session.name}
        </span>
        <button className="button ghost small" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      {workspace ? <Body workspace={workspace} tab={tab} openTab={openTab} /> : <div className="splash" aria-busy="true" />}
    </div>
  );
}

function Body({ workspace, tab, openTab }: { workspace: Workspace; tab: TabId; openTab: (id: TabId) => void }) {
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
