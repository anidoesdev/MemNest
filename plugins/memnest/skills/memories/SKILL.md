---
description: Show what Memnest remembers, or search it. Use when the user asks what you know or remember about them, their preferences, or a project.
---

# What is remembered

Show the user what Memnest holds for them.

1. Call the `profile` tool for the summary of durable facts and recent activity.
2. If the user named a topic (in "$ARGUMENTS" or earlier in the conversation), also call `recall` with it.
3. Present it as a short list, grouped as facts, preferences and recent activity. Keep each memory's id next to it, because `forget` and `remember … supersedes` need it.
4. End with one line on what they can do next: correct something wrong with `/memnest:forget`, or add a fact with `/memnest:remember`.

If nothing is remembered yet, say so plainly and suggest `/memnest:remember`.
