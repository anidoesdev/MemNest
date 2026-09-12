# Build Prompt: Oxbow — a context memory API with a visual memory graph

> Paste below the line into your coding agent. This is a **greenfield repository**, not an addition to an existing codebase.
> Where this prompt states a decision, it has already been made — implement it, do not relitigate it.
> Where it states a question, stop and ask.

---

## ROLE

You are building **Oxbow** — a self-hostable context memory engine for AI agents, shipped as installable TypeScript packages plus a dashboard that visualizes the memory graph.

This is not a vector store with a nice README. A vector store returns chunks that resemble a query. Oxbow extracts **atomic facts** from raw content, decides how each new fact relates to what is already known (replaces it, enriches it, duplicates it), keeps the history, and lets a human *see and correct* what the system believes.

Three consumers, in priority order:

1. A standalone dashboard app (v1 deliverable)
2. Runnel, an n8n-style workflow platform, as an embedded library dependency
3. Third-party OSS consumers, later

### The name

An **oxbow** is a former meander of a river, cut off when the channel changed course and left intact beside the water that still flows. That is this system's central design decision: when a fact is superseded, the old one is not destroyed. It is stranded, still visible, still traceable, no longer on the live path.

Use it consistently. Display name **Oxbow**, capital O, one word. Package and binary names lowercase `oxbow`. Never `OxBow`, never `ox-bow`. The CLI binary is `oxbow`.

## DECISIONS ALREADY MADE — DO NOT RELITIGATE

| # | Decision | Rationale |
|---|---|---|
| D1 | Postgres + pgvector is the primary store; SQLite + FTS5 is the secondary, lexical-only store | Runnel ships both; the engine must degrade, not crash |
| D2 | `@oxbow/client` implements the **same interface** as `@oxbow/core` | Consumers switch embedded ↔ remote by changing one import |
| D3 | UI logic lives in a framework-free `@oxbow/ui-core`; React and Vue packages are thin wrappers | v1 dashboard is React; Runnel's editor is Vue and will mount these later |
| D4 | v1 ships a **standalone dashboard app**, not an embedded widget | Embedding needs an auth model that does not exist yet |
| D5 | The UI is **read + forget only** in v1. No editing memory content | A wrong fact can be deleted; it cannot be silently rewritten |
| D6 | Soft delete (`forgottenAt`) for memories; hard delete only at container level | Graph integrity vs GDPR — both are needed, at different granularities |
| D7 | Extraction is asynchronous. `add()` returns before memories exist | Two LLM calls per document; blocking is unacceptable |
| D8 | Oxbow owns its schema in a dedicated Postgres schema (`oxbow.*`) | Host apps have their own migration systems; do not collide |
| D9 | No `derives` (cross-memory inference) in v1 | Expensive, low precision, and not needed to prove the thesis |

## VERIFY BEFORE YOU START

Report on these before writing code:

- Node 20+, pnpm 9+, Docker available for Postgres 16 + pgvector
- An embeddings endpoint and a completions endpoint are reachable (OpenAI-compatible is fine; Ollama is fine)
- `pgvector` extension can be created in the target database

If the completions endpoint is unavailable, build M0–M1 anyway — they require no model calls.

---

## PART 1 — ARCHITECTURE

```
apps/dashboard              React + Vite. The v1 UI.
   │ @oxbow/client (HTTP)
   ▼
packages/server             Hono. REST + SSE. Auth. The only process with DB creds.
   │ @oxbow/core
   ▼
packages/core               Types, ports, engine. ZERO I/O dependencies.
   ├── ingest/              chunk, hash, normalize
   ├── extract/             transcript → candidate memories
   ├── resolve/             candidate vs existing → new | duplicate | updates | extends
   ├── recall/              hybrid search, RRF, budget packing
   └── profile/             cached container summary
        │ ports
        ▼
packages/store-postgres     pgvector + tsvector
packages/store-sqlite       FTS5, no vectors
packages/providers          OpenAI / Ollama / Voyage adapters

packages/ui-core            Framework-free: data fetching, graph layout, selection state
packages/ui-react           ~150 lines. useSyncExternalStore over ui-core.
packages/ui-vue             (v2, for Runnel) ~150 lines. shallowRef over ui-core.
packages/cli                migrate, ingest, search, eval, seed
```

### Four hard rules

