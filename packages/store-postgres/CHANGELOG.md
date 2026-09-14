# @memnest/store-postgres

## 0.2.0

### Minor Changes

- 82d74ea: M6: the Memnest server.
  
  - New `@memnest/server`: Hono REST and SSE over the engine, with argon2id API keys, container-scoped keys enforced in middleware, and HttpOnly session cookies for the dashboard. The leakage and secrets suites cover every route.
  - New `@memnest/client`: implements `MemnestApi` over HTTP, so application code switches between embedded and remote by changing one import.
  - `@memnest/core`: `MemnestApi` (what the engine and the client share) split from `Memnest`; the `AuthStore` port with `createInMemoryAuthStore`; `unauthorized` and `internal` error codes; `JobStatusEvent`; the default redactor removes Memnest API keys.
  - Stores: `authStore()`. **Run `memnest migrate`**: SQLite migration 5 and Postgres migration 3 add the `api_keys` and `sessions` tables.
  - CLI: `memnest serve` and `memnest keys create | list | revoke`.

### Patch Changes

- Updated dependencies [82d74ea]
  - @memnest/core@0.2.0

## 0.1.0

### Minor Changes

- First public release. Memnest extracts atomic facts from conversations and documents, resolves them against what is already known (new, duplicate, updates, extends), keeps the history, and recalls with a hybrid lexical and vector search whose trace explains every inclusion and exclusion.
  
  - Stores: in-memory (tests), SQLite + FTS5, Postgres + pgvector.
  - Extraction with session grouping, deterministic screening and LLM resolution.
  - Hybrid recall with RRF, optional rerank, token-budget packing and a complete trace.
  - Cached profiles that never serve forgotten or superseded facts.
  - Providers: Ollama, any OpenAI-compatible endpoint, Voyage.
  - CLI and eval harness.

### Patch Changes

- Updated dependencies
  - @memnest/core@0.1.0
