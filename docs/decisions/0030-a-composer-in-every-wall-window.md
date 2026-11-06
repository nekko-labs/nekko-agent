---
status: accepted
date: 2026-10-28
---

# 0030. Give every wall window its own composer

## Context

Since 2026-10-05 the Agents wall had one composer for the whole wall: agent windows showed transcripts only, and a single docked composer spoke for the selected window, tied to it by a tether and a ring. In use it asked for a selection before every message, it was not obvious which agent a message went to, and the dock, size and tether controls added chrome the user wants gone ("minimal borders and clean lines"). Issue #1317.

## Options considered

1. **Keep the shared composer**: one editor, least vertical space. Cons: the selection step and the "who am I talking to" doubt stay.
2. **Floating pill per column** (a rounded composer over each window's transcript, hairline dividers instead of cards): clean, but relies on dividers and a tint to show where a window ends, and covers the transcript's tail.
3. **A composer at the foot of every window**, the selected one open and the others resting as one row: each window owns its draft, controls and plan.

## Decision

Option 3. It removes the selection step and the doubt, keeps drafts where they were typed, and lets the plan sheet sit on the composer it belongs to. Resting composers keep the cost in vertical space to one row per unselected window.

## Consequences

- Every tiled chat mounts the full chat pane instead of a transcript; walls with many windows render more. Watch frame time on large walls.
- The shared composer's code, dock settings and capture scripts are dead and need removing.
- Model and Mode move onto each composer's bar; effort and privacy switches live only in the Mode panel there.
