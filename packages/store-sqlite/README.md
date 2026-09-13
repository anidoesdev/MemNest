# @memnest/store-sqlite

SQLite store for Memnest: FTS5 full-text search, migrations, and a durable job queue. It is lexical-only (`capabilities().vector === false`); the engine degrades and says so in every trace.

```ts
import { createMemnest } from '@memnest/core';
import { createSqliteStore } from '@memnest/store-sqlite';

const store = createSqliteStore({ filename: 'memnest.db', autoMigrate: true });
const memnest = createMemnest({ store, queue: store.jobQueue() });
```

Migrations are explicit by default: `memnest migrate --db memnest.db` or `migrateFile('memnest.db')`.
