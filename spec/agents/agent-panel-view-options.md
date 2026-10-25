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

## Group header hierarchy

Implemented: project, status, date and Completed group labels use the theme's primary accent color and 13px semibold uppercase text, with accent disclosure chevrons. Vertical groups have 16px of separation and 6px between each heading and its contents, so headings stand apart from agent-card metadata. Horizontal groups retain their existing column alignment. Collapsing, project actions, drag/drop, and ungrouped lists are unchanged. No new storage, network access or permissions.

Verification: regression tests and isolated matching light/dark renderer captures cover the hierarchy; packaged-app verification remains separate.

## Cards that need you, and the model line (2026-10-23)

`[implemented; unit-tested; verified in the hidden layout-evidence fixture with before/after captures in both themes; packaged desktop app not checked]`

- A card whose agent is waiting on you (a question or approval) or stopped on an error takes the same highlighted background as the active card, so it can be found in a column without reading.
- The waiting glyph is orange (`--attention`, its own token, louder than the amber warning) and drawn a size larger than its slot, like the working rocket, so the titles stay aligned.
- The model line names the model alone ("Opus 5.5"), followed by the context readout. The provider ("Claude", "Local", "ChatGPT (subscription)") is fainter subtext on the line under it, toggled by **Show > Model provider** (on by default). The hover title still reads "provider / model id".


## Compact horizontal row

Implemented: the horizontal Agents panel has no block padding below the cards or their collapse wrapper, and adjacent groups have no vertical gap. Its five controls occupy a two-column grid at the left, rather than a five-button stack that determines the row height. Column controls and collapsed-panel placement are unchanged. Choices, grouping and scrolling retain their behavior; no new settings or permissions.

Acceptance: the card bottoms meet the horizontal scrollbar, with no unused panel space after the scrollbar. Hidden full-App DOM measurements at 1440x900 found a card-to-scrollbar difference below 1px and no space after the list. CSS regression tests cover the grid and padding. Before/after captures exist; pixel inspection and native-window verification remain unverified.
