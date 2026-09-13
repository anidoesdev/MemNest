---
'@memnest/core': minor
'@memnest/store-sqlite': minor
'@memnest/store-postgres': minor
'@memnest/server': minor
'@memnest/client': minor
'@memnest/cli': minor
---

M6: the Memnest server.

- New `@memnest/server`: Hono REST and SSE over the engine, with argon2id API keys, container-scoped keys enforced in middleware, and HttpOnly session cookies for the dashboard. The leakage and secrets suites cover every route.
- New `@memnest/client`: implements `MemnestApi` over HTTP, so application code switches between embedded and remote by changing one import.
- `@memnest/core`: `MemnestApi` (what the engine and the client share) split from `Memnest`; the `AuthStore` port with `createInMemoryAuthStore`; `unauthorized` and `internal` error codes; `JobStatusEvent`; the default redactor removes Memnest API keys.
- Stores: `authStore()`. **Run `memnest migrate`**: SQLite migration 5 and Postgres migration 3 add the `api_keys` and `sessions` tables.
- CLI: `memnest serve` and `memnest keys create | list | revoke`.
