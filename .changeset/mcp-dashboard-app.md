---
'@memnest/mcp': minor
'@memnest/core': minor
'@memnest/cli': patch
---

The Memnest dashboard inside the chat.

- `@memnest/mcp`: `show_dashboard` opens the dashboard as an MCP App (`ui://memnest/dashboard`), rendered inline by hosts that support MCP Apps, such as Claude: the finder, graph, lineage, retrieval trace and timeline views, and the detail panel. It takes an optional `view`, a `query` to search and trace, and a `memoryId` to open. The page reads through `dashboard_read` and forgets through `dashboard_forget`, tools visible only to the app and bound to the server's container, so it needs no server or key. With `readOnly`, `dashboard_forget` is not registered. `recall` and `remember` now describe themselves as the user's Memnest memory and say when to use them.
- `@memnest/core/testing`: `seedMemories` moved here from `@memnest/cli`, which still re-exports it.
