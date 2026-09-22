# @memnest/cli

```sh
npm install -g @memnest/cli
memnest migrate
memnest ingest session.json --container user:123 --custom-id session-1
memnest worker
memnest search "what database does this user use?" --container user:123 --budget 200
memnest profile --container user:123
memnest mcp --container user:123       # MCP server over stdio, for Claude, Cursor, VS Code
memnest --help
```

Uses SQLite by default (`--db` or `MEMNEST_DB`), or Postgres with `--database-url` / `MEMNEST_DATABASE_URL`. Model providers are configured with `MEMNEST_*` variables; run `memnest providers env` to see them.
