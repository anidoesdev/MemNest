import type { MemnestClient, SessionInfo } from '@memnest/client';
import { createWorkerLayoutRunner, inlineLayoutRunner, type LayoutRunner } from '@memnest/ui-core';
import { useWorkspace } from '@memnest/ui-react';
import { useEffect, useState } from 'react';
import { Brand, ThemeToggle } from './components';
import { DashboardBody, TABS, type TabId } from './Dashboard';

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
      {workspace ? <DashboardBody workspace={workspace} tab={tab} openTab={openTab} /> : <div className="splash" aria-busy="true" />}
    </div>
  );
}
