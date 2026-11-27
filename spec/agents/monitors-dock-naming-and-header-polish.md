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

## Local models monitor: unload, starred and recent (2026-11-20)

User intent (Philip): "I was running an image model and it didn't show the options to unload in the local models monitor. It's important we provide this. Let's show recent and a few starred models in the local models section. The user should be able to configure them or load them." This replaces the read-only rule above: the monitor now changes what is loaded, while load-time settings themselves stay on Model Server.

- **Unload from the monitor** `[implemented; unit-tested; renderer-verified in an isolated fixture]`. Every resident model on this computer has **Unload** beside **Settings**, picture models included (a picture model fills the GPU, so freeing it is the common need). **Unload all** shows when more than one model is loaded. A picture model's row says `image gen`, and its Settings jump opens its picture settings, not the context and GPU-layer drawer. A connected computer's rows keep the Unload they already had.
- **Starred and Recent** `[implemented; unit-tested; renderer-verified in an isolated fixture]`. Under the loaded models: up to 4 **Starred** models (the `nekko-engine::<id>` keys in `favoriteModels`, the same stars as the model picker) and up to 3 **Recent** ones, newest first, neither repeating a loaded model and Recent not repeating a starred one. Recent merges the models the app saw resident (kept on this device in `localStorage`, `nekko.localModels.recent`, last 20, recorded while the monitor polls and on Load) with chats whose provider is the built-in engine. Each row has a star toggle, **Settings** and **Load**. Load uses the model's saved preset, or the planner's answer when there is none (the same path as a library row's Load), and starts the engine if it is stopped, so the shortcuts show while the server is stopped too. Shown for this computer only; a watched computer keeps its *Load a model* control.
- **Settings for a model that is not loaded** `[implemented; renderer-verified in an isolated fixture]`. `openLocalModelSettings(id)` now also serves a model that is not resident: Model Server switches to its Models tab, selects that model's family (clearing any search or kind filter), and the variant list unfolds that model's drawer and scrolls to it.
- **The expert Monitor popover** reuses the same component, so it gains all of the above; its heading reads **Local models** (was *Loaded models*).
- **Known limits.** Recent only sees picture models that were in memory while the app was polling (the monitor open) or that ran from a local chat; a picture made while the monitor was closed and unloaded right after is not recorded. Recents are per device and are not synced.

Not verified: packaged app and a real engine (the fixture uses synthetic engine status and a stand-in bridge).

## Local models monitor: icon actions and a Running header (2026-11-20)

User intent (Philip): "In the local models, change the settings and load to be icons with tooltips on hover. Use the animated icons from Gentleface. Also add a header for 'running' and the subtext for 'no models are currently loaded' with an icon for relaxed/vacation."

- **Settings and Load are icons** `[implemented; unit-tested]`. Every row's **Settings** is the Gentleface cog (its `settings-ratchet` motion) and every Starred or Recent row's **Load** is `play-circle` (its `play-circle-start` motion), both played once on hover and named by a tooltip (`Settings: GPU offload, context and memory`, `Picture settings` for a picture model, `Load`). Their accessible names still carry the model's name. While a model loads, its Load icon gives way to a quiet `Loading…`. **Unload** and **Unload all** stay text.
- **Running header** `[implemented; unit-tested]`. With an engine installed, the loaded models sit under a **Running** label, the same style as Starred and Recent. When none is loaded it reads *No models are currently loaded.* beside the Gentleface `beach` (its `beach-breeze` motion plays on hover); when the server is stopped it says so under the same header. No header without an engine.

Not verified: packaged app and a real engine.

## Local models monitor: Recent only, by name (2026-11-28)

User intent (Philip): "In the local models monitor, remove the starred models section. In the recent ones, simplify and just show the name, remove the second detail line." This replaces the Starred half of *Starred and Recent* above.

- **No Starred group** `[implemented; unit-tested]`. The monitor no longer lists starred models, and its rows (loaded and recent) have no star toggle. Stars themselves are unchanged and still drive the model picker's Starred section.
- **Recent rows are the name alone** `[implemented; unit-tested]`. Each Recent row shows the model's name with its **Settings** and **Load** icons; the line of kind, parameter size, quantization and file size under it is gone. Recent still holds up to 3 models, newest first, never a loaded one; a starred model now shows in Recent like any other.

Not verified: packaged app and a real engine.

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

## Movement-gated header pickup

Implemented: a primary-button press on a monitor header only arms pickup. The same pointer must move before native dragstart may lift the card or open a landing preview. Stationary presses, unrelated pointers, release, cancellation and focus loss cannot authorize a later drag. Header buttons do not arm pickup; keyboard reordering is unchanged. No host data or network access is added. Verified with focused regression tests and isolated Windows Electron DOM interactions; physical OS drag initiation and other operating systems remain unverified.

## Quiet buttons and a denser dock (2026-11-19, #3025)

User intent (Philip): nothing in a monitor wears a button box; the header's minimize and close are Gentleface icons that play on hover; the CI runner's Completed row has room above it; every monitor is denser, so more fit in view and the dock needs less width.

- **Quiet buttons** `[implemented; unit-tested; renderer-verified in an isolated fixture]`. The dock's boxed button style covers only its own controls (Configure, the position and Budget range buttons). The monitor header's icons, the show/hide pill and everything inside the Automations monitor (the runner's settings gear, Completed, View CI runners, task actions) keep the app's ghost look. The header icons brighten on hover with no tile behind them.
- **Gentleface close and minimize** `[implemented; unit-tested]`. Gentleface `x` and `minus`; neither has upstream motion, so each has a local one-shot motion over the licensed artwork (the x turns a quarter, the minus dips). Every settings cog plays Gentleface's `settings-ratchet` once on hover.
- **Completed spacing** `[implemented; renderer-verified]`: 8px between the running jobs and the Completed row in the panel.
- **Density** `[implemented; renderer-verified]`. Side docks default to 248px (was 276) with a 220px minimum (was 260); monitors sit 8px apart (was 12) with 12px corners; headers are 4px by 8px with 24px icon buttons; monitor bodies use 8px by 12px padding, 8px gaps and the extra-small type step; hardware meters keep label, bar and reading 4px apart and meters 12px apart. In the synthetic fixture the five default monitors stack 1457px tall at 248px, against 1608px at 276px before. The toolbar stays on one line at the default width.

Not verified: packaged app, native window chrome, real runner and provider data (the fixture is synthetic).


## Height resize above and below the wall (2026-11-26)

User intent (Philip): when the monitors dock sits at the top or bottom, it gets the same kind of resize bar the side positions have, to make it taller or shorter.

- **Edge handle** `[implemented; unit-tested; renderer-verified in an isolated fixture]`. Docked at the top or bottom, the dock's edge facing the wall is a horizontal handle: the same thin accent grip as the side handle, shown on hover, focus or drag, with a row-resize cursor. Dragging it moves the dock's ceiling. Left and right docks keep their width handle; there is only ever one.
- **Limits.** The dock stays as tall as its monitors, up to the dragged height, so a short dock never gains empty space. The default ceiling is 360px (unchanged), the smallest is 120px, and it grows only until every monitor in the row shows its whole body, leaving the wall at least 240px. A drag within 20px of 360px snaps to it.
- **Keyboard and reset.** The handle is a focusable separator: Arrow Up and Down move the edge 24px in the direction they point, Home or a double-click returns to 360px.
- **Not saved.** Like the side width, the height is local to the mounted view and resets when the dock remounts. Narrow layouts (under 768px) keep their fixed height and show no handle.

Not verified: packaged app, native window chrome, real provider data (the fixture is synthetic).
