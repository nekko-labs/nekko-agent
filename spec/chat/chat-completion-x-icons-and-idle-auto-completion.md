---
title: "Chat completion X icons and idle auto-completion (2026-10-15)"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Chat completion X icons and idle auto-completion (2026-10-15)

`[implemented; focused tests, desktop suite, typecheck and build pass; matched isolated before/after captures of the header and card controls (wide light/dark) inspected; packaged app and native mobile not checked]` Users did not recognize the checkmark on chat windows/cards as a way to close their chats. The active-chat completion action in shared-renderer pane headers and chat cards/saved-chat rows now shows the existing X icon. This is an icon-only refactor: X still completes/archives the chat into Show completed with the indefinite retention and restoration; it does not permanently delete the chat or become board-only Minimize. Preserve accurate Complete labels/tooltips, keyboard shortcuts, configured Delete/trash/confirmation behavior, terminal Close, hover/focus behavior, save-failure recovery and completion exit timing. Unrelated success/completed-state checkmarks and native mobile clients are outside scope.

**Idle agents complete themselves.** Settings → General → **Complete idle agents after** offers 1 week, 2 weeks, 1 month (the default) and 3 months, or Never. An agent untouched for longer than that is completed exactly as its X would complete it: reversible, kept until explicitly deleted, restorable from Show completed. Pinned chats, sub-agents (they go with their parent), task and training chats, and anything running or waiting for an answer are skipped; if the app cannot tell what is running, nothing is completed. The sweep runs at launch and every six hours while the app is open, closes those chats' windows, and reports the batch in one toast. It runs in the desktop/web renderer, so a host with no window open does not complete chats.

No new permissions, network calls, telemetry or dependencies; one optional setting, `autoCompleteAfterDays`. Improved discoverability is the intended outcome, not a validated usability claim. Tracked in [#533](https://github.com/nekko-labs/nekko-agent/issues/533) and [TASKS.md](TASKS.md#chat-completion-x-icons-533).
