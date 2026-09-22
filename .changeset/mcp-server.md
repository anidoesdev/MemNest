---
'@memnest/mcp': minor
'@memnest/cli': minor
---

The MCP server: long-term memory for any MCP client (Claude Desktop, Claude Code, Cursor, VS Code, agent frameworks).

- New `@memnest/mcp`: `createMemnestMcpServer({ memnest, containerTag })` over anything implementing `MemnestApi`, the embedded engine or `@memnest/client`. Tools: `recall`, `remember` (skips exact duplicates; `supersedes` and `extends` record changes), `ingest` (raw content through extraction), `forget`, `history` and `profile`. The profile is also a `memnest://profile` resource, and `with-memory` is a prompt. The container is fixed by whoever starts the server, never by a tool argument. `readOnly` registers only recall, history and profile. `@memnest/mcp/stdio` adds `serveMemnestStdio`.
- CLI: `memnest mcp --container <tag>` serves it over stdio. Locally it uses `~/.memnest/memnest.db` (or `--db`, `MEMNEST_DB`, `MEMNEST_DATABASE_URL`), migrates a SQLite database on first use and runs the extraction worker when a completion provider is configured. With `--url` (or `MEMNEST_SERVER_URL`) and `MEMNEST_KEY` it uses a Memnest server instead, taking the container from a scoped key. `--read-only` (or `MEMNEST_MCP_READ_ONLY=true`).
