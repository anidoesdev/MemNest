---
'@memnest/mcp': minor
'@memnest/core': minor
'@memnest/cli': patch
---

The memory graph inside the chat.

- `@memnest/mcp`: `show_graph` opens the dashboard's graph view as an MCP App (`ui://memnest/graph`), rendered inline by hosts that support MCP Apps, such as Claude. It takes an optional `search` and a `memoryId` whose history to highlight. The page reads through `graph_snapshot` and `graph_lineage`, tools visible only to the app, so it needs no server or key. Registered in read-only mode too.
- `@memnest/core/testing`: `seedMemories` moved here from `@memnest/cli`, which still re-exports it.
