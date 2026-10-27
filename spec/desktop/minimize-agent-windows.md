---
title: "Minimize agent windows"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Minimize agent windows

Implemented; focused action verification pending, visual verification deferred by user direction. Each chat window on the Agents wall offers a minus control immediately before its configured lifecycle action (Complete by default). Minimize removes only the pane from the wall tree; it does not archive/complete/delete the chat or abort its running reply. The incomplete chat remains in the left Agents list and selecting it restores its window. Drafts and session records remain intact; no new host actions or permissions. Terminal and non-wall workspace windows do not gain this control. Acceptance: minimize invokes only pane removal, Complete remains independent, and sidebar restore retains incomplete state.

## Automatic minimization in Dynamic View

Implemented; focused tests, desktop typecheck/build, and isolated 1440px/390px completion/restore and async-race checks pass. Matched before/after screenshots and completion recording frames inspected. Packaged app and live-provider runs remain unverified. When a successful agent reply ends, its chat pane automatically minimizes in Dynamic View, including Fixed grid. Focused View keeps the finished reply visible. Errors, loop/runaway stops, and chats with pending questions or approvals remain visible. The host's pending-input state is checked before hiding a pane; a failed check or a newer event leaves it visible. No idle chats are minimized on mount.

Since zones (2026-10-26, *Dynamic view: zones*), minimizing, closing or completing an agent on the Dynamic board empties its zone, which stays in place drawn dotted, rather than removing the window's space. Selecting the chat in the Agents list puts it back in the active zone.

This uses the same pane-only removal as manual Minimize. It neither completes nor deletes the chat, stops background work, nor introduces host permissions. The chat remains in the Agents list and selecting it restores the window. Terminals are unchanged. Each display acts on its own wall.

Acceptance: a successful reply removes only its own chat pane in Dynamic and Fixed grid; Focused, errors, abnormal stops, pending input and other panes remain unchanged. Sidebar restore preserves the incomplete chat and transcript. Verify matched isolated before/after captures and a recording of the completion transition.
