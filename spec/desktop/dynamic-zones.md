---
title: "Dynamic view: zones"
area: desktop
---

# Dynamic view: zones

`[Implemented 2026-10-26 (#1204); unit-tested; checked in a hidden, off-screen Electron fixture of the real Agent board (renderer input and synthetic drag events), with inspected captures and GIFs; not yet tried by hand in the packaged app, on a phone-width board, or with a real trackpad drag from the panel]`

User intent: "there are too many at once right now. that's not how people realistically use them." The board stops opening every new agent as a window. Instead it is laid out in **zones**: places on the board that each hold one agent, which people add, move, resize and close themselves, and fill from the agents panel.

## How it works

- **Two zones to start.** A fresh board is two zones side by side. Each zone has a thin name bar ("Zone 1", "Zone 2", ...) above its window. A new zone takes the first free number.
- **No automatic windows.** New agents (including spawned sub-agents and agents created by automations) no longer open on the board by themselves; they wait in the agents panel.
- **Moving to zones from an older board.** A board saved before zones keeps only its two most recently active agents, in two side-by-side zones. Every other window is minimized: taken off the board only, never completed, stopped or deleted. A board that was never used starts with the two most recently active chats overall (an empty zone for each one missing).
- **Adding a zone.** Add-zone strips run along the board's right and bottom edges in a 14px gutter, one beside each zone touching that edge and as long as that zone's side, so the whole stretch is clickable. At rest each shows only a faint hairline; hovering fills it in the accent tint and shows its plus. Hovering one also shows a dotted preview of the new zone. Clicking adds an empty zone that fits that zone's row (right edge) or column (bottom edge), and the row or column is evened out. A short strip at the end of the edge, with a span icon and shown only when it would come out differently, adds a zone spanning the board's full height or width; Shift-clicking a row plus does the same. The 8×8 ceiling still applies.
- **The active zone.** Clicking a zone, or anything in it, makes it the active zone: the selection colour plus a heavier (2px) outline; an empty active zone gets a heavier dotted border. Selecting an agent (clicking its window, Ctrl+Tab, Ctrl+1…9) makes its zone active.
- **Changing a zone's agent.** Clicking an agent (or terminal) in the agents panel puts it in the active zone. An agent already in another zone trades places with what the active zone held, so an agent is never on the board twice. Opening an agent any other way (the toolbar, a new agent, a sub-agent from its parent's rail, another tab asking to show it) follows the same rule. In Focused view an agent already on the board is only shown, so the Dynamic board behind it does not change.
- **Dragging an agent in.** An agent row dragged out of the panel becomes a chip that looks like the row and follows the pointer. The zone under it lights up. Dropped on a zone, the chip flies into it and grows to the window's size, then the zone takes the agent and the chip fades as the window appears. Dropped anywhere else, nothing changes. With reduced motion the zone simply takes the agent.
- **Empty zones.** Closing, completing or minimizing the agent in a zone (by hand, or automatically after a successful reply, see *Minimize agent windows*) leaves the zone in place with a dotted border, the text "Empty zone", the hint "Drag in an agent chat or start a new one below.", a faded sleeping Nekko above them, and the plus menu's three options as buttons, each with a plus on its left and its keyboard shortcut on its right, the same ones the plus menu shows (Agent, in the accent colour, then Create or Edit Photos and Videos, then Terminal), each starting that kind of window in the zone. Hovering an option nudges it right and turns its plus a quarter in the accent colour; pressing squeezes it and turns the plus further. Reduced motion turns both off.
- **Moving and resizing zones.** Zones move the way windows did (*Agent board: pick up and drop windows*), now also by their name bar, and dividers between zones resize them. Dropped at a board edge, a zone now fits the row (or column) under the pointer at that end; holding Shift spans the whole side instead. A hint on the landing zone says which ("Hold Shift to span the full height" / "Spans the full height. Let go of Shift to fit the row.").
- **Closing a zone.** Right-clicking a zone's name bar offers Close zone. The agent in it is minimized, not stopped or completed. The last zone cannot be closed.
- **Intro.** The first time the Agents page shows the zoned board, a dialog walks through three short looping animations (two zones and adding a third; moving and closing a zone; changing a zone's agent from the panel, by click and by drag), each with its explanation underneath, with Back, Next and Get started. Closing it any way marks it seen for good (saved with the wall, so it is shared across the editions of one install). It is never shown on a second screen's window. With reduced motion the animations show one still frame.

## Boundaries

- Zones and the intro are renderer-only: the wall setting gains `zones`, `activeZone` and `zonesIntro`; the host stores it unchanged. No new host actions, permissions or network access.
- Minimizing, emptying or closing a zone never changes a chat's lifecycle. Only Complete and Delete do.
- The intro's animations are drawn live with Remotion's player from the app's own colour variables (they follow light and dark themes). They are silent; they fetch nothing.
- Multi-monitor: a chat made in one window and placed on another screen still opens there. New chats are no longer claimed by any screen automatically.

## Unchanged

Focused view, Fixed grid's slots (which now hold zones, empty ones dotted), the phone-width one-column stack, dividers and Snap to grid, the split compass on a window (it now adds a new zone beside it), companions, and the log drawer.

## Not done

Renaming zones, reopening the intro, and keyboard moves of zones are not built.
