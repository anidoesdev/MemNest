import type { MemnestApi } from '@memnest/core';
import { inlineLayoutRunner, type Store } from '@memnest/ui-core';
import { useController, useWorkspace } from '@memnest/ui-react';
import type { App, McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Brand } from '../../../apps/dashboard/src/components';
import { DashboardBody, TABS, type TabId } from '../../../apps/dashboard/src/Dashboard';
import { mcpDashboardSource } from './bridge';

export interface HostState {
  status: 'connecting' | 'ready' | 'error';
  error: string | null;
  context: McpUiHostContext;
  /** The `show_dashboard` arguments the model chose. */
  input: { view?: string; query?: string; memoryId?: string };
}

/** Tall enough for the finder and a view side by side; full screen gives it the whole window. */
const INLINE_HEIGHT = 720;
// The server fixes the container; this tag only satisfies the controllers' scope checks.
const PLACEHOLDER_CONTAINER = 'mcp:dashboard';

export function McpDashboard({ app, host }: { app: App; host: Store<HostState> }) {
  const { status, error, context } = useController(host);

  // The dashboard's styles.css and graph theme read data-theme on <html>.
  useEffect(() => {
    if (context.theme) document.documentElement.dataset.theme = context.theme;
  }, [context.theme]);

  const fullscreen = context.displayMode === 'fullscreen';
  return (
    <div className="shell" style={{ height: fullscreen ? '100vh' : `${INLINE_HEIGHT}px` }}>
      {status === 'connecting' && <div className="splash" aria-busy="true" />}
      {status === 'error' && (
        <p className="error" role="alert">
          Could not connect to Claude: {error}
        </p>
      )}
      {status === 'ready' && <Connected app={app} host={host} />}
    </div>
  );
}

function Connected({ app, host }: { app: App; host: Store<HostState> }) {
  const { context, input } = useController(host);
  const [containerTag, setContainerTag] = useState<string | null>(null);
  // Workers need a same-origin script URL, which a sandboxed single-file page does not have.
  const client = useMemo(() => mcpDashboardSource(app, setContainerTag) as MemnestApi, [app]);
  const workspace = useWorkspace({ client, containerTag: PLACEHOLDER_CONTAINER, layout: inlineLayoutRunner });
  const [tab, setTab] = useState<TabId>('graph');

  // Apply what the model asked for, once per value, after the workspace exists.
  const applied = useRef<HostState['input']>({});
  useEffect(() => {
    if (!workspace) return;
    const done = applied.current;
    if (input.view && input.view !== done.view && TABS.some((t) => t.id === input.view)) setTab(input.view as TabId);
    if (input.query && input.query !== done.query) {
      workspace.finder.setQuery(input.query);
      void workspace.finder.run();
      workspace.trace.setQuery(input.query);
      void workspace.trace.run();
      workspace.timeline.setTopic(input.query);
      void workspace.timeline.run();
    }
    if (input.memoryId && input.memoryId !== done.memoryId) workspace.select(input.memoryId);
    applied.current = input;
  }, [workspace, input]);

  const canFullscreen = context.availableDisplayModes?.includes('fullscreen') ?? false;
  const fullscreen = context.displayMode === 'fullscreen';
  const toggleFullscreen = () => void app.requestDisplayMode({ mode: fullscreen ? 'inline' : 'fullscreen' }).catch(() => undefined);

  return (
    <>
      <header className="topbar">
        <Brand />
        {containerTag && (
          <span className="container-tag" title="Container">
            <span className="live-dot" aria-hidden="true" />
            {containerTag}
          </span>
        )}
        <span className="spacer" />
        {workspace && (
          <button className="button ghost small" onClick={() => void workspace.refresh()} title="Load memories added since the dashboard opened">
            Refresh
          </button>
        )}
        {canFullscreen && (
          <button className="button ghost small" onClick={toggleFullscreen}>
            {fullscreen ? 'Exit full screen' : 'Full screen'}
          </button>
        )}
      </header>
      {workspace ? <DashboardBody workspace={workspace} tab={tab} openTab={setTab} /> : <div className="splash" aria-busy="true" />}
    </>
  );
}
