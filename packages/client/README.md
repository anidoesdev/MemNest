# @memnest/client

HTTP client for a Memnest server. It implements `MemnestApi`, the same interface as the embedded engine, so switching between embedded and remote is a one-line change.

```ts
import { createMemnestClient } from '@memnest/client';
import { scopeOf, type MemnestApi } from '@memnest/core';

const memnest: MemnestApi = createMemnestClient({ baseUrl: 'http://localhost:8787', apiKey: process.env.MEMNEST_KEY });
// or, embedded:  const memnest: MemnestApi = createMemnest({ store, queue });

await memnest.add({ containerTag: 'user:123', content: transcript });
const { memories, trace } = await memnest.search('what database does this user use?', scopeOf('user:123'), { tokenBudget: 200 });
```

Results, `null`s and error codes match the engine's. Server errors are rethrown as `MemnestHttpError`, which extends `MemnestError` and adds the HTTP `status`.

The embedded engine's operational methods (`startWorker`, `processDueJobs`, `backfillEmbeddings`) run where the store lives and are not part of the client.

In a browser, sign in once and let the cookie authenticate what follows:

```ts
const client = createMemnestClient({ baseUrl: '' });
await client.login(apiKey);          // HttpOnly session cookie
for await (const event of client.events({ signal })) console.log(event.type, event.jobId);
```

Works anywhere `fetch` does: Node 20+, browsers, Deno, Bun and workers. Pass `fetch` to use a custom one.
