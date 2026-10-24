---
title: "Agent panel view options (2026-10-17)"
area: agents
split-from: SPEC.md (2026-10-22)
---

# Agent panel view options (2026-10-17)

`[implemented; unit-tested; verified in an isolated web-edition sandbox (separate NEKKO_DATA_DIR) with matched before/after captures; packaged desktop app not checked]` The Agents panel has a sliders button beside its **+**, and right-clicking any group header opens the same menu at the pointer. It arranges the panel the way a mail or task list's view menu does:

- **Group by:** Project (default, the panel as it always was), Status (Needs input, Working, Error, Idle), Date (Today, Yesterday, Previous 7 days, Previous 30 days, Older, by last update or by creation when sorting by creation), or None (one plain list with no headers). Outside Project grouping, completed chats gather in one **Completed** group at the bottom, folded until opened.
- **Sort by:** Manual (default: the order cards were dragged into, newest first for the rest), Last updated, Date created or Name, with Descending / Ascending. Picking Name starts A to Z and a date starts newest first. Manual has no direction.
- **Show:** **Metadata** (the model, context, git and sub-agent lines under each card's title; off leaves the title row alone), **Model provider** (where the card's model comes from, as subtext on its own line under the model; disabled while Metadata is off) `[added 2026-10-23]`, **Automations** (chats an automation started) and **Empty groups** (projects or buckets with no active agents; the General bucket still hides when empty).
- **Reset to defaults** restores the original panel and is disabled when nothing differs.
- Dragging cards into order works only when grouped by project in manual order, the one arrangement where that order is what the panel shows; projects can be dragged only when grouped by project. Group header **+** and terminal buttons appear only in project grouping.
- The choice is a per-window preference in `localStorage` (`nekko.agentPanelView`), like the panel width; invalid saved values fall back field by field. No host calls, storage schema, permissions or network use change.

## Cards that need you, and the model line (2026-10-23)

`[implemented; unit-tested; verified in the hidden layout-evidence fixture with before/after captures in both themes; packaged desktop app not checked]`

- A card whose agent is waiting on you (a question or approval) or stopped on an error takes the same highlighted background as the active card, so it can be found in a column without reading.
- The waiting glyph is orange (`--attention`, its own token, louder than the amber warning) and drawn a size larger than its slot, like the working rocket, so the titles stay aligned.
- The model line names the model alone ("Opus 5.5"), followed by the context readout. The provider ("Claude", "Local", "ChatGPT (subscription)") is fainter subtext on the line under it, toggled by **Show > Model provider** (on by default). The hover title still reads "provider / model id".
