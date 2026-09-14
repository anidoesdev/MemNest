# @memnest/ui-react

## 0.1.0

### Minor Changes

- 547238d: M7 and M8: the dashboard.
  
  - New `@memnest/ui-core`: framework-free controllers for the graph, lineage, retrieval trace, timeline, memory detail (with two-step forget) and finder, plus a workspace that keeps them consistent. Includes a seeded force layout and a layered (Sugiyama-style) DAG layout, a Web Worker layout runner for 500+ nodes, topic clustering above 2,000 memories, quadtree hit-testing and a canvas renderer.
  - New `@memnest/ui-react`: `useController`, `useWorkspace` and `GraphCanvas`.
  - `@memnest/server`: `listen({ dashboard })` and `createDashboardHandler` serve a built dashboard from the API's origin with a strict CSP.
  - CLI: `memnest serve --dashboard <dir>` (or `MEMNEST_DASHBOARD_DIR`).

### Patch Changes

- Updated dependencies [547238d]
  - @memnest/ui-core@0.1.0
