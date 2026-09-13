# Memnest

A self-hostable context memory engine for AI agents.

A vector store returns chunks that resemble a query. Memnest extracts **atomic facts** from raw content, decides how each new fact relates to what is already known (replaces it, enriches it, duplicates it), keeps the history, and lets a human see and correct what the system believes.

Memnest is where an agent's memories live. Nothing is thrown out: when a fact is superseded it stays in the nest, still visible and traceable, just no longer on the live path.

## Status

| # | Milestone | State |
|---|---|---|
| 0 | Types, ports, engine skeleton, in-memory store | ✅ |
| 1 | SQLite store (lexical only), CLI, migrations | ✅ |
| 2 | Extraction: prompt, schema, job queue, grouping | ✅ with scripted models. Not yet run against a live model |
| 3 | Resolution: updates / extends / duplicate, versioning | ✅ with scripted models. Not yet run against a live model |
| 4 | Postgres + pgvector, hybrid recall, RRF, trace, budget packing | ✅ Precision-at-scale passes on every store. Semantic recall not yet run against a live embedding model |
| 5 | Profiles, forget, expiry, container delete. Public API complete, `0.1.0` | ✅ Published to npm (`0.1.0`, providers `0.1.1`) |
| 6 | Server, auth, scoped keys, leakage suite | ✅ Leakage and secrets suites cover every endpoint on the in-memory, SQLite and Postgres stores |
| 7–9 | UI, Runnel | Not started |

Nothing in the public API is stubbed. Every milestone through M6 is implemented and tested on the in-memory, SQLite and Postgres stores.

## Recall

```
query → { lexical, vector } in parallel → RRF (k = 60) → filter latest, remembered, unexpired → optional LLM rerank → pack to the token budget → results + trace
```

`search()` returns memories (facts, for the prompt), chunks (for grounding) and a trace. Every candidate from either retriever appears once in the trace, with the following fields:

- `lexicalRank` / `lexicalScore` and `vectorRank` / `vectorScore`, where the retriever found it.
- The fused `rrfScore`, and `rerankScore` when reranked.
- Its token cost.
- Whether it was included, or excluded as `not-latest`, `expired`, `forgotten`, `rerank` or `budget`.

`budget.used` is exactly the sum of the included tokens. Memories are packed first and chunks share what remains.

**Degradation is explicit.** When a retriever can't run, the trace says why in `degraded`:

- `lexical-only`: the store has no vector search (SQLite).
- `lexical-only: no embedding provider configured`.
- `lexical-only: container has no embeddings yet`.
- `lexical-only: query embedding failed (…)`.
- `rerank failed (…); fused order kept`.

The engine never branches on store type, only on `capabilities()`.

**Dimension lock.** The first embedding write records the provider id and dimensions on the container. Writes or queries from any other provider fail with an error naming both, instead of producing silent garbage.

**Contextual chunks.** Chunks are embedded at `add()`. When the extraction job runs, one extra completion writes a one-sentence summary of the newest document, and its chunks are re-embedded with that summary in front. This is best-effort: if it fails, the reason is recorded and extraction continues.

## Profiles

`profile(scope)` returns a prompt-ready summary of a container: durable facts and preferences, plus a short digest of recent activity. Each item cites the memory ids it states.

```ts
const { text, stable, recent, stale } = await memnest.profile(scopeOf('user:123'));
// About the user:
// - The user works at Stripe as a product manager.
// - The payments service of the user runs on MySQL.
//
// Recent activity:
// - The user has a dentist appointment on 2026-03-11.
```

- **A cached read.** A rebuild is due after 10 memory changes or once the profile is 24 hours old, never on every write. With a completion provider the rebuild is queued for the worker and the model condenses the memories. Without one, a deterministic builder ranks the memories and runs inline.
- **Claimed atomically.** Concurrent writers never both rebuild.
- **Always safe to use, even when stale.** Forgetting a memory, or superseding it, removes every profile item that cites it immediately. Expired items are hidden when the profile is read.
- **Guarded model output.** Items must cite valid memories, contain no pronouns and no secrets. If the model fails, the deterministic builder answers instead and the reason is recorded.

