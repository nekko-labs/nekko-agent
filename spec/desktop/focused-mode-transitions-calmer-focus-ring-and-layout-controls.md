---
title: "Focused mode transitions, calmer focus ring and layout controls (2026-10-17)"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Focused mode transitions, calmer focus ring and layout controls (2026-10-17)

`[implemented; focused tests, desktop typecheck and production build pass; hidden network-blocked Electron fixture checks at 1400px in light and dark, with matched main/branch screenshots and sampled motion frames inspected; packaged app, narrow widths and macOS not checked]`

- **New agent fades in (Focused only).** Clicking **New agent** while the wall is Focused keeps Focused and makes the new chat the hero. That window fades and settles in (320 ms, opacity plus a slight scale) straight into its clean-start prompt ("What should we work on?"). Only windows added after the wall first renders animate; a restored wall never does. Other layouts are unchanged.
- **The old hero collapses into the new composer (Focused only, added 2026-10-23).** As the new window fades in, the window it replaces stays drawn on top, shrinks to the new chat's composer box (measured, so it lands exactly on the composer; a centred composer-sized box if it cannot be measured) and dissolves into it (380 ms, clip plus opacity, no scaling of the old transcript). It then parks as before. Switching hero again mid-collapse drops it. `[implemented; hidden Electron sandbox checks in light and dark at 1400px, sampled frames inspected; packaged app and narrow widths not checked]`
- **Composer expands into the chat.** Typing into the centred clean-start composer keeps the prompt view. The first send swaps it for the full chat, and the chat body grows out of the composer's place (420 ms). It plays once per chat, only when leaving clean start because a message was sent.
- **Calmer focus ring (Focused only).** The hero window's selection ring is accent mixed 28% into the line colour, with no glow, instead of a full-strength accent outline. Dynamic and Grid selection styling is unchanged.
- **Monitors dock header** reads **Monitors** (it read "Panels"). The Configure popover's checklist legend still reads Panels.
- `[superseded 2026-10-24 by Fixed grid, below]` **Grid moves to Settings.** The Agents toolbar shows only **Focused** and **Dynamic**; Dynamic's icon is a lightning bolt. **Settings > Agent board > Wall layout** chooses Focused, Dynamic or Grid and sets Grid rows and columns (1–6). Saved `fixed` layouts and Ctrl/Cmd+Shift+3 still open Grid, and Grid placeholders behave as before. This supersedes the toolbar Grid size picker described under 2026-10-08.
- **Grid becomes Dynamic's Fixed grid (2026-10-24).** User intent (Philip): "remove the grids layout option... Instead, the dynamic mode should keep the magnetic option and a fixed grid style toggle in the settings page." There are two layouts, **Focused** and **Dynamic**; Grid is no longer a mode anywhere (toolbar, Settings, shortcuts). **Settings > Agents wall** has a **Fixed grid** checkbox: on, Dynamic lays windows out in even rows and columns (Grid rows and columns, 1-6, enabled only while it is on, with the same empty-cell placeholders); off (the default), Dynamic is the free-form split tree. The snap magnet shows only in free-form Dynamic, since a fixed grid is already even. Ctrl/Cmd+Shift+3 does nothing now. A wall saved in the old Grid mode (`mode: 'fixed'`) opens as Dynamic with Fixed grid on (`layout.fixedGrid`), keeping its rows and columns. `[implemented; unit-tested (migration, settings, toolbar, geometry); hidden Electron fixture screenshots in light and dark; packaged app not checked]`
- **Title bar spacing and a coloured magnet (2026-10-24).** User intent: "the top icons need proper spacing. fix the magnetic icon to be colored... give the magnet icon the little spark at the end." Every control in the Agents title bar row sits on one 8px step: the layout switch, the magnet, the Screens button, and the developer server controls (which had no gap before them). The magnet is drawn in its own colours, a red horseshoe with steel poles, muted while off; switched on it is full strength and throws small amber sparks off both pole tips. `[implemented; hidden Electron fixture screenshots, light and dark, against main]` `[recoloured 2026-10-25]` User intent: "switch the magnet icon back to following the theme colors." The magnet keeps its shape and sparks but is drawn in the theme's ink again: faint while off, full ink on hover, the accent while on (sparks only while on).
- Reduced motion turns all three animations off. Renderer-only: no new settings keys, permissions or network use.

## Focused workspace and panel motion refinement

Implemented in the current change; 25 focused tests, desktop typecheck, production build, and hidden macOS Electron runtime checks pass. Matching 1400px/760px light/dark captures and timestamp-timed GIFs exist; the parent inspected matching stills and sampled motion frames (not a frame-rate benchmark): Focused mode hides
individual pane title strips and removes their outer frame, so the workspace does
not read as a floating window. Other layouts retain window controls and borders.
Agents and Monitors use short reversible enter/exit transitions, with outgoing
content inert and hidden from accessibility APIs. Reduced motion skips the delay.
The navigation outline and its lower tail share the same short timing; labels
reveal together near the end of expansion, without stagger or text blur. Its
translucent tint no longer applies a backdrop blur during shape morphing.
No profile data or external permissions change.

## Subtle focus surface and push panels (2026-10-24)

Implemented and verified with 25 focused tests, desktop typecheck and production build, plus hidden macOS Electron light/dark 1400px/760px captures and sampled motion frames. Mid-transition layout width and rapid reversal checks pass. Packaged builds and other platforms remain unverified:
- Focused chat surfaces use 35% theme-paper tint over the workspace, with 24px
  rounded corners. The existing native CSS squircle enhancement remains; no SVG
  mask, blur or JavaScript corner rendering is added. Unsupported renderers use
  ordinary rounded corners. No measured frame-time claim is made.
- Agents and Monitors slide from their edge while their layout space expands or
  collapses over 220ms, pushing the chat toward the middle. Horizontal panel
  configurations use vertical motion. Exit retention matches the CSS duration;
  outgoing panels remain inert and hidden to assistive technology. Reduced
  motion skips transitions and exit retention.
- The left navigation is a rounded, approximately 90%-height surface, using
  theme paper darkened with 8% black at 97% opacity. Expansion and a single label
  opacity reveal replace SVG path/clip morphing and geometry observation.
  Hover, visible keyboard focus and pin all open the same panel. No new setting,
  network request, profile access or permission is introduced.
- Acceptance: matched light/dark 1400px and 760px captures, simple navigation
  reveal, panel enter/exit and rapid reversal checks, focused tests, typecheck
  and production build. Packaged builds and non-macOS platforms remain unverified.
