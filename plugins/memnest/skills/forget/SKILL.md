---
description: Remove a wrong memory from long-term memory. Use when the user says something Claude remembered is wrong, outdated or should be deleted.
---

# Forget a memory

1. Find the memory: call `recall` with the user's words ("$ARGUMENTS"). If several match, list them with their ids and ask which one.
2. Decide which the user means:
   - **Wrong** (it was never true): call `forget` with its id.
   - **Changed** (it was true, now it isn't): prefer `remember` with `supersedes` set to the old id, so the change is recorded and the history is kept. Say that you did this instead of deleting.
3. Confirm what is no longer served, and mention it stays visible in history for audit.

Never forget more than one memory without naming each and getting a yes.
