---
title: "Folding phones: two chats at once, a Monitors pane and vertical mode (2026-10-24)"
area: phone
---

# Folding phones: two chats at once, a Monitors pane and vertical mode (2026-10-24)

`[implemented 2026-10-24, FD-1..10, not verified on a folding phone: the `monitor:summary` channel, the posture models, the iOS panes, two chats, Monitors and tabletop layout (NekkoKit tests run in a Linux Swift container; the SwiftUI never built), the Android panes, two chats, Monitors, tabletop and book postures (pure-JVM parts tested; the app module never compiled, instrumented tests not run), and the docs page. No screenshots yet. Each pane UI shows the owner's note that the developers had no foldable phone to test with (FD-11 is the hardware check)]`  Asked for by Philip on 2026-10-24: a new design for the folding iPhone and other folding phones (Galaxy Z Fold, Pixel Fold, Surface Duo, OnePlus Open, Z Flip when open): two chats at once, a Monitors pane, and support for vertical mode. Decision record: [docs/decisions/0019-folding-phones-get-panes-not-a-new-app.md](../../docs/decisions/0019-folding-phones-get-panes-not-a-new-app.md). Tasks: FD-1 to FD-11 in [TASKS.md](../../TASKS.md). Layout prototype (self-contained HTML, every posture, light and dark): [reports/folding-phones-layout-prototype.html](../../reports/folding-phones-layout-prototype.html).

## User intent

Unfolded, these phones are a small tablet (7 to 8 inches, nearly square) and today both apps treat that as either a big phone (one column, stretched) or, on iOS when the size class is regular, the iPad split view (chat list beside one chat). Neither uses the space the way the desktop's Agent board does. The owner wants to watch two chats run side by side, keep the computer's Monitors beside a chat, and have all of this work whether the phone is held wide or tall, half-folded on a table, or closed to its outer screen.

## Postures

