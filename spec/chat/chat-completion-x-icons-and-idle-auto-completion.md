---
title: "Archive chats: the archive control and idle auto-archive"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Archive chats: the archive control and idle auto-archive

Taking a chat off the active list is called **Archive**, and a chat taken off it is **Archived**. It is reversible organization, not deletion: an archived chat stays readable and restorable until the user deletes it ([decision 0027](../../docs/decisions/0027-keep-completed-chats-until-explicit-deletion.md)).

**Archive, not Complete** `[implemented 2026-11-19, #3021; desktop unit tests, typecheck and the Agents sidebar journey pass; Android unit tests and iOS Protocol tests pass and the iOS app builds; not yet checked in the packaged app or on a device]`. The action was called Complete, its list Completed, and its button an X ([decision 0107](../../docs/decisions/0107-call-it-archive-not-complete.md)). Now, on the desktop, iOS and Android alike:

- The action is **Archive** everywhere it appears: a chat window's top-right button and its right-click menu (Ctrl/Cmd+Shift+E), the Agents panel card's button, the card's right-click menu (was Mark as completed), voice ("Nekko, archive this chat"; "complete this session" still works), and the phones' swipe and chat menus.
- The button wears the **archive** glyph (Gentleface `archive` on the desktop, playing its motion once on hover; `archivebox` on iOS; Material `Archive` on Android), not an X: an X read as "close the window", so people expected the chat to stay listed.
- Archived chats are under **Show archived (N)** in their group, or the **Archived** group when the panel is not grouped by project. Each row leads with the archive glyph in faint ink and is no longer struck through: archived is not the same as done.
- Toasts, settings and search say archived: "Chat archived.", Settings → General → **Archive idle agents after**, the chat pane action **Archive (default)**, "Archived and read-only." in the reader, "Archived" beside a match in search and the command palette, and **Include archived chats** in the Library.
- **A chat window has no separate Close.** Its right-click menu had Complete, Delete, Minimize and Close; Close stopped the agent and dropped the window but left the chat in the Agents panel as Done, still wearing its X, which looked like closing had not worked. A chat window now offers Archive (off the list), Delete, and Minimize (the window goes, the agent stays on the list). Terminals and other windows keep Close.
- Unchanged on purpose, so saved settings and older builds keep working: the `archivedAt` field, the `chatPaneAction` value `complete`, the `autoCompleteAfterDays` and `completionTipSeen` settings, the phones' saved `showCompleted` view key and `__completed` group key, and the model's `complete_session` tool (its result text now says archived). Renaming the tool changes the system prompt for every turn and its golden fixtures, so it is left for its own change.

**Idle agents archive themselves.** Settings → General → **Archive idle agents after** offers 1 week, 2 weeks, 1 month (the default) and 3 months, or Never. An agent untouched for longer than that is archived exactly as its Archive button would: reversible, kept until explicitly deleted, restorable from Show archived. Pinned chats, sub-agents (they go with their parent), task and training chats, and anything running or waiting for an answer are skipped; if the app cannot tell what is running, nothing is archived. The sweep runs at launch and every six hours while the app is open, closes those chats' windows, and reports the batch in one toast. It runs in the desktop/web renderer, so a host with no window open does not archive chats.

**Archive starts at once** `[implemented 2026-11-04, #1662; unit tests pass, the felt delay not measured]`. Pressing the card's button used to play the whole exit (the row folding left, then its space collapsing, about half a second) before asking the engine to archive the chat, which then stopped the turn, saved the archive and refreshed the list one after another, so the window lingered for close to a second. The engine work now starts the moment the button is pressed and the exit plays over it. An archive the engine refuses still puts the row back.

History: on 2026-10-15 ([#533](https://github.com/nekko-labs/nekko-agent/issues/533), [the task archive](../../docs/history/tasks-archive.md#chat-completion-x-icons-533)) the action's checkmark became an X because people did not recognize the checkmark as a way to put a chat away. The X still archived, never deleted. It was replaced by the archive glyph on 2026-11-19 (#3021).

No new permissions, network calls, telemetry or dependencies. The Gentleface archive glyph and its motion are MIT, from the same set the desktop already bundles ([ASSETS.md](../../ASSETS.md)).
