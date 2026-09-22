# Memnest plugin for Claude Code

Long-term memory for your chats. Claude recalls what you told it in earlier sessions, records new facts, and corrects what turns out to be wrong.

## Install

```
/plugin marketplace add anidoesdev/MemNest
/plugin install memnest@memnest
```

Restart Claude Code (or run `/reload-plugins`) and the memory tools are available.

## What you get

**Tools**, which Claude calls on its own: `recall`, `remember`, `ingest`, `forget`, `history` and `profile`.

**Commands**, for when you want to drive it yourself:

| Command | What it does |
|---|---|
| `/memnest:memories [topic]` | What is remembered, with each memory's id. Optionally about one topic. |
| `/memnest:remember <fact>` | Store a fact. Checks for a memory it contradicts first, and records the change rather than storing two truths. |
| `/memnest:forget <what>` | Find a memory and stop serving it, or supersede it if the fact merely changed. |

## Configuration

Memories live in `~/.memnest/memnest.db` on your machine, created on first use. Nothing is sent anywhere, and no model or database server is needed to start.

| Variable | Default | |
|---|---|---|
| `MEMNEST_CONTAINER` | `user:me` | Whose memory this is. Use a different tag per person or project; anything pointing at the same tag shares one memory. |
| `MEMNEST_DB` | `~/.memnest/memnest.db` | Where the SQLite file lives. |
| `MEMNEST_SERVER_URL` + `MEMNEST_KEY` | unset | Use a [Memnest server](https://github.com/anidoesdev/MemNest/tree/main/packages/server) instead of a local database, so several clients and people share one memory. |

Set these in your shell before starting Claude Code.

To extract facts from whole conversations, rather than only storing what you explicitly ask it to remember, configure a completion model (`MEMNEST_PROVIDER=ollama`, `MEMNEST_COMPLETION_MODEL=llama3.1:8b`, or an OpenAI-compatible endpoint). See [Models](https://github.com/anidoesdev/MemNest/tree/main/packages/providers).

## How it behaves

- **Facts are atomic sentences** that name their subject, so they still make sense out of context.
- **A change supersedes, it does not overwrite.** The old version is kept, dated and linked, and stops being served.
- **Secrets are never stored.** Credentials are redacted before anything is written.
- **The container is fixed by configuration**, never by a tool argument, so text Claude reads cannot point the tools at another container.

## Requirements

Node.js (for `npx`), and `@memnest/cli` ≥ 0.3.0, which the plugin fetches automatically.
