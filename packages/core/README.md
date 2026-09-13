# @memnest/core

The Memnest engine: types, ports and `createMemnest()`. Zero runtime dependencies and no I/O. Storage, models and queues are ports you pass in.

```sh
npm install @memnest/core @memnest/store-sqlite   # or @memnest/store-postgres
```

```ts
import { createMemnest, scopeOf } from '@memnest/core';
import { createSqliteStore } from '@memnest/store-sqlite';

const store = createSqliteStore({ filename: 'memnest.db', autoMigrate: true });
const memnest = createMemnest({ store, queue: store.jobQueue() });

await memnest.addMemories({ containerTag: 'user:123', memories: [{ content: 'The user prefers dark mode.', kind: 'preference' }] });
const { memories, trace } = await memnest.search('editor theme', scopeOf('user:123'), { tokenBudget: 200 });
const profile = await memnest.profile(scopeOf('user:123'));
```

`@memnest/core/testing` provides an in-memory store (optionally with vector search), a fixed clock, a scripted model and a deterministic embedder for tests.

See the [Memnest README](../../README.md) for the full guide.
