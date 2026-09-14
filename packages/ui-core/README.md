# @memnest/ui-core

Framework-free UI logic for Memnest: the controllers behind the dashboard's views, graph layout, topic clustering, viewport math, hit-testing and canvas drawing. No React, no Vue, no DOM: every controller is `getState()` plus `subscribe(listener)`, so a framework wrapper is a few lines (`@memnest/ui-react` is one).

```ts
import { createMemnestClient } from '@memnest/client';
import { createWorkspace } from '@memnest/ui-core';

const workspace = createWorkspace({ client: createMemnestClient({ baseUrl: '' }), containerTag: 'user:123' });

workspace.trace.setQuery('what database does this user use?');
workspace.trace.setTokenBudget(200);
await workspace.trace.run();
workspace.trace.getState().rows; // every candidate, why it was included or excluded, and the budget line

workspace.select(memoryId);       // detail and lineage load; the graph highlights it
workspace.detail.requestForget();
await workspace.detail.confirmForget(); // trace, finder, timeline and graph refresh
```

`client` is any `MemnestApi`, including the embedded engine, so the same controllers run in tests with no server.

| Controller | What it holds |
|---|---|
| `graph` | The global graph: filter, clusters above 2,000 matching memories, force layout, viewport, selection, lineage overlay, hover |
| `lineage` | One memory's lineage as a layered (Sugiyama-style) DAG |
| `trace` | A search's candidates joined with their text, cumulative tokens and the budget line |
| `timeline` | A topic's facts over time: version chains as lanes, each switch dated |
| `detail` | A memory, its version history, relations and sources; two-step forget |
| `finder` | Search or browse memories |

**Layout.** `computeLayout(nodes, edges, { algorithm: 'force' | 'layered' })` is deterministic for a seed. For large graphs, run it in a worker:

```ts
// layout.worker.ts
import { serveLayoutRequests } from '@memnest/ui-core';
serveLayoutRequests(self);

// app
const layout = createWorkerLayoutRunner(new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' }));
createWorkspace({ client, containerTag, layout }); // graphs of 500+ nodes lay out off the main thread
```

**Drawing.** `buildGraphScene(state, theme)` turns graph state into circles and lines, and `drawScene(ctx, scene, viewport, size, theme)` paints them on any 2D canvas context. Labels are culled and capped per frame.
