---
status: accepted
date: 2026-11-20
---

# 0110. Chat windows close without archiving

## Context

[Decision 0107](0107-call-it-archive-not-complete.md) took Close off chat windows: the old Close stopped the agent and dropped the window but left the chat in the Agents panel as Done, still wearing the X that then meant Complete, so closing looked like it had failed. It named Minimize as the way to put a window away without archiving, and said repeated reports of a missing Close would mean it was wrong.

The day after it shipped, the request came: a close button on the agent window that just closes the agent and does not archive it. Minimize is not the same thing, because it leaves the agent running.

## Options considered

1. **Keep 0107: Minimize is the way.** No change. Leaves no way to stop an agent and put its window away in one step without taking the chat off the list.
2. **Bring back Close beside Archive.** The X that confused people now belongs to Close alone: Archive wears the archive glyph, so the two no longer look alike.
3. **Make Archive optional per window.** A setting nobody would find, for a choice that is really two actions.

## Decision

Option 2. A chat window's title strip ends with Minimize, Archive (or Delete, when that is the chosen pane action) and Close, the X last as on every window. Close stops the agent and its watchers, takes the window off the board and leaves the chat in the Agents panel, neither archived nor deleted. The right-click menu has Close again too. The rest of 0107 (Archive, not Complete, and its stored keys) stands.

## Consequences

A chat window has one more button. Closing and archiving are now visibly different: the X closes, the box archives. Closing stops a running reply; Minimize is still the way to hide a window and let the agent keep working.

See [the feature specification](../../spec/chat/chat-completion-x-icons-and-idle-auto-completion.md).
