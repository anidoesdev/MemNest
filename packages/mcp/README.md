# @memnest/mcp

Long-term memory for any [MCP](https://modelcontextprotocol.io) client: Claude Desktop, Claude Code, Cursor, VS Code, and agent frameworks that speak MCP.

The model gets tools to recall and remember facts in one Memnest container. It only ever sees current facts: when something changes, the old version is kept as history and stops being served.

## Run it

The server ships in the CLI as `memnest mcp`. It speaks MCP over stdio, which is how local clients launch servers.

```sh
npx -y @memnest/cli mcp --container user:me
```

With no other settings it keeps memories in `~/.memnest/memnest.db`, migrated on first use. Nothing else to install: no database, no model.

### Claude Code

```sh
claude mcp add memnest -- npx -y @memnest/cli mcp --container user:me
```

### Claude Desktop, Cursor

`claude_desktop_config.json`, or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "memnest": {
      "command": "npx",
      "args": ["-y", "@memnest/cli", "mcp", "--container", "user:me"]
    }
  }
}
```

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "memnest": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@memnest/cli", "mcp", "--container", "user:me"]
    }
  }
}
```

Use one container per person or project (`user:me`, `project:billing`). Each is a hard boundary.

## Tools

| Tool | What it does |
|---|---|
| `recall` | Searches for current facts relevant to a question, within a token budget (default 1000). Superseded, forgotten and expired memories are left out; the reply says how many and why. |
| `remember` | Stores facts, one self-contained sentence each. Exact duplicates of current memories are skipped. `supersedes: <id>` records a change: the new fact is served and the old one is kept as history. `extends: [ids]` adds detail. |
| `ingest` | Hands over raw material (notes, a transcript) for Memnest to extract facts from and resolve against what it knows. Searchable right away; memories appear once extraction runs, which needs a completion provider. Everything ingested in one connection is extracted as one session. |
| `forget` | Stops serving a memory that is wrong. It stays in history. |
| `history` | Where a memory came from and how it changed. |
| `profile` | A short, prompt-ready summary of what is remembered. |
| `show_graph` | Opens the interactive memory graph inside the chat (see below). Optionally filtered by words, or highlighting one memory's history. |

Also: the profile as the resource `memnest://profile`, and a `with-memory` prompt that loads the profile with instructions. The server sends instructions telling the model when to recall and how to record changes.

### Memory graph in the chat

`show_graph` is an [MCP App](https://modelcontextprotocol.io/docs/extensions/apps): in hosts that support them, such as Claude, it renders the dashboard's graph view inline. Ask "show me my memory graph". Filter by words and kinds, zoom and pan, click a memory for its details and history, or hand it back with **Ask Claude**. **Refresh** picks up memories added since it opened; **Full screen** appears when the host supports it.

The page is `ui://memnest/graph` (built from `packages/mcp-app`). It reads data through two tools only it can see, `graph_snapshot` and `graph_lineage`, so it needs no server, key or network access. Hosts without MCP Apps get a text summary from `show_graph`.

## Options

| Flag | Environment | |
|---|---|---|
| `--container <tag>` | `MEMNEST_CONTAINER` | The container to use. Required locally; taken from a scoped key with `--url`. |
| `--db <path>` | `MEMNEST_DB` | SQLite file. Default `~/.memnest/memnest.db`. |
| `--database-url <url>` | `MEMNEST_DATABASE_URL` | Postgres + pgvector instead (run `memnest migrate` first). |
| `--url <url>` | `MEMNEST_SERVER_URL` | Use a Memnest server instead of a local database, with `MEMNEST_KEY`. |
| `--read-only` | `MEMNEST_MCP_READ_ONLY=true` | Only `recall`, `history`, `profile` and the graph. |
| | `MEMNEST_WORKER` | `auto` (default): run extraction when a completion provider is configured. `on` requires one; `off` never runs it. |

Model providers use the usual `MEMNEST_*` variables (`memnest providers env`). Without a completion provider, `remember` works fully; `ingest` stores text for search but extracts nothing.

### Against a Memnest server

Share memory between clients and people, and review it in the dashboard, by pointing every client at one server with a key scoped to the container:

```sh
memnest keys create --name claude --container user:me   # on the server; printed once
```

```json
{
  "mcpServers": {
    "memnest": {
      "command": "npx",
      "args": ["-y", "@memnest/cli", "mcp", "--url", "https://memnest.example.com"],
      "env": { "MEMNEST_KEY": "mnk_..." }
    }
  }
}
```

A scoped key can only reach its container, whatever the model asks for.

## In code

`createMemnestMcpServer` takes anything implementing `MemnestApi`, the embedded engine or `@memnest/client`, and returns an `McpServer` from the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) to connect to any transport.

```ts
import { createMemnestMcpServer } from '@memnest/mcp';
import { serveMemnestStdio } from '@memnest/mcp/stdio';
import { createMemnestClient } from '@memnest/client';

const memnest = createMemnestClient({ baseUrl: 'http://localhost:8787', apiKey: process.env.MEMNEST_KEY });

// stdio
serveMemnestStdio({ memnest, containerTag: 'user:123' });

// or any MCP transport
const server = createMemnestMcpServer({ memnest, containerTag: 'user:123', readOnly: true });
await server.connect(transport);
```

## Design notes

- **The container is configuration, not a tool argument.** A model can be steered by what it reads; if it could name the container, a prompt injection could name someone else's. No tool takes one.
- **`remember` writes directly; `ingest` extracts.** The calling model is already a capable resolver, so `remember` takes its facts and relations as given and only filters exact duplicates. `ingest` runs Memnest's own pipeline (screening, redaction, resolution) for material nobody has distilled yet.
- **Failures are tool results.** A bad id or an invalid date comes back as `isError` with the Memnest error code (`not_found: …`, `validation: …`), so the model can correct itself.
- **stdout is the protocol.** `memnest mcp` logs only to stderr.