1. **`core` imports nothing that touches a socket or a disk.** No `pg`, no `fetch`, no `fs`. Every external capability is a port passed into `createOxbow()`. If you find yourself adding a dependency to `core`, you have made a mistake.
2. **`ui-core` imports no framework.** No React, no Vue, no DOM APIs beyond what a layout engine needs. It exposes a controller with `subscribe(listener)` and plain state. The wrappers must be trivial; if a wrapper needs logic, that logic belongs in `ui-core`.
3. **Provenance is not optional.** Every memory records the document ids it came from and the extraction run that produced it. A memory with no traceable source is a bug, and there is a test asserting none exist.
4. **A container tag is a hard boundary.** Every store method takes a scope. There is no query path that can return rows from a container the caller did not name. This is enforced at the store interface, not by convention.

---

## PART 2 — THE DOMAIN MODEL

Read this section twice. Everything else is plumbing.

### Documents vs memories

A **document** is raw input: a chat transcript, a markdown file, a paragraph of text. You store it, chunk it, embed the chunks, and serve those chunks for grounding. Documents are managed by the caller — added, updated, deleted.

A **memory** is an atomic fact the engine extracted from a document. Memories are managed by the engine — created, superseded, extended, forgotten. `"Alex is a PM at Stripe"` is a memory. The 40-turn conversation it came from is a document.

One `add()` produces chunks *and* memories *and* updates a profile, all under the same container.

### Types

```ts
type ContainerTag = string;              // "user:123", "workflow:abc", "org:acme"

interface AddInput {
  content: string | ConversationTurn[];
  containerTag: ContainerTag;
  customId?: string;                     // stable identity across re-ingest
  metadata?: Record<string, string | number | boolean>;
  documentDate?: string;                 // when the content is ABOUT
  extraction?: 'instant' | 'batched' | 'none';   // default 'batched'
}

type MemoryKind = 'fact' | 'preference' | 'episode';

interface Memory {
  id: string;
  containerTag: ContainerTag;
  content: string;                       // atomic, self-contained, one topic
  kind: MemoryKind;
  confidence: number;                    // 0..1, from the extractor
  isLatest: boolean;
  version: number;
  supersedes?: string;                   // memory id this UPDATES
  extendsIds: string[];                  // memory ids this ENRICHES
  sourceDocumentIds: string[];           // never empty
  extractionRunId: string;
  validFrom: string;
  validUntil?: string;                   // time-based expiry
  forgottenAt?: string;                  // soft delete
  reinforcementCount: number;            // preferences strengthen with repetition
}
```

Two fields teams omit and regret: `sourceDocumentIds` and `confidence`. Without provenance a bad memory is undebuggable. Without confidence you cannot gate anything.

`content` must be **self-contained**. `"He moved there in March"` is a failed extraction. `"Alex moved to Seattle in March 2026"` is a memory. Assert this in the extractor eval: no candidate may contain an unresolved pronoun.

### Relations

- **updates** — the new fact replaces the old for retrieval. Old row keeps `isLatest = false`. Nothing is deleted.
- **extends** — the new fact enriches without invalidating. Both stay `isLatest = true`.
- **duplicate** — no new row. Increment `reinforcementCount` on the existing memory and append the new source document id.

### Forgetting

Three mechanisms, all required in v1:

- **Expiry** — the extractor sets `validUntil` on time-bound content ("meeting at 3pm today"). Retrieval filters on it.
- **Contradiction** — `updates` wins for "what is true now".
- **Noise** — the extractor rejects conversational filler. Precision matters more than recall here; a memory store full of `"the user said thanks"` is worse than an empty one.

---

## PART 3 — PORTS

```ts
interface MemoryStore {
  capabilities(): { vector: boolean; fullText: boolean; transactions: boolean };

  putDocument(doc: Document): Promise<void>;
  putChunks(chunks: Chunk[]): Promise<void>;
  putMemories(memories: Memory[]): Promise<void>;
  supersede(oldId: string, newId: string): Promise<void>;
  reinforce(memoryId: string, sourceDocumentId: string): Promise<void>;
  forget(memoryId: string, at: string): Promise<void>;

  lexicalSearch(q: string, scope: Scope, k: number): Promise<Scored<Row>[]>;
  vectorSearch(v: Float32Array, scope: Scope, k: number): Promise<Scored<Row>[]>;

  getLineage(memoryId: string): Promise<LineageGraph>;
  listMemories(scope: Scope, page: Page): Promise<Memory[]>;
  graphSnapshot(scope: Scope, opts: SnapshotOpts): Promise<GraphSnapshot>;
}

interface EmbeddingProvider {
  id: string;                    // e.g. "openai:text-embedding-3-small"
  dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

interface CompletionProvider {
  complete(req: CompletionRequest): Promise<CompletionResponse>;   // JSON-schema constrained
}

interface JobQueue {
  enqueue(job: Job): Promise<void>;
  process(handler: JobHandler): void;
}

interface Redactor { redact(text: string): string }
interface TokenCounter { count(text: string): number }
interface Clock { now(): string }
```

