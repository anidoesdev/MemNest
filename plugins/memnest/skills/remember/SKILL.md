---
description: Store a durable fact or preference in long-term memory. Use when the user says to remember something, or states a lasting preference worth keeping.
---

# Remember this

Store what the user gave in "$ARGUMENTS", or what they just said to remember.

1. Write it as **one self-contained sentence per fact**, naming its subject ("The user prefers…", not "He prefers…"). Split several facts into several entries.
2. Call `recall` first with the same subject. If a stored memory contradicts the new fact, pass that memory's id as `supersedes`, so the old version becomes history instead of a second truth. If the new fact only adds detail, pass the id in `extends`.
3. Never store secrets: API keys, passwords or tokens. If the user's text contains one, store the fact without it and say what you left out.
4. Call `remember`, then confirm in one line what was stored and what it replaced, with the new memory's id.
