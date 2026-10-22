---
title: "Minimize agent windows"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Minimize agent windows

Implemented; focused action verification pending, visual verification deferred by user direction. Each chat window on the Agents wall offers a minus control immediately before its configured lifecycle action (Complete by default). Minimize removes only the pane from the wall tree; it does not archive/complete/delete the chat or abort its running reply. The incomplete chat remains in the left Agents list and selecting it restores its window. Drafts and session records remain intact; no new host actions or permissions. Terminal and non-wall workspace windows do not gain this control. Acceptance: minimize invokes only pane removal, Complete remains independent, and sidebar restore retains incomplete state.
