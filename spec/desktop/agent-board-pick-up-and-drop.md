---
title: "Agent board: pick up and drop windows"
area: desktop
---

# Agent board: pick up and drop windows

`[Implemented 2026-10-24; unit-tested; checked with renderer input (sendInputEvent) in a hidden, off-screen Electron fixture of the real Agent board, before and after captures; not yet tried by hand in the packaged app]`

User intent: dragging a window should feel like picking up a card. "When first clicking, it should give a pick up animation and not move any of the boxes yet. ... make the existing spot a landing zone instead. no layout shift yet." Dragging over another window should no longer offer top, bottom, side or swap targets inside that window; instead "landing zones open" with the dragged window hovering over them, and "the landing zone should push the other agent windows out of the way". The landing zone is a dotted outline, and the card in the hand is separate from it.

How it works on the Agent board (the wall of agent windows):

- **Press to pick up.** Pressing a window's title strip (not one of its buttons) lifts it immediately. Its spot on the board turns into a dotted landing zone, exactly where the window was, and nothing else moves. A card showing only the window's icon and title leaves from the window's rectangle and shrinks into the hand under the pointer (at most 300 by 200 px, keeping the window's shape), tilted slightly so it reads as held.
- **The card stays in the hand.** It follows the pointer the whole time and never snaps into a zone. The window's content (transcript, terminal, browser) is never redrawn into the card, so a drag costs no extra rendering.
- **Landing zones open and push.** Nothing moves while the pointer stays on or within 24 px of the window's old spot. Over another window, the side of that window nearest the pointer is the target; the board lays itself out as if the window had already been dropped there, so the other windows slide and resize out of the way and the dotted zone sits where the window will land. In Dynamic, the outer 16 px of the board (inside or just outside it) docks the window along that whole side, as a full-height column or a full-width row. In the fixed Grid, and on a one-column narrow board, the target is the slot of the window under the pointer, and the two trade places.
- **Targets are read against the layout from the moment of pick-up**, not the previewed one, so a zone opening never moves the target out from under the pointer and the zones do not flicker.
- **Drop or cancel.** Releasing puts the window in the zone and saves the layout. Releasing on or near its old spot, pressing Escape, or the app losing focus puts it back unchanged.
- **Unchanged:** dragging dividers, the split compass, Focus mode (one window on screen; nothing to pick up), the eight-across ceiling, and windows inside an agent (the Agent tab's split view keeps its existing drag for now).

This replaces, on the board only, the 2026-10-13 *Board-edge landing zones* strips and the in-window drop bands with the centre "Swap" target described in *Chat & cowork: Command Center: the wall*. Swapping two Dynamic windows is now two moves; in the fixed Grid, dropping on a window still swaps.