The layout is driven by **posture**, read from the system (iOS: `horizontalSizeClass` / `verticalSizeClass` plus the window's aspect; Android: Jetpack WindowManager `FoldingFeature` with `state` and `orientation`), never from a device list:

| Posture | Example | Layout |
| --- | --- | --- |
| **Closed** (outer screen, compact) | Fold's cover screen, Flip closed, any phone | Today's one-column app, unchanged. |
| **Open, wide** (regular width, landscape or near-square) | Fold / Pixel Fold / folding iPhone open, held wide | **Two panes side by side**, a divider on the hinge where there is one. |
| **Open, tall** (regular width, portrait; "vertical mode") | Fold open and rotated, Surface Duo tall | **Two panes stacked**, the top pane the primary chat, the bottom pane the second chat or Monitors. |
| **Half-open, tabletop** (hinge horizontal, `FoldingFeature.State.HALF_OPENED`) | Flip / Fold resting on a table | **Flex layout**: transcript on the upper half, composer, approval cards and the keyboard on the lower half; nothing straddles the hinge. |
| **Half-open, book** (hinge vertical, half opened) | Fold held like a book | Same as open, wide; the divider snaps to the hinge. |

`[implemented 2026-10-24, FD-2; Swift tests run in a Linux Swift container and Kotlin tests run outside Gradle on 2026-10-24 (FD-3, FD-7)]` The rules, in both `Posture.swift` (NekkoKit) and `Posture.kt` (`apps/android/protocol`, pure JVM so it is tested without an Android runtime), held to one fixture (`apps/ios/Protocol/Tests/NekkoKitTests/Fixtures/posture.json`, copied to `apps/android/protocol/src/test/resources/`): under 600 pt / dp wide, a compact width class, or a compact height class (a big phone on its side) is **closed**; a half-opened hinge is **tabletop** when horizontal and **book** when vertical (on iOS the orientation is read from the hinge rect: as tall as wide or taller is vertical); otherwise, flat hinge or none, height over width above 1.3 is **open, tall** and anything squarer is **open, wide**. A separating hinge (Surface Duo) follows the same rules. On iOS the hinge comes from one injectable function (`Posture.hingeSource`, nil until Apple ships a fold API).

A posture change animates the panes rather than rebuilding them: a chat that was in the right pane stays scrolled where it was when it moves to the bottom pane. Below 600 pt of width the app is always closed-posture, so a Flip's open inner screen in portrait stays one column.

## Panes

Open postures show two panes. Each pane holds one **pane content**:

- **Chat**: a chat, exactly today's ChatView with its own composer, scroll position, pending approval and queue. Two chat panes are two independent chats on the same computer (two computers at once is out of scope: the relay client holds one connection, see *Not in scope*).
- **Monitors**: a phone edition of the desktop's Agent Monitor dock, read only: the computer's **Hardware** rows (CPU, GPU and memory load and temperatures, the same `monitor:*` readings the desktop shows, over a new read-class `monitor:summary` channel capped like the other phone views), **Running** (every working chat, its step and elapsed time, tap to open it in the other pane), **Needs you** (approvals and questions across chats, with Allow / Deny / answer inline, going through the same `tool:approve` and `chat:answer` calls as the chat itself) and **Automations** (the next scheduled runs). It refreshes from the events the phone already receives plus one `monitor:summary` poll every 10 s while visible; it never polls in the background.
- **Chats** (the list), **New chat**, and the rest of the routes (Files, Git, Terminals, Settings) can also fill a pane, so "chat list left, chat right" (today's iPad layout) is one of the arrangements rather than the only one.

**Arrangements** the owner picks from a pane's header menu, or by dragging a chat from the list onto a pane: *Chat + Chat*, *Chat + Monitors*, *Chats + Chat* (the iPad default today), and *Monitors + Chats*. The last arrangement and its contents are remembered per computer and restored when the phone is opened. The default on first open is *Chats + Chat*; the first time the owner opens a second chat while one is running, a one-line tip offers *Chat + Chat*.

A pane's header shows its chat's title, status dot and the usual chat menu, plus **Swap** (the two panes trade places), **Focus** (that pane fills the screen; the other collapses to an edge tab, as the desktop's window minimize) and **Replace with…** (Monitors, Chats, another chat). The divider is draggable between 35 / 65 and 65 / 35 on hinge-less screens and fixed on the hinge where there is one.

**Keyboard and composer.** Only the focused pane's composer takes the keyboard; the other pane shrinks above it so its transcript stays visible (it does not scroll under the keyboard). In tabletop posture the keyboard sits on the lower half under that half's composer.

**Approvals and questions.** A pending approval in the unfocused pane pulses its status dot and shows the card at the pane's bottom; the Live Activity and notifications are unchanged. Allowing from a pane follows today's rule (unlocked phone).

**Drag between panes.** A message, a file from Files, or an image can be dragged from one pane into the other's composer (SwiftUI `draggable` / `dropDestination`; Compose `dragAndDropSource` / `dragAndDropTarget`). Text only lands as text in the composer; nothing is sent by a drop.

**Monitors on a closed phone.** The Monitors pane content also exists as a tab on the closed-posture app (bottom of the chat list, as *Monitors*), so the feature is not foldable-only. On iPhone it is a route (`.monitors`); on Android a destination in `NekkoNavHost`.

### `monitor:summary` (FD-1, implemented 2026-10-24)

`[implemented 2026-10-24, FD-1; unit-tested (packages/shared phone-views.test.ts, crates/nekko-remote phone_views.rs) and in the phone golden; no phone calls it yet]` A read-class phone channel (refused `read-off` with Read off). The computer answers it in the phone gate from the reads it already serves for its own Monitors dock, in this order: `system:stats`, `gpu:stats`, `chat:running`, `sessions:summaries`, `chat:pending`, `tasks:list`, `workflows:list` (`PHONE_MONITOR_SOURCES`); the phone's arguments are ignored. The daemon (`crates/nekko-remote/src/phone_views.rs`) and the TS edition (`packages/shared/src/phone-views.ts`, `phoneMonitorView`) project it the same way:

- `hardware`: `cpu` (`loadPct`, `cores`, `tempC` when there is a sensor), `memory` (`usedMB`, `totalMB`, `tempC`), `gpu` (`loadPct` of the busiest device, `tempC` of the hottest, `memoryUsedMB`, `memoryTotalMB`, `unified` on Apple Silicon), or `null` without a GPU probe or sensor. No CPU or GPU model names, no process names, no paths.
- `running`: each working chat's `id`, `title`, `step` (`approval`, `question` or `working`) and `elapsedMs` since its turn started (`activeRun.startedAt`; a start ahead of the computer's clock reads 0), at most 20.
- `needsYou`: each pending approval (`sessionId`, `title`, `kind: "approval"`, `callId`, `risk` low / medium / high, `label` = the tool's name, `since`) and question (`kind: "question"`, `callId`, `label` = its first question, `count`, `since`), oldest first, at most 20. Never a tool's input or the approval's reason.
- `automations`: the next runs of active tasks and enabled workflows (`kind`, `id`, `name`, `nextRunAt`), soonest first, at most 10.

Titles and labels are cut to 120 UTF-16 units (`PHONE_MONITOR_VIEW`). The step label is coarse for now: the computer does not yet name the tool a working chat is running.

## Vertical mode

"Vertical" means the open, tall posture and the tabletop posture:

- Open, tall: panes stack, primary on top. The chat list is never the bottom pane (a list under a chat reads as the chat's attachments); *Chats + Chat* becomes *Chat over Monitors* with the list reachable from the top pane's back button.
- Tabletop: the pane that has the keyboard focus takes the whole screen in flex layout; the other pane is an edge tab until the phone is opened flat or picked up.
- Rotation while two chats are open keeps both chats; the primary (top or left) is the pane that was focused.

## Platforms

- **iPhone (folding model)**: SwiftUI. `RootView`'s `size == .regular` branch becomes a `PanesView` that reads a `Posture` environment value; the hinge is read from `UIScreen` / the scene's `interfaceOrientation` and, when Apple exposes it, the fold API in the SDK of the year the phone ships (the posture model is written so the hinge source is one function). Until a folding iPhone exists, the same code is exercised on iPad (every open posture without a hinge) and in the simulator with a hinge faked by a launch argument for the UI tests.
- **Android**: Compose with `androidx.window:window` (`WindowInfoTracker.windowLayoutInfo` → `FoldingFeature`) and `material3-adaptive`'s `calculateWindowSizeClass`; a `Posture` state the nav host reads. Samsung's Flex mode and Pixel Fold tabletop both arrive as `HALF_OPENED` with a horizontal hinge. Surface Duo's two screens arrive as a `FoldingFeature` with `isSeparating`, so the divider is the gap. Tested with the emulator's foldable profiles (7.6" Fold-in, 8" Fold-out, Surface Duo) in the instrumented UI tests.
- **Former Expo app**: removed; no posture work.
- **Desktop and Local Web UI**: unchanged; the desktop already has the Agent board and the Monitors dock.

## Acceptance criteria

- On an open, wide posture two chats stream at the same time, each with its own composer, queue and approval card; sending in one does not touch the other (one `RelayClient`, one connection, requests are already keyed by chat).
- Rotating to open, tall stacks the same two chats with scroll positions kept (UI test: scroll, rotate, assert the offset).
- Half-open tabletop puts the transcript above the hinge and the composer and keyboard below it, with no control under the hinge line (asserted against the `FoldingFeature` bounds on Android, the faked hinge on iOS).
- Closing the phone returns to the one-column app on the chat that was focused; opening it restores the last arrangement.
- The Monitors pane shows hardware load and temperatures from `monitor:summary` (read class, capped, in the phone golden), the running chats, pending approvals across chats, and the next automations; Allow / Deny from it behaves as in the chat; with Read off it shows *read is off for this phone*.
- Dragging text from one pane to the other's composer inserts it without sending.
- Nothing new is sent to the relay or stored on the computer beyond `monitor:summary` reads and the existing calls; the arrangement is phone-local.
- Visual evidence per [docs/runbooks/visual-evidence.md](../../docs/runbooks/visual-evidence.md): every posture in light and dark from the foldable emulator profiles and the iPad simulator.

## Security boundaries

Two panes are two views of one paired phone: the Read / Change switches, the Change proof and the step-up ([hardware keys spec](../platform/hardware-keys-step-up-and-remote-sign-out.md)) apply per call as before. The Monitors pane's `monitor:summary` is a read-class channel with its own capped view (no process names, no file paths, no model names tied to chats: load, temperatures and the chat summaries the phone may already see). With the app lock on, the cover window hides both panes.

## Not in scope

Two computers at once (one pane per computer): the relay client holds one room and one key; a second connection is a separate feature with its own battery and reconnect rules. Dragging a chat between two phones or to the desktop. A hinge-aware layout for the Watch. A three-pane layout on tablets (the desktop's Agent board is the answer there).