## Postgres

```sh
docker compose up -d
export MEMNEST_DATABASE_URL=postgres://memnest:memnest@localhost:5432/memnest
export MEMNEST_EMBEDDING_PROVIDER=ollama          # or openai / voyage; see: memnest providers env
memnest migrate
memnest ingest session.json --container user:123
memnest search "what database does this user use?" --container user:123 --budget 200
```

- **Schema.** Everything lives in its own schema (`memnest`, or `MEMNEST_PG_SCHEMA`) and is migrated under an advisory lock.
- **Full text.** A generated `tsvector` column with a GIN index.
- **Vectors.** A pgvector column, plus a partial HNSW index created per embedding dimension on first use. Queries use iterative index scans (pgvector 0.8+), so filtering by container doesn't starve results.
- **Jobs.** Claimed with `FOR UPDATE SKIP LOCKED`, so any number of workers can share one database.

```ts
import { createMemnest } from '@memnest/core';
import { ollamaEmbeddings } from '@memnest/providers';
import { createPostgresStore } from '@memnest/store-postgres';

const store = await createPostgresStore({ connectionString: process.env.MEMNEST_DATABASE_URL });
const memnest = createMemnest({ store, queue: store.jobQueue(), embedder: ollamaEmbeddings({ model: 'nomic-embed-text' }) });
```

## Extraction

`add()` returns as soon as the document is indexed (D7). An extraction job then turns it into memories:

```
load group → wait for the session to go quiet (batched) → one completion per window → screen → resolve each (no lock held) → re-validate and write (one transaction)
```

**Why `batched` is the default.** A single chat message rarely contains a durable fact; a session does. Extracting per message produces fragments like "He moved there in March" that depend on context the memory will never be shown with. In batched mode, documents sharing a `customId` form one session. Extraction waits until the session has been quiet for 30 seconds (capped at 10 minutes after its first unextracted version), then runs once over the newest version. If the session keeps growing after that, only the new part is extracted, with the already-processed tail passed along to resolve references. `instant` skips grouping and is meant for tests and demos.

**Screening.** The prompt asks for self-contained, one-topic, non-trivial, secret-free candidates. Deterministic checks then enforce that regardless of the model. Candidates are dropped for unresolved pronouns, anything the redactor catches, confidence below 0.5, an expiry already in the past, malformed output, or in-batch duplicates. Every rejection is recorded, redacted, on the extraction run (`memnest runs`).

**Resolution.** For each accepted candidate, Memnest retrieves up to 10 similar latest memories: stored ones, plus any written earlier in the same run. Then it decides:

- No similar memories: `new`, with no model call.
- Identical text: `duplicate`, with no model call.
- Otherwise, one completion classifies the candidate as `new`, `duplicate` (reinforce and add the source), `updates` (write a new version and mark the old one not-latest; nothing is deleted) or `extends` (write with an edge; both stay latest).

The prompt shows neighbors as short labels (`m1`…`m10`) with their dates, and every answer is checked against those labels. Invalid output is retried once, then kept as `new`: a missed relation is recoverable, a wrong `updates` hides a true fact. Model calls happen before the write transaction, and each plan is re-validated inside it. If the target was forgotten or superseded meanwhile, the candidate is written as `new` with `via: "conflict"`. Every decision and its reason is recorded on the run (`memnest runs`).

