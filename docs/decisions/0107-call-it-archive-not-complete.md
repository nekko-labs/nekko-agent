---
status: accepted
date: 2026-11-19
---

> Amended by [decision 0110](0110-chat-windows-close-without-archiving.md): chat windows have a Close again, beside Archive.

# 0107. Call it Archive, not Complete

## Context

Taking a chat off the active list was called **Complete**: a Complete button that wore an X, a **Show completed** list, Mark as completed, "Chat completed." The data already said archive (`archivedAt`), and [decision 0027](0027-keep-completed-chats-until-explicit-deletion.md) already made it reversible and kept until deleted. Two problems showed up together (#3021). "Completed" sits next to the agent status **Done**, so an archived chat and a finished one read as the same thing. And the X looked like "close the window": a chat window also had a right-click **Close** that stopped the agent and dropped the window without archiving it, so the chat stayed in the Agents panel as Done with its X still there, which looked like closing had failed.

## Options considered

1. **Keep Complete, change only the icon.** Least churn. Leaves Completed next to Done, and the word still promises "finished", which an idle chat archived after a month is not.
2. **Archive / Archived, archive glyph, no Close on a chat window.** Matches the data and what the action does (put away, restorable). One more rename across desktop, iOS, Android, spec and docs.
3. **Close / Closed.** Short, but "closed" reads as gone, which is what decision 0027 set out to avoid.

## Decision

Option 2. The action is **Archive** and the state **Archived** on every surface, the button wears an archive glyph (Gentleface `archive`, `archivebox` on iOS, Material Archive on Android), archived rows lead with that glyph and are not struck through, and a chat window offers Archive, Delete and Minimize but no Close. Code identifiers follow the words. Stored values keep their old names (`chatPaneAction: 'complete'`, `autoCompleteAfterDays`, `completionTipSeen`, the phones' `showCompleted` and `__completed` keys) so saved settings and older builds keep working.

## Consequences

Users see one word for one idea, and Done means only that the agent finished its turn. The model's `complete_session` tool keeps its name for now: renaming it changes the system prompt on every turn and its golden fixtures, so it is its own change. If people look for a way to close a chat window without archiving it, Minimize is that way; repeated reports of a missing Close would say this was wrong.

See [the feature specification](../../spec/chat/chat-completion-x-icons-and-idle-auto-completion.md).
