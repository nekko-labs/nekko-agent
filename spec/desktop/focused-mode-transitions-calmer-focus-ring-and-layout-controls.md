---
title: "Focused mode transitions, calmer focus ring and layout controls (2026-10-17)"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Focused mode transitions, calmer focus ring and layout controls (2026-10-17)

`[implemented; focused tests, desktop typecheck and production build pass; hidden network-blocked Electron fixture checks at 1400px in light and dark, with matched main/branch screenshots and sampled motion frames inspected; packaged app, narrow widths and macOS not checked]`

- **New agent fades in (Focused only).** Clicking **New agent** while the wall is Focused keeps Focused and makes the new chat the hero. That window fades and settles in (320 ms, opacity plus a slight scale) straight into its clean-start prompt ("What should we work on?"). Only windows added after the wall first renders animate; a restored wall never does. Other layouts are unchanged.
- **Composer expands into the chat.** Typing into the centred clean-start composer keeps the prompt view. The first send swaps it for the full chat, and the chat body grows out of the composer's place (420 ms). It plays once per chat, only when leaving clean start because a message was sent.
- **Calmer focus ring (Focused only).** The hero window's selection ring is accent mixed 28% into the line colour, with no glow, instead of a full-strength accent outline. Dynamic and Grid selection styling is unchanged.
- **Monitors dock header** reads **Monitors** (it read "Panels"). The Configure popover's checklist legend still reads Panels.
- **Grid moves to Settings.** The Agents toolbar shows only **Focused** and **Dynamic**; Dynamic's icon is a lightning bolt. **Settings > Command Center > Wall layout** chooses Focused, Dynamic or Grid and sets Grid rows and columns (1–6). Saved `fixed` layouts and Ctrl/Cmd+Shift+3 still open Grid, and Grid placeholders behave as before. This supersedes the toolbar Grid size picker described under 2026-10-08.
- Reduced motion turns both animations off. Renderer-only: no new settings keys, permissions or network use.

## Focused workspace and panel motion refinement

Implemented in the current change; 25 focused tests, desktop typecheck, production build, and hidden macOS Electron runtime checks pass. Matching 1400px/760px light/dark captures and timestamp-timed GIFs exist; pixel and motion inspection remain pending: Focused mode hides
individual pane title strips and removes their outer frame, so the workspace does
not read as a floating window. Other layouts retain window controls and borders.
Agents and Monitors use short reversible enter/exit transitions, with outgoing
content inert and hidden from accessibility APIs. Reduced motion skips the delay.
The navigation outline and its lower tail share the same short timing; labels
reveal together near the end of expansion, without stagger or text blur. Its
translucent tint no longer applies a backdrop blur during shape morphing.
No profile data or external permissions change.
