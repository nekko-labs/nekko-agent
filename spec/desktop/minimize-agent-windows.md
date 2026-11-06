---
title: "Minimize agent windows"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Minimize agent windows

Implemented; focused action verification pending, visual verification deferred by user direction. Each chat window on the Agents wall offers a minus control immediately before its configured lifecycle action (Complete by default). Minimize removes only the pane from the wall tree; it does not archive/complete/delete the chat or abort its running reply. The incomplete chat remains in the left Agents list and selecting it restores its window. Drafts and session records remain intact; no new host actions or permissions. Terminal and non-wall workspace windows do not gain this control. Acceptance: minimize invokes only pane removal, Complete remains independent, and sidebar restore retains incomplete state.

## Automatic minimization in Dynamic View (removed 2026-11-03)

Removed. A successful reply now leaves its chat pane in place in its zone, so the window the user was watching does not swap itself out for an empty-zone placeholder the moment the reply lands. The agent still appears in the left Agents panel's **Done** group (additive, already wired), so the Agents list remains the way to resume a finished chat from the side. Manual Minimize (the row-level control) and manual zone close are unchanged.

Previously (2026-10-22 through 2026-11-02): when a successful agent reply ended, its chat pane automatically minimized in Dynamic View, emptying its zone to a dotted placeholder. This surprised users who were still reading the reply or wanting to type a follow-up, since the window they were looking at was removed without their asking. The automatic path and its guard code (`minimizeFinishedReply` in `apps/desktop/src/renderer/commandWall.ts`) are gone; the `auto-minimize-sandbox.cjs` evidence script is deleted. Focused View, errors, loop/runaway stops, and chats with pending questions or approvals were already visible under the old rules and remain visible under the new one.

Acceptance: a successful reply leaves its pane in Dynamic and Fixed grid; the agent additionally appears in the Agents panel's Done group on the left; manual Minimize and zone close remain their old selves.
