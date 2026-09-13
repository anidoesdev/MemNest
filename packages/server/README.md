# @memnest/server

The Memnest HTTP server: REST and Server-Sent Events over the engine, built on Hono. API keys are hashed with argon2id, keys can be scoped to one container, and the dashboard signs in with a session cookie issued from a key.

Most deployments run it through the CLI:

```sh
memnest migrate
memnest keys create --name admin                       # unscoped: every container
memnest keys create --name app --container user:123    # this container only
memnest serve                                          # http://127.0.0.1:8787
```

Or embed it:

```ts
import { createMemnest } from '@memnest/core';
import { createServer, createJobEventHub, listen } from '@memnest/server';
import { createSqliteStore } from '@memnest/store-sqlite';

const store = createSqliteStore({ filename: 'memnest.db' });
const events = createJobEventHub();
const memnest = createMemnest({ store, queue: store.jobQueue({ onEvent: events.publish }) });
const server = createServer({ memnest, auth: store.authStore(), events });
const { key } = await server.keyring.issue({ name: 'admin' });
await listen(server, { port: 8787 });
```

`server.fetch` is a standard `(Request) => Response` handler, so the app also runs on any runtime Hono supports.

## Endpoints

| Method | Path | |
|---|---|---|
| `POST` | `/v1/documents` | Add a document (`202`, extraction runs later) |
| `GET` / `DELETE` | `/v1/documents/:id` | Document with chunks / tombstone |
| `POST` | `/v1/search` | `{ query, options?, include? }` → `{ memories, chunks, trace }` |
| `GET` | `/v1/profile/:containerTag` | Cached profile; `POST …/rebuild` to build now |
| `GET` / `POST` | `/v1/memories` | List (`limit`, `after`, `kind`, `latestOnly`, `includeForgotten`) / direct write |
| `GET` | `/v1/memories/:id` | One memory |
| `GET` | `/v1/memories/:id/lineage` | Its lineage DAG |
| `POST` | `/v1/memories/:id/forget` | Soft delete |
| `GET` | `/v1/graph/:containerTag` | Graph snapshot (`limit`, `includeSuperseded`, `includeForgotten`) |
| `DELETE` | `/v1/containers/:containerTag` | Hard delete |
| `GET` | `/v1/runs` | Extraction runs (`limit`, `documentId`) |
| `GET` | `/v1/events` | SSE: `ready`, `job` and `ping` events |
| `POST` / `GET` / `DELETE` | `/v1/session` | Sign in with `{ apiKey }` / who am I / sign out |
| `GET` | `/healthz` | Liveness, unauthenticated |

Routes that name a container take it from the path, the `containerTag` query parameter, or the JSON body. A scoped key may omit it; naming any other container is `403 scope_violation`. An unscoped key must name one. Container tags containing `/` are URL-encoded in paths.

Errors are `{ "error": { "code", "message" } }` with the engine's codes: `validation` 400, `unauthorized` 401, `scope_violation` 403, `not_found` 404, `configuration` 409, `provenance` 422, `internal` 500, `not_implemented` 501, `provider` 502. Unexpected errors are reported as `internal` with no detail.

## Security

- **Keys** look like `mnk_<id>_<secret>`. Only an argon2id hash of the secret is stored (19 MiB, 2 iterations). Unknown, wrong and revoked keys get the same error, and unknown key ids still cost a hash verification. The default redactor strips Memnest keys from ingested content.
- **Scope** is resolved once, in middleware, from the key. Handlers only ever see the injected scope. The leakage suite calls every route with a key scoped to one container, and with a session from that key. Each call tries to reach another container by path, query, body and id, and the suite asserts nothing from it is returned or changed. The suite is keyed by the route table, so a route without a probe fails typecheck.
- **Sessions** are random 256-bit tokens in an `HttpOnly`, `SameSite=Strict`, `Secure` cookie. Only their SHA-256 is stored. Every request re-reads the key, so revoking a key ends its sessions. Cookie-authenticated writes must send the `x-memnest-csrf` header.
- **Not included yet:** rate limiting, CORS (serve the dashboard from the same origin), and per-key permissions beyond container scope.
