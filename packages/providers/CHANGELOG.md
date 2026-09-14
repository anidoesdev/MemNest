# @memnest/providers

## 0.1.2

### Patch Changes

- Updated dependencies [82d74ea]
  - @memnest/core@0.2.0

## 0.1.1

### Patch Changes

- Ship the MIT LICENSE file in the package tarball.

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