**Jobs.** One queue implementation (`createJobQueue`) runs over pluggable storage: in-memory, or the SQLite `memnest_jobs` table. It handles attempts, exponential backoff, leases (a crashed worker's job is taken over) and deferral that doesn't spend attempts. Permanent errors fail immediately. A failed extraction never loses the document: its chunks stay searchable, and `memnest jobs retry <id>` requeues it. Supply your own queue (e.g. BullMQ) through the `JobQueue` port.

```sh
memnest ingest session.json --container user:123 --custom-id session-1
memnest worker                  # or: memnest jobs run
memnest runs --container user:123
```

## Evals

`memnest eval` runs the suite in `@memnest/evals`. Each case is a sequence of ingest steps, a query and assertions. CI uses scripted model output; `--live` uses whatever `MEMNEST_*` configures (assertions that only make sense with scripted output are skipped).

| Case | Asserts | State |
|---|---|---|
| real-transcript | An onboarding call yields atomic, pronoun-free facts; no secrets, no filler | ✅ |
| pronoun-resolution | No candidate contains an unresolved pronoun | ✅ |
| noise-rejection | Pure small talk → zero memories | ✅ |
| secrets | Credential fixtures → zero bytes persisted | ✅ |
| session-grouping | A session sent turn by turn → one model call | ✅ |
| expiry | "Meeting at 3pm today" + 2 days → excluded as `expired` | ✅ |
| precision-at-scale | 1,000 irrelevant + 1 relevant → relevant in top 5, on memory, SQLite and Postgres | ✅ |
| profile-current | After a contradiction, the profile states the new fact and not the superseded one | ✅ |
| semantic-recall | A question worded differently from the memory is answered through embeddings | live only |
| contradiction | Ingest A, then contradicting B → B served, A kept as `not-latest` with an `updates` edge | ✅ |
| duplicate | The same fact phrased twice → one memory, `reinforcementCount = 2` | ✅ |
| extends | Role, then team size → two latest memories with an `extends` edge | ✅ |
| session-growth | A session re-sent with more turns reconciles instead of duplicating | ✅ |
| in-conversation-correction | A fact corrected later in the same chat is superseded, not stored as two truths | ✅ |
| leakage, degradation | Covered by the store contract suite on every store | ✅ |

```sh
memnest eval                           # scripted, in-memory store
memnest eval --store sqlite
memnest eval --store postgres --database-url $MEMNEST_DATABASE_URL
MEMNEST_PROVIDER=ollama MEMNEST_COMPLETION_MODEL=llama3.1:8b memnest eval --live
```

## Server

```sh
docker compose up -d                                         # Postgres + pgvector and the server on :8787
docker compose exec server memnest keys create --name admin  # prints the key once
```

Or without Docker: `memnest migrate && memnest keys create --name admin && memnest serve`.

```sh
KEY=mnk_...
curl -X POST localhost:8787/v1/memories -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"containerTag":"user:123","memories":[{"content":"The user prefers Postgres over MongoDB."}]}'
curl -X POST localhost:8787/v1/search -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"containerTag":"user:123","query":"what database does this user use?","options":{"tokenBudget":200}}'
```

- **API.** REST for documents, search (with the trace), profiles, memories, lineage, forget, graph snapshots, container delete and extraction runs. SSE at `/v1/events` streams job status. Full list: [packages/server](packages/server/README.md).
- **Keys.** Only argon2id hashes are stored. A key made with `--container` can only reach that container. Middleware injects the scope; handlers never read a container tag from the request.
- **Sessions.** The dashboard exchanges a key for an `HttpOnly`, `SameSite=Strict` cookie. Revoking the key ends its sessions.
- **Worker.** `memnest serve` also runs the extraction worker when a completion provider is configured (`MEMNEST_WORKER=auto|on|off`). SSE streams the jobs that worker processes.
- **Leakage.** The suite calls every route with a key scoped to one container, and again with a session from that key. Each call tries to reach another container through the path, query, body and ids. Probes are keyed by the route table, so a new route without one fails typecheck.

`@memnest/client` implements the same `MemnestApi` as the engine:

```ts
import { createMemnestClient } from '@memnest/client';

const memnest = createMemnestClient({ baseUrl: 'http://localhost:8787', apiKey: process.env.MEMNEST_KEY });
const { memories, trace } = await memnest.search('what database does this user use?', scopeOf('user:123'), { tokenBudget: 200 });
```

## Try it

```sh
pnpm install && pnpm build
alias memnest="node packages/cli/dist/cli.js"

memnest migrate --db demo.db
memnest memories add "The user prefers Postgres over MongoDB for the payments database." --container user:123 --db demo.db
memnest memories add "The user moved the payments database to MySQL." --supersedes <id-from-above> --container user:123 --db demo.db
memnest search "what database does this user use?" --container user:123 --budget 200 --db demo.db
```

The search prints the MySQL memory, and a trace showing the Postgres memory excluded as `not-latest`.

Embedded, with no server:

```ts
import { createMemnest, scopeOf } from '@memnest/core';
import { createSqliteStore } from '@memnest/store-sqlite';

const store = createSqliteStore({ filename: 'memnest.db', autoMigrate: true });
const memnest = createMemnest({ store, queue: store.jobQueue() });

await memnest.add({ containerTag: 'user:123', content: [{ role: 'user', content: 'I prefer Postgres.' }] });
const { memories, chunks, trace } = await memnest.search('database', scopeOf('user:123'), { tokenBudget: 200 });
```

## API

```ts
// Implemented by the embedded engine and by @memnest/client (D2).
interface MemnestApi {
  add(input: AddInput): Promise<AddResult>;                       // returns at 'indexed'; extraction runs later
  getDocument(scope, id): Promise<DocumentWithChunks | null>;
  deleteDocument(scope, id): Promise<void>;                        // tombstone: content and chunks erased

  addMemories(input: DirectMemoryInput): Promise<Memory[]>;       // direct write, provenance still recorded
  getMemory(scope, id): Promise<Memory | null>;
  listMemories(scope, page?, filter?): Promise<Memory[]>;
  getLineage(scope, memoryId): Promise<LineageGraph | null>;
  forget(scope, memoryId): Promise<Memory>;                        // soft delete (D5, D6)
  graph(scope, opts?): Promise<GraphSnapshot>;

  searchMemories(query, scope, opts?): Promise<MemoryResult[]>;
  searchDocuments(query, scope, opts?): Promise<ChunkResult[]>;
  search(query, scope, opts?): Promise<{ memories; chunks; trace }>;

  profile(scope): Promise<Profile>;
  rebuildProfile(scope): Promise<Profile>;
  deleteContainer(scope): Promise<void>;                           // hard delete (D6)

  listExtractionRuns(scope, opts?): Promise<ExtractionRun[]>;
  close(): Promise<void>;
}

// The embedded engine adds what only the process owning the store and queue can do.
interface Memnest extends MemnestApi {
  backfillEmbeddings(scope, opts?): Promise<{ memories: number; chunks: number }>;
  startWorker(): void;
  processDueJobs(): Promise<JobRunSummary>;
}
```

Every method is scoped: build scopes with `scopeOf(containerTag)`. Errors are `MemnestError`s with a `code` (`validation`, `not_found`, `scope_violation`, `provenance`, `configuration`, `provider`, `unauthorized`, …). The API stays `0.x` until it stops moving: breaking changes bump the minor version.

## Model providers

Memnest works with **Ollama** and with **any OpenAI-compatible endpoint** (OpenAI, Ollama's `/v1`, LM Studio, vLLM, Groq, OpenRouter, Together, …). Completions and embeddings can come from different providers.

```sh
# Ollama for everything
export MEMNEST_PROVIDER=ollama MEMNEST_COMPLETION_MODEL=llama3.1:8b          # embeddings default: nomic-embed-text

# OpenAI
export OPENAI_API_KEY=sk-... MEMNEST_COMPLETION_MODEL=gpt-4.1-mini          # embeddings default: text-embedding-3-small

# A local OpenAI-compatible server, with embeddings from Ollama
export MEMNEST_BASE_URL=http://localhost:1234/v1 MEMNEST_COMPLETION_MODEL=my-model MEMNEST_EMBEDDING_PROVIDER=ollama

memnest providers check    # calls both endpoints: structured JSON output and embedding dimensions
memnest providers env      # every supported variable
```

Or in code:

```ts
import { ollamaCompletion, openAICompatibleEmbeddings } from '@memnest/providers';

const completion = ollamaCompletion({ model: 'llama3.1:8b' });
const embedder = openAICompatibleEmbeddings({ baseURL: 'http://localhost:1234/v1', model: 'my-embed', dimensions: 1024 });
```

Prefer Ollama's native adapter over its `/v1` route: it enforces the JSON schema with constrained decoding. Servers that only support JSON mode work with `MEMNEST_STRUCTURED_OUTPUT=json_object`.

## Packages

| Package | |
|---|---|
| `@memnest/core` | Types, ports, engine. Zero runtime dependencies, no I/O. `@memnest/core/testing` has the in-memory store, a fixed clock and credential fixtures. |
| `@memnest/store-postgres` | Postgres + pgvector: tsvector full text, HNSW vector search, `SKIP LOCKED` job queue, all in its own schema. |
| `@memnest/store-sqlite` | better-sqlite3 + FTS5. `capabilities().vector === false`. Ships migrations and a durable `memnest_jobs` queue. |
| `@memnest/providers` | Ollama (native API, schema-constrained output), any OpenAI-compatible endpoint, Voyage embeddings. Timeouts, retries with backoff, dimension checks. |
| `@memnest/evals` | The eval harness and cases: scripted models for CI, `--live` for real ones. |
| `@memnest/server` | Hono REST + SSE. argon2id API keys, container-scoped keys, dashboard sessions. |
| `@memnest/client` | `MemnestApi` over HTTP, for Node, browsers and workers. |
| `@memnest/cli` | `memnest migrate \| ingest \| search \| memories \| forget \| lineage \| profile \| backfill \| jobs \| worker \| runs \| seed \| providers \| eval \| keys \| serve` |
| `@memnest/store-contract` | Private. The behavioural suite every store must pass. |

## Guarantees and how they are tested

- **Core does no I/O.** Core typechecks with `types: []`, so no Node or DOM globals are available, and `test/architecture.test.ts` fails on any non-relative import or I/O global.
- **A container tag is a hard boundary, over HTTP too.** Every server route is probed with a key, and with a session, scoped to another container (`packages/server/test/leakage.test.ts`), on every store. Every authenticated route refuses calls without credentials.
- **A container tag is a hard boundary.** Every `MemoryStore` method takes a `Scope`. The contract suite has one leakage probe per store method, keyed by `keyof MemoryStoreOps`, so adding a method without a probe fails typecheck. Each probe asserts that nothing from the other container is returned or modified, including attempts to re-home another container's row ids.
- **Provenance is not optional.** Stores reject memories with no source document or extraction run. Direct writes create a `direct` source document and run, and a test walks every memory back to its sources.
- **Secrets never reach storage.** Credentials sent through the API, issued API keys and session tokens are absent from the database files (`packages/server/test/secrets.test.ts`). Redaction runs before hashing, chunking or persistence. The secrets test ingests credential fixtures and greps the raw SQLite file, WAL and SHM. `secure_delete` is on, so tombstoned documents and deleted containers leave no residue on disk (also tested).
- **Partial graphs are never written.** Writes run in a transaction, and a store without transactions refuses to write.

## Development

```sh
pnpm build        # turbo, tsup: ESM + CJS + .d.ts
pnpm typecheck
pnpm test
pnpm lint:pkg     # publint + attw
pnpm pack:local   # pack tarballs, install into a throwaway consumer, smoke-test ESM/CJS/TS/bin
```

CI (`.github/workflows/ci.yml`) runs typecheck → test → build → publint → attw, a separate required **security** job (store and server leakage + secrets, Postgres included), `pack:local` on Node 20/22 and Windows, and publishes on `v*` tags.

## Decisions made while building

These interpret the build prompt where it was silent or in tension with itself:

1. **Every store method takes a `Scope`**, including `supersede`, `reinforce`, `forget` and `getLineage`, whose sketched signatures in the prompt had none. This follows hard rule 4.
2. **`MemoryStore` gained methods the sketch lacked:** `getDocument`, `findDocuments`, `getChunks`, `deleteDocument`, `getMemory`, `putExtractionRun`, `deleteContainer`, `transaction` and `close`. `lexicalSearch`/`vectorSearch` take `{ target: 'memories' | 'chunks', k }`.
3. **`DELETE /v1/documents/:id` tombstones rather than removes the row.** Content and chunks are erased, but the row stays so memories extracted from it keep a traceable source (rule 3 vs D6). Hard delete stays at the container level.
4. **`Memory` has `createdAt`.** It is needed for keyset pagination and the temporal view.
5. **Direct writes accept explicit `supersedes` / `extendsIds`.** Until resolution lands (M3), this is how relations are created. It also powers `memnest seed`.
6. **SQLite tables are prefixed `memnest_`.** This is the SQLite equivalent of D8's `memnest.*` schema. SQLite stores refuse to open with pending migrations unless `autoMigrate: true`.
7. **Chunks have no contextual summary yet.** The summary only matters for embeddings, so it lands with vector indexing in M4, not with M2.
8. **"Group documents sharing a customId" means sessions.** Because a new hash under the same `customId` is a new version, a session sent turn by turn arrives as successive versions. Cumulative versions collapse to the newest one. Non-cumulative ones are concatenated in order. Every version in the group becomes a source of the resulting memories.
9. **Resolution never holds the write lock.** The prompt resolves inside the write path. With one model call per candidate that would block every `add()` and search on SQLite for seconds, so decisions are planned first and re-validated at write time. Without a completion provider, the engine falls back to exact-duplicate detection only.
10. **`JobQueue` gained optional `runDue()` and `stop()`, and handlers may return `{ deferUntil }`.** The store gained `listExtractionRuns`, and extraction runs carry `stats`, including redacted rejections.
11. **Job claims are safe across workers; session grouping is not yet.** Postgres claims with `SKIP LOCKED` and SQLite claims atomically. But documents are marked `extracting` outside the claim, so two workers holding jobs for different versions of the same session could both extract it. Run one extraction worker per container shard until group-level locking lands.
12. **`user` is a stopword for lexical retrieval.** Extraction writes nearly every memory about "the user", so the word matched everything, including the `user:` role label in chunks. Queries that consist only of stopwords still search on all their words.
13. **Resolution answers are labels, not ids.** Models copy `m3` reliably and long ids less so. Labels are mapped back and validated, so a hallucinated reference can never create an edge.
14. **Contextual chunking runs in the extraction job, not in `add()`.** The summary needs a completion call, and `add()` must not block on one (D7). So chunks are embedded raw at `add()` and re-embedded with the summary once the job has a completion provider at hand. `extraction: 'none'` documents keep raw chunk embeddings.
15. **One `putEmbeddings(scope, target, items)` port method, plus `getContainer` and `lockEmbeddingProvider`.** Vectors stay out of `Memory` and `Chunk`, so reads never carry thousands of floats. The typed leakage probes cover all three.
16. **One HNSW index per dimension, not one fixed column size.** A single database can host containers embedded by different providers. pgvector cannot index `vector` columns above 2,000 dimensions, so larger embeddings (e.g. `text-embedding-3-large`) fall back to exact search.
17. **Vector hits must be positively similar.** Vector search returns something for every query, so hits at or below `minVectorScore` (default 0) are dropped. For resolution neighbors the bar is 0.35 cosine similarity (`extraction.minNeighborSimilarity`), because a false neighbor costs a model call and risks a wrong relation.
18. **Postgres uses `timestamptz` for engine timestamps and `text` for `documentDate`.** `documentDate` is caller-supplied and may be just a date; storing it as text keeps exactly what was given.
19. **Full text uses the `english` configuration.** It is baked into the generated column, so changing it is a migration. SQLite uses FTS5's Porter stemmer to match.
20. **The in-memory store can do exact vector search** (`createInMemoryStore({ vector: true })`), and `@memnest/core/testing` ships a deterministic `hashEmbedder`. So core tests and CI evals exercise the hybrid path without a database or a model. Hash embeddings capture wording, not meaning, which is why `semantic-recall` only runs live.
21. **Memories written before an embedder was configured have no vectors** until `backfillEmbeddings(scope)` or `memnest backfill` runs. Until then they stay lexically searchable and show no `vectorRank` in the trace.
22. **Profiles are invalidated eagerly and rebuilt lazily.** The prompt asks for a cached read that is never rebuilt on every write. But a forget (D5) must stop a fact being served, and a cached profile would otherwise keep repeating it until the next rebuild. So forget and supersede prune the items that cite those memories right away, and the rebuild waits for the threshold.
23. **Profile rebuilds run as queued jobs when they need the model, and inline when they don't.** A write with a completion provider never waits on a model call. A deployment without one still gets profiles, built deterministically inline once the rebuild is due.
24. **`0.1.0` was published from a local machine,** before the CI publish job existed, so it carries no provenance. `@memnest/providers` `0.1.1` and later releases publish from CI with provenance.
25. **D2 covers the application API, not the operational one.** `MemnestApi` is what both the engine and `@memnest/client` implement. `startWorker`, `processDueJobs` and `backfillEmbeddings` stay on the embedded `Memnest`: they run where the store and queue live. A client that threw on them would satisfy the type but fail at runtime.
26. **The server has endpoints the prompt's list lacks.** `GET /v1/memories/:id`, `POST /v1/profile/:tag/rebuild` and `GET /v1/runs` let the client implement `MemnestApi` fully. `GET/POST/DELETE /v1/session` issue and end the dashboard cookie. `/healthz` serves container health checks. `POST /v1/search` takes `include`, so `searchMemories` doesn't also run chunk retrieval.
27. **Credentials live behind their own `AuthStore` port, not `MemoryStore`.** Keys and sessions are not container data, so hard rule 4's scoping doesn't apply to them, and `deleteContainer` leaves keys scoped to that container alone. Stores ship `authStore()` on their own tables (SQLite migration 5, Postgres migration 3).
28. **Every request reads the key; only the argon2 check is cached.** argon2id is deliberately slow, so a key already verified against its stored hash isn't hashed again, but revocation still takes effect on the next request. `lastUsedAt` is written at most once a minute per key.
29. **A scoped key may delete its own container.** The prompt's key model has scope but no permissions, and deleting your own container is the GDPR path D6 exists for. Per-key permissions can narrow this later.
30. **A scope mismatch is `403 scope_violation`; a missing row is `404`.** The 403 follows from the caller's own request, so it reveals nothing about the other container. Another container's ids behave exactly like ids that don't exist.
31. **SSE streams events from the worker in the server's process.** Queue events are in-process callbacks. A worker running elsewhere (`memnest worker`) still processes jobs, but the server doesn't see its events. Postgres `LISTEN/NOTIFY` can close this later. Queue-level errors carry no container, so they are never streamed.
32. **Cookie-authenticated writes need an `x-memnest-csrf` header.** `SameSite=Strict` already keeps cookies off cross-site requests in current browsers. The header is a second guard that doesn't depend on the browser, because a cross-site form cannot set it. There is no CORS: serve the dashboard from the server's origin.
33. **`memnest serve` lives in the CLI, not a separate binary.** The CLI already builds stores and providers from the environment, and the server package stays free of store and provider dependencies. The Docker image installs the packed tarballs and runs `memnest migrate && memnest serve`.

## License

[MIT](LICENSE)