`capabilities()` is what makes one engine work on both stores. When `vector` is false, recall runs lexical-only and says so in the trace. No branching on store type anywhere in `core`.

**Dimension lock.** Persist the `EmbeddingProvider.id` on the container the first time it is written. Refuse writes from a different provider id with a clear error naming both. Silent dimension mismatch produces garbage recall that takes days to diagnose.

Inject `Clock`. Temporal logic that calls `Date.now()` directly cannot be tested.

---

## PART 4 — THE INGEST PIPELINE

```
add() → validate scope → redact → hash → dedupe by (customId, hash)
      → normalize → chunk → embed → index → status: 'indexed'
      → enqueue extraction job
```

Return from `add()` at `indexed`. Do not block on extraction (D7).

**Chunking is type-aware.** Conversation turns chunk on turn boundaries. Markdown chunks on headings. Prose chunks on paragraphs with overlap. Before embedding, prepend a one-line document-level summary to each chunk — contextual chunking is the cheapest retrieval quality win available and costs one extra completion per document.

**Redaction runs before anything is persisted**, not before it is returned. Patterns: bearer tokens, `sk-` prefixes, AWS keys, JWTs, anything under a key matching `/pass|secret|token|key|auth|credential/i`. A test ingests a transcript containing known credential fixtures and greps the entire database for them. That test is a security test and runs in CI.

**Idempotency.** Same `customId` + same content hash = no-op returning the existing document id. Same `customId` + different hash = new version of the document; re-extract, and reconcile memories from the previous version rather than duplicating them.

### Extraction job

```
load document(s) → group → extract candidates → resolve each → write
```

**Grouping is the quality lever.** In `batched` mode, wait a short window (default 30s, configurable) and group documents sharing a `customId`. A single chat turn rarely contains a durable fact; a session does. Extracting per-message produces fragmented, pronoun-laden garbage. `instant` mode skips grouping for tests and demos — implement it, but make `batched` the default and say why in the docs.

**Candidate extraction** is one completion with a strict JSON schema output:

```ts
{ candidates: Array<{
    content: string;          // self-contained, one topic
    kind: MemoryKind;
    confidence: number;
    validUntil?: string;      // set for time-bound facts
  }> }
```

The prompt is the product. Budget real iteration time. Non-negotiable instructions in it: resolve every pronoun against the transcript; one topic per candidate; omit anything transient, conversational, or already obvious; never emit credentials or secrets; prefer emitting nothing over emitting noise.

**Resolution**, per candidate:

1. Hybrid-retrieve the top 10 existing `isLatest` memories in the container.
2. One completion classifying the candidate against those 10: `new | duplicate | updates:<id> | extends:<id>`.
3. Apply: `duplicate` → `reinforce()`. `updates` → insert + `supersede()`. `extends` → insert + edge. `new` → insert.

This step is the difference between Oxbow and a vector store. Give it the same care as the extractor.

Write transactionally. On Postgres use a real transaction; on SQLite use the same. If `capabilities().transactions` is false, fail loudly rather than writing partial graphs.

**Job queue.** Ship an in-process queue backed by a `oxbow.jobs` table with attempt counts and exponential backoff. Keep it behind the `JobQueue` port so a consumer can supply BullMQ. Failed extraction must not lose the document; the document stays queryable as chunks, and the job is retryable from the CLI.

---

## PART 5 — RECALL

Two surfaces. Do not merge them.

```ts
searchMemories(q, scope, opts): Promise<MemoryResult[]>   // facts, for the prompt
searchDocuments(q, scope, opts): Promise<ChunkResult[]>   // chunks, for grounding
search(q, scope, opts): Promise<{ memories, chunks, trace }>   // both, one round trip
```

### Pipeline

```
query → parallel { lexicalSearch, vectorSearch } → RRF fuse
      → filter isLatest && !forgottenAt && (validUntil == null || validUntil > now)
      → optional LLM rerank
      → budget-aware pack
      → return results + trace
```

RRF with `k=60` is the default fusion. When `capabilities().vector` is false, lexical scores pass through unfused and the trace records `degraded: 'lexical-only'`.

### Budget packing

Do not return top-k. Return **as much as fits in `tokenBudget`, highest value first**, using the injected `TokenCounter`. Every consumer is squeezing memories into a prompt alongside other context. This one parameter is what makes the library pleasant to integrate.

### The trace — build this, it is the headline feature

Every `search()` returns a structured trace:

