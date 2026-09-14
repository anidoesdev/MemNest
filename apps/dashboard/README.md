# Memnest dashboard

The standalone dashboard (D4): see what an agent remembers, why it recalls it, and forget what is wrong (D5: read and forget only).

- **Graph.** The container's memories as a glowing neural network on a dark canvas. Colour is kind, size and brightness are reinforcement, superseded memories are faint ghosts, forgotten ones dark rings. Edges are updates (arrow) and extends (dotted); signals travel along them unless the system asks for reduced motion. Above 2,000 matching memories it shows topic clusters; click one, or filter, to expand.
- **Lineage.** One memory, what it superseded, what extends it, and the documents it came from.
- **Retrieval trace.** Run a query with a token budget and see every candidate: lexical and vector rank, fused score, tokens, and whether it was included or why not, with the budget line drawn across the list.
- **Timeline.** A topic's facts over time, with each switch dated.
- **Detail panel.** Opens when a memory is selected anywhere: content, kind, confidence, validity, version history, related memories, source documents with their text, and Forget (with confirmation).

The dashboard follows the system light or dark theme, or a choice made with the theme switch in the top bar. The graph stays dark in both.

## Running it

Served by the server from the same origin as the API. The session cookie is `SameSite=Strict` and there is no CORS.

```sh
pnpm build
memnest serve --dashboard apps/dashboard/dist        # or MEMNEST_DASHBOARD_DIR; the Docker image does this
```

Development, with hot reload, against a running server on :8787:

```sh
memnest serve &                                      # plain HTTP: browsers accept its Secure cookie on localhost
pnpm --filter @memnest/dashboard dev                 # proxies /v1 to MEMNEST_SERVER (default http://127.0.0.1:8787)
```

Sign in with an API key (`memnest keys create --name me`). A key scoped to a container opens it directly; an unscoped key asks which container to open.

## Tests

- `pnpm --filter @memnest/dashboard test`: the app in jsdom against an in-process server. Signs in, finds a wrong memory and forgets it, and checks the trace, timeline and lineage.
- `pnpm --filter @memnest/dashboard test:e2e`: a real browser against `memnest serve`. Runs the Definition of Done story and the 10,000-memory fixture (clustered open, hover, expand, pan and zoom frame times, no long tasks), and fails on console errors or CSP violations. Needs `pnpm build`; set `PLAYWRIGHT_CHANNEL=chrome` to use installed Chrome. Screenshots go to `E2E_OUT`.
