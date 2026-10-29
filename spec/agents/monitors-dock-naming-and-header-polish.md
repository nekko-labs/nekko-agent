---
title: "Monitors dock naming and header polish (2026-10-16)"
area: agents
split-from: SPEC.md (2026-10-22)
---

# Monitors dock naming and header polish (2026-10-16)

User intent (Philip): the right-side dock's cards are **monitors** (the Budget monitor, the Hardware monitor); the column Agents header keeps its controls on the left and + on the right; the + menu uses the wall's add icons; the dock is seamless.

- **Monitors** `[implemented; unit-tested]`. Code, types and settings call the dock's cards monitors: `MonitorsDock`, `MonitorKey`, `MONITORS`, `dock.monitors` and `dock.monitorOrder` (were `WallDock`, `WallDockPanel`, `DOCK_PANELS`, `dock.panels`, `dock.panelOrder`). Saved settings with the old `panels`/`panelOrder` keys load unchanged; the new keys win when both exist. Accessible names read "Budget monitor", "Minimize Budget monitor", "Configure monitors". The wall toolbar toggle reads **Monitors**; the dock's own visible "Panels" heading is intentionally unchanged.
- **Seamless dock** `[implemented; renderer-verified in an isolated fixture]`: the dock has no background of its own; only the monitor cards are surfaces. **Configure** uses a three-vertical-slider icon instead of the gear.
- **Agents header** `[implemented; renderer-verified in an isolated fixture]`: in the column layout, Hide agents and Row/Column sit at the left of the header and + stays at the right. The row layout uses a compact two-column controls strip so the buttons do not add empty height below the cards.
- **+ menu** `[implemented; renderer-verified in an isolated fixture]`: Agent shows the Nekko mark, **Create or Edit Photos and Videos** (was "Media gen") the photo glyph, Terminal the terminal glyph.

Not verified: packaged app and native window chrome.

## Local models monitor in Panels (2026-10-17)

User intent: from the Agents view's Panels dock, see which local models are running and jump straight to the place where their GPU/CPU placement is changed.

- **Local models monitor** `[implemented; unit-tested; renderer-verified in an isolated fixture]`. A sixth dock monitor, `localModels`, on by default and placed under Hardware for new docks (saved docks keep their order and gain it at the end, switched on). It polls the engine every 6 s and lists each resident model: name, placement (`on GPU · 36/36 layers`, `GPU + CPU · 38/62 layers` in amber, `on CPU`), context and footprint. It says plainly when nothing is loaded, the server is stopped, or no engine is installed, and links to Model Server. It is read-only: load-time settings stay on Model Server, where their reload cost is explained.
- **Jump to a model's settings** `[implemented; unit-tested; renderer-verified in an isolated fixture]`. **Settings** on a row (and **All settings** in the chat's Model settings group, whose inline quick edit is unchanged) calls `openLocalModelSettings(id)`: the app switches to Model Server, the In memory list unfolds that model's drawer on **Advanced** (where Runs on GPU only / Hybrid / CPU only sits), scrolls it into view and clears the request. A request for a model that is not resident is held until it is, and replaced by any later request.
- **Not changed / known limit.** Settings are per model, not per chat. Reloading a model with new settings still unloads it immediately, so a reply it is generating is cut off; waiting for in-flight requests before a reload is planned, not built.

Not verified: packaged app, native window chrome, and a real engine (the fixture uses synthetic engine status).

## Task systems, Agent Monitor Tasks and focus-mode clean start (2026-10-16)

- **Implemented: source priority.** The system prompt (`crates/nekko-context/src/prompt.rs`) tells the agent to use workspace folders first, then connected connectors, and only then CLI tools, unless the task is to run something.
- **Implemented — task connectors.** Linear and Jira are now tagged `category: 'tasks'`, and five new connectors are added: Trello (API key + token), Asana (PAT, workspace optional), Todoist (API token, API v1), ClickUp (personal token, workspace optional) and **Tasks file**, a local Markdown checklist (`- [ ]` lines are open tasks, grouped under the nearest heading; no token). Every one is ported to `crates/nekko-connectors` and covered by the shared golden set. All of them read only; none writes back yet.
- **Implemented — Agent Monitor Tasks.** The Tasks section only appears once at least one task connector is connected, with one tab per connected source. It lists open items, has Refresh, and clicking an item drops a prompt (title, link and details) into that chat's composer; nothing is sent until the user sends it.
- **Implemented — focus-mode clean start.** In Focused layout, an empty chat shows only a centered greeting and composer: no header, transcript, footer controls or monitor. The first send (or a question, approval or model choice) ends it, and the window becomes the full chat.
- **Planned / not done.** Completing or updating tasks from the panel; one-click OAuth for these services; a file picker for the Tasks file path; a transition animation between clean start and full chat.


## Viewport-safe configuration and steady reordering

Implemented: Configure opens in the browser top layer, outside the dock's animated clipping surface, while retaining dock descendant styles and inherited theme tokens. Its fixed position follows the anchor on scroll, resize and dock-position changes, clamped to 12px inside the viewport. A constrained menu scrolls internally. Escape closes it and restores focus to Configure; clicking outside closes it.

Implemented: reorder landing outlines use the lifted monitor's measured height, with the inter-monitor gap outside the outline. The scroll surface disables overflow anchoring and reserves its scrollbar gutter, preventing a reorder from moving the scroll origin or changing card width. Saved order and drag announcements are unchanged.

Verification: focused tests plus hidden full-App renderer captures test both side menus at 720x800, control hit-testing, Escape/outside dismissal, and synthetic DOM monitor dragging with stable scroll origin and width. A GIF records the reorder. Native drag initiation, OS focus/chrome, packaged builds and pixel-level visual inspection are not verified by this fixture. No real provider, host data or network access is used.
