---
title: "Chat transcript width (2026-10-19)"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Chat transcript width (2026-10-19)

User intent: the conversation should use the space at the sides of the chat pane instead of a centred three-quarter column, while keeping about 30px from each edge.

- `[implemented; typecheck and focused tests; desktop visual check pending]` The transcript column spans the full chat pane at every pane width, inside a 30px gutter on the left and right of the transcript scroller. The gutter is the same with the Agent Monitor open (its floating toggle only shows while the monitor is closed, and the transcript already starts below it). The composer width is unchanged. No new data, network or permission access.
