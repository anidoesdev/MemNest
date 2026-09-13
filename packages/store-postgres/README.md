# @memnest/store-postgres

Postgres + pgvector store for Memnest:

- Everything lives in its own schema (`memnest` by default).
- Full-text search on a `tsvector` column with a GIN index.
- HNSW vector search, with an index created per embedding dimension.
- A job queue claimed with `FOR UPDATE SKIP LOCKED`, so many workers can share one database.

```ts
import { createMemnest } from '@memnest/core';
import { ollamaEmbeddings } from '@memnest/providers';
import { createPostgresStore } from '@memnest/store-postgres';

const store = await createPostgresStore({ connectionString: process.env.MEMNEST_DATABASE_URL, autoMigrate: true });
const memnest = createMemnest({ store, queue: store.jobQueue(), embedder: ollamaEmbeddings({ model: 'nomic-embed-text' }) });
```

Requires the pgvector extension (`pgvector/pgvector:pg16` works out of the box).
