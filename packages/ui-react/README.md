# @memnest/ui-react

React bindings for `@memnest/ui-core`. Deliberately thin: all logic lives in ui-core, and a test fails if this package grows past about 150 lines of logic.

```tsx
import { GraphCanvas, useController, useWorkspace } from '@memnest/ui-react';

function Memories({ client }) {
  const workspace = useWorkspace({ client, containerTag: 'user:123' });
  if (!workspace) return null;
  return <Trace workspace={workspace} />;
}

function Trace({ workspace }) {
  const { rows, budgetLine } = useController(workspace.trace);
  // render rows…
}

<GraphCanvas controller={workspace.graph} theme={theme} />; // canvas renderer: pan, zoom, hover, click
```

- `useController(controller)`: `useSyncExternalStore` over `subscribe` and `getState`.
- `useWorkspace(options)`: creates a workspace per client and container, disposes it on change and unmount (StrictMode-safe). Null until mounted.
- `GraphCanvas`: forwards size, wheel zoom, drag pan, hover and clicks to a graph controller and draws each state with ui-core's renderer.

Peer dependency: React 18 or later.
