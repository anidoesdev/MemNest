# @memnest/server

## 0.1.0

### Minor Changes

- 82d74ea: M6: the Memnest server.
  
  - New `@memnest/server`: Hono REST and SSE over the engine, with argon2id API keys, container-scoped keys enforced in middleware, and HttpOnly session cookies for the dashboard. The leakage and secrets suites cover every route.
  - New `@memnest/client`: implements `MemnestApi` over HTTP, so application code switches between embedded and remote by changing one import.
  - `@memnest/core`: `MemnestApi` (what the engine and the client share) split from `Memnest`; the `AuthStore` port with `createInMemoryAuthStore`; `unauthorized` and `internal` error codes; `JobStatusEvent`; the default redactor removes Memnest API keys.
  - Stores: `authStore()`. **Run `memnest migrate`**: SQLite migration 5 and Postgres migration 3 add the `api_keys` and `sessions` tables.
  - CLI: `memnest serve` and `memnest keys create | list | revoke`.
- 547238d: M7 and M8: the dashboard.
  
  - New `@memnest/ui-core`: framework-free controllers for the graph, lineage, retrieval trace, timeline, memory detail (with two-step forget) and finder, plus a workspace that keeps them consistent. Includes a seeded force layout and a layered (Sugiyama-style) DAG layout, a Web Worker layout runner for 500+ nodes, topic clustering above 2,000 memories, quadtree hit-testing and a canvas renderer.
  - New `@memnest/ui-react`: `useController`, `useWorkspace` and `GraphCanvas`.
  - `@memnest/server`: `listen({ dashboard })` and `createDashboardHandler` serve a built dashboard from the API's origin with a strict CSP.
  - CLI: `memnest serve --dashboard <dir>` (or `MEMNEST_DASHBOARD_DIR`).

### Patch Changes

- Updated dependencies [82d74ea]
  - @memnest/core@0.2.0
