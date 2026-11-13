---
status: accepted
date: 2026-11-14
---

# 0098. Designs are listed for agents in an index file, not through a tool

## Context

Issue #2681 asked how an agent on any provider, Claude Code included, learns which designs a project has. The Design board's labels and pinned notes live in the app's data folder, and designs saved outside `nekko-designs/` are known only to Library. The Claude Code half (a context note naming the folder) had already landed with #2695, so what remained was making the board's facts readable.

## Decision

Nekko writes `nekko-designs/README.md` from the board after each board call: label, file and unresolved notes per design, plus live pages. It carries a marker first line, is rewritten only when its text changes, is never created in a project without a `nekko-designs/` folder, and never replaces a README the person wrote. The daemon does this in the workspace route, so every board change from any caller is covered.

## Options considered

- **A `designs` engine tool through the Claude bridge.** Answers "what exists, wherever it was saved" and could add notes. It needs the Library index moved from the renderer into the engine, a Claude policy row, approval rules and fixtures, and it reaches only providers with tool support wired. Not chosen now; the index file can be replaced by it later without changing the board.
- **Only the context note.** Already built; it names a folder but not labels or notes.
- **Put the index in the prompt.** Costs tokens on every turn and is stale within a turn.

## Consequences

- Any harness or outside tool reads the index with plain file reads, no policy gate.
- A new file appears in the user's project folder (and so in git status). It is the same folder that already holds the designs.
- The index is current only after the app touches the board. An agent that saves a design while the app is closed is not listed until the board is next opened.
- Designs outside `nekko-designs/` are still not listed for agents.