```ts
interface RecallTrace {
  query: string;
  rewrittenQuery?: string;
  degraded?: string;
  candidates: Array<{
    memoryId: string;
    lexicalRank?: number; lexicalScore?: number;
    vectorRank?: number;  vectorScore?: number;
    rrfScore: number;
    rerankScore?: number;
    included: boolean;
    excludedReason?: 'not-latest' | 'expired' | 'forgotten' | 'budget' | 'rerank';
    tokens: number;
  }>;
  budget: { limit: number; used: number };
  timings: Record<string, number>;
}
```

Nobody in this category ships this. It is what turns "the agent said something weird" into a five-second diagnosis, and it is the most compelling thing in the dashboard.

### Profiles

A cached container summary: stable facts plus a short recent-activity digest, prompt-ready. Rebuild on a memory-count delta (default 10) or a staleness interval, never on every write. `profile()` must be a single fast read from cache.

---

## PART 6 — SERVER AND AUTH

Hono. REST plus SSE for job status.

```
POST   /v1/documents                 add
GET    /v1/documents/:id             status, chunks
DELETE /v1/documents/:id
POST   /v1/search                    { memories, chunks, trace }
GET    /v1/profile/:containerTag
GET    /v1/memories                  list, paginated, filterable
GET    /v1/memories/:id/lineage      the DAG for one memory
POST   /v1/memories                  direct write, bypassing extraction
POST   /v1/memories/:id/forget
GET    /v1/graph/:containerTag       GraphSnapshot for visualization
DELETE /v1/containers/:tag           hard delete (D6)
GET    /v1/events                    SSE: job status
```

**Auth.** Bearer API keys. Store only a hash (argon2id), never the key. Keys carry an optional `containerTag` scope; a scoped key cannot read or write outside it, enforced in middleware that injects the `Scope` — not in handlers. The dashboard authenticates with a session cookie issued from a key.

**Write a leakage test.** Create two containers, populate both, call every read endpoint with a key scoped to one, assert nothing from the other appears. Run it in CI. Parameterize it over all endpoints so a new endpoint that forgets the scope fails the existing test.

---

## PART 7 — THE UI

### Architecture (D3)

`@oxbow/ui-core` exposes controllers. No framework, no JSX, no DOM.

```ts
createGraphController(opts: {
  client: OxbowClient;
  containerTag: string;
}): {
  getState(): GraphState;
  subscribe(fn: () => void): () => void;
  setFilter(f: GraphFilter): void;
  select(memoryId: string | null): void;
  expandLineage(memoryId: string): Promise<void>;
  dispose(): void;
}

computeLayout(nodes, edges, opts): Map<string, { x: number; y: number }>
```

Layout runs in `ui-core` (d3-force for the global graph, a Sugiyama-style layered layout for lineage DAGs), off the main thread in a worker when node count exceeds 500. The React wrapper is `useSyncExternalStore` over `subscribe`/`getState` plus a renderer. Nothing else. If `ui-react` grows past ~150 lines of logic, you have put something in the wrong package.

### Four views, in this build order

**1. Lineage** (build first). One memory, its ancestors and descendants: what it superseded, what extends it, which documents produced it. A small layered DAG, always readable regardless of store size. This is the debugging view and the one that proves the edge model works.

**2. Retrieval trace** (build second). A query box. Run it, then show every candidate as a row: lexical rank, vector rank, fused score, included or excluded and why, token cost, with the budget line drawn across the list. This is the demo that makes people understand what Oxbow is.

**3. Temporal** (build third). One entity or topic, its facts over time. "Worked at Google until March, Stripe since." A horizontal timeline with superseded facts greyed. This visualizes the single thing that distinguishes memory from RAG.

**4. Global graph** (build last). Force-directed overview of a container. Node colour by `kind`, size by `reinforcementCount`, superseded nodes dimmed, edges styled by relation.

**Render to canvas, not SVG, for the global graph.** SVG is fine to ~1,000 nodes and dies after. Above 2,000 nodes, cluster by default and require a filter or a search to expand. Do not ship a hairball and call it a feature. Include a fixture container with 10,000 memories and make "it is still usable" an acceptance criterion.

Selecting any node anywhere opens a detail panel: content, kind, confidence, validity window, source documents with links to the raw chunk, full version history, and a **Forget** button with confirmation (D5).

---

## PART 8 — PACKAGING

- Publish under the `@oxbow` scope. The unscoped `oxbow` package name is taken by an unrelated project; the scope is clear. Claim it before the first release.
- pnpm workspaces + Turborepo
- `tsup`, emitting ESM + CJS + `.d.ts`
- Explicit `exports` map per package; no deep imports into `dist`; `"sideEffects": false`
- `engines.node >= 20`
- Changesets for versioning. Stay on `0.x` until the API stops moving.
- CI: typecheck → test → build → `publint` → `attw` → publish on tag

