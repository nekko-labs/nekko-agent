---
status: proposed
date: 2026-10-24
---

# 0019. Folding phones get posture-driven panes in the existing apps, not a tablet app or a device list

## Context

Philip asked (2026-10-24) for a new design for the folding iPhone and other folding phones: two chats at once, a Monitors pane, and vertical mode. Today iOS treats a regular width as the iPad split view (chat list beside one chat) and Android treats every width as one column. A folding phone has four postures the apps do not know about (closed, open wide, open tall, half-open tabletop or book) and sometimes a physical hinge the layout must avoid.

## Options considered

1. **A separate tablet / foldable layout tree** (`RootViewFold`, a second nav host). Pros: nothing in the phone layout can regress. Cons: two of everything (chat, composer, approval card), and the "closed" posture of a foldable is the phone layout anyway, so both trees ship on one device.
2. **Posture-driven panes inside the existing root views.** One `Posture` value (from `horizontalSizeClass` / aspect on iOS, `FoldingFeature` + window size class on Android) selects between one column, two panes side by side, two panes stacked, and the flex layout; every pane hosts the existing views unchanged. Pros: one chat view, one composer, one approval card; iPad gets the same panes for free; a hinge is one `Posture` field. Cons: `RootView` and `NekkoNavHost` grow a pane model, and the keyboard / focus rules need care.
3. **Detect devices by model name** (Fold, Flip, Duo, the folding iPhone). Rejected: Apple has not shipped the fold API, Samsung and Google already report postures through Jetpack WindowManager, and a device list is wrong on the next phone.

For the second pane's contents: only chats, or any route. Any route, because the Monitors pane and the chat list are the two things most often wanted beside a chat, and a pane that can hold one route can hold all of them.

For two computers at once: rejected for now; the relay client holds one room and one key, and two connections change battery and reconnect behaviour. Two panes are two views of one paired phone.

## Decision

Option 2. Both native apps get a `Posture` model and a two-pane host that reads it; panes hold the existing routes; the Monitors pane is a new read-only route with a capped `monitor:summary` channel that also exists on closed phones; the arrangement is remembered per computer on the phone. The Expo app gets nothing (it is being retired).

## Consequences

- iOS: the `size == .regular` branch of `RootView` becomes the pane host, so the iPad layout changes with it (chat list + chat stays the default arrangement).
- Android: `androidx.window:window` and `material3-adaptive` become dependencies; the emulator's foldable profiles join the instrumented UI tests.
- The computer gains one read-class phone channel (`monitor:summary`) with its own view in `phone-views.ts` and the Rust twin, in the phone golden.
- Until a folding iPhone exists the iOS work is verified on iPad and a faked hinge; the first device run is a release blocker named in the PRs.
- If the pane host proves heavier than the phone layout can afford (the speed contract), the fallback is to keep panes on regular width only, which is what this decision already does.
- Spec: [spec/phone/folding-phones-two-chats-and-monitors.md](../../spec/phone/folding-phones-two-chats-and-monitors.md). Tasks: FD-1 to FD-11 in [TASKS.md](../../TASKS.md).