Add a `pnpm pack:local` script in week one that builds tarballs and installs them into a throwaway consumer project. The most common way a TypeScript library ships broken is an exports map that works inside the monorepo and fails on install. Run it before every release.

---

## PART 9 — EVALS

Build the harness before tuning any prompt. Without it you are guessing.

Fixtures are `{ ingestSequence[], query, assertions[] }`. Mock both providers deterministically for CI; keep a separate `--live` mode for real model runs.

Required cases:

| Case | Assertion |
|---|---|
| Contradiction | Ingest A, then contradicting B. Query → returns B, not A. A exists with `isLatest=false`. |
| Duplicate | Ingest the same fact twice differently phrased → one memory, `reinforcementCount=2` |
| Extends | Ingest role, then team size → two memories, both latest, edge present |
| Expiry | Ingest "meeting at 3pm today", advance the injected clock 2 days → not returned |
| Precision at scale | 1,000 irrelevant + 1 relevant memory → the relevant one is in the top 5 |
| Pronoun resolution | No candidate contains an unresolved pronoun |
| Noise rejection | A transcript of pure smalltalk → zero memories |
| Leakage | Two containers, scoped key → zero cross-container rows, every endpoint |
| Secrets | Transcript with credential fixtures → zero hits in a full-database grep |
| Degradation | The full suite passes on SQLite with `vector: false` |

Leakage and secrets are security tests. They gate merges.

Also register Oxbow as a provider in **MemoryBench**, the open-source memory benchmark that supports third-party implementations. Whatever the first score is, it is a number that can move, and it belongs in the README.

---

## MILESTONES

| # | Milestone | Done when |
|---|---|---|
| 0 | Types, ports, engine skeleton, in-memory store | add → search round-trips against fakes; `core` has zero runtime deps |
| 1 | SQLite store, lexical only, CLI, migrations | Real persistence, no embeddings anywhere in the codebase yet |
| 2 | Extraction: prompt, schema, job queue, grouping | One real transcript yields atomic, pronoun-free facts |
| 3 | Resolution: updates / extends / duplicate, versioning | Contradiction, duplicate and extends eval cases pass |
| 4 | Postgres + pgvector, hybrid recall, RRF, trace, budget packing | Precision-at-scale passes; trace is complete and correct |
| 5 | Profiles, forget, expiry, container delete | Public API complete. Tag `0.1.0`. Publish to npm. |
| 6 | Server, auth, scoped keys, leakage suite | Leakage and secrets suites green in CI |
| 7 | `ui-core` + `ui-react`; lineage and trace views | A wrong memory can be found and forgotten through the UI |
| 8 | Temporal and global graph views; 10k-node fixture | Usable at 10,000 memories |
| 9 | Runnel integration: recall + capture in the assistant loop | The assistant recalls a preference stated in a previous session |

Do not skip M1. Building the whole loop with no embeddings forces the architecture to be honest about where the value actually is.

Do not start M7 before M3 is green. A graph UI over an unresolved memory store is a scatter of disconnected dots with a physics simulation attached.

## DEFINITION OF DONE

A developer runs `docker compose up`, gets a server and dashboard, and creates a key.

They ingest two chat transcripts under `user:123`. The first says the user prefers Postgres over MongoDB and is working on a payments service. The second, a week later, says they have moved that service to MySQL.

They query *"what database does this user use?"* through the API. It returns the MySQL fact, not the Postgres one, inside a 200-token budget, with a trace showing the Postgres memory excluded for `not-latest`.

They open the dashboard, find the MySQL memory in the global graph, click it, and see its lineage: it supersedes the Postgres memory, which is greyed out, and both link back to the transcripts that produced them. The temporal view shows the switch with a date.

They notice the extractor also stored something wrong and click Forget. The next query does not return it, and the trace shows it excluded for `forgotten`.

Then they `pnpm add @oxbow/core` in a separate project, point it at the same Postgres, and get identical results with no server in the loop.

## HOW TO WORK

1. Report the environment verification before writing code.
2. Write `core` and its in-memory fake first. If you need a database to test the engine, the ports are wrong.
3. Build the eval harness before tuning the extraction prompt.
4. Never stub and continue — throw `NotImplementedError('M<n>')` so gaps fail loudly.
5. Every memory-writing path gets a provenance assertion. Every read path gets a scope assertion.
6. If something here conflicts with reality once you start, stop and say so rather than working around it silently.
