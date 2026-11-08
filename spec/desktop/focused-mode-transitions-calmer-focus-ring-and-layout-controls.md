---
title: "Focused mode transitions, calmer focus ring and layout controls (2026-10-17)"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Focused mode transitions, calmer focus ring and layout controls (2026-10-17)

`[implemented; focused tests, desktop typecheck and production build pass; hidden network-blocked Electron fixture checks at 1400px in light and dark, with matched main/branch screenshots and sampled motion frames inspected; packaged app, narrow widths and macOS not checked]`

- **New agent fades in (Focused only).** Clicking **New agent** while the wall is Focused keeps Focused and makes the new chat the hero. That window fades and settles in (240 ms since 2026-11-01, opacity plus a slight scale) straight into its clean-start prompt ("What should we work on?"). Only windows added after the wall first renders animate; a restored wall never does. Other layouts are unchanged.
- **The old hero collapses into the new composer (Focused only, added 2026-10-23).** As the new window fades in, the window it replaces stays drawn on top, shrinks to the new chat's composer box (measured, so it lands exactly on the composer; a centred composer-sized box if it cannot be measured) and dissolves into it (260 ms since 2026-11-01, clip plus opacity, no scaling of the old transcript). It then parks as before. Switching hero again mid-collapse drops it. `[implemented; hidden Electron sandbox checks in light and dark at 1400px, sampled frames inspected; packaged app and narrow widths not checked]`
- **Composer expands into the chat.** Typing into the centred clean-start composer keeps the prompt view. The first send swaps it for the full chat, and the chat body is revealed out of the composer's rectangle (a 260 ms clip-path, since 2026-11-01; it used to stretch from a squashed scale over 420 ms). It plays once per chat, only when leaving clean start because a message was sent.
- **Calmer focus ring (Focused only).** The hero window's selection ring is accent mixed 28% into the line colour, with no glow, instead of a full-strength accent outline. Dynamic and Grid selection styling is unchanged.
- **Monitors dock header** reads **Monitors** (it read "Panels"). The Configure popover's checklist legend still reads Panels.
- `[superseded 2026-10-24 by Fixed grid, below]` **Grid moves to Settings.** The Agents toolbar shows only **Focused** and **Dynamic**; Dynamic's icon is a lightning bolt. **Settings > Agent board > Wall layout** chooses Focused, Dynamic or Grid and sets Grid rows and columns (1–6). Saved `fixed` layouts and Ctrl/Cmd+Shift+3 still open Grid, and Grid placeholders behave as before. This supersedes the toolbar Grid size picker described under 2026-10-08.
- **Grid becomes Dynamic's Fixed grid (2026-10-24).** User intent (Philip): "remove the grids layout option... Instead, the dynamic mode should keep the magnetic option and a fixed grid style toggle in the settings page." There are two layouts, **Focused** and **Dynamic**; Grid is no longer a mode anywhere (toolbar, Settings, shortcuts). **Settings > Agents wall** has a **Fixed grid** checkbox: on, Dynamic lays windows out in even rows and columns (Grid rows and columns, 1-6, enabled only while it is on, with the same empty-cell placeholders); off (the default), Dynamic is the free-form split tree. The snap magnet shows only in free-form Dynamic, since a fixed grid is already even. Ctrl/Cmd+Shift+3 does nothing now. A wall saved in the old Grid mode (`mode: 'fixed'`) opens as Dynamic with Fixed grid on (`layout.fixedGrid`), keeping its rows and columns. `[implemented; unit-tested (migration, settings, toolbar, geometry); hidden Electron fixture screenshots in light and dark; packaged app not checked]`
- **Title bar spacing and a coloured magnet (2026-10-24).** User intent: "the top icons need proper spacing. fix the magnetic icon to be colored... give the magnet icon the little spark at the end." Every control in the Agents title bar row sits on one 8px step: the layout switch, the magnet, the Screens button, and the developer server controls (which had no gap before them). The magnet is drawn in its own colours, a red horseshoe with steel poles, muted while off; switched on it is full strength and throws small amber sparks off both pole tips. `[implemented; hidden Electron fixture screenshots, light and dark, against main]` `[recoloured 2026-10-25]` User intent: "switch the magnet icon back to following the theme colors." The magnet keeps its shape and sparks but is drawn in the theme's ink again: faint while off, full ink on hover, the accent while on (sparks only while on).
- **Toolbar hover motion (2026-10-28).** User intent: "when hovering the plus, have the dropdown fast fade in. When hovering over the focused/dynamic layout, have it like the selected is moving with the mouse, but not committed." The plus menu (and the sidebar's create menu, which shares its style) fades and drops in over 120 ms when hover opens it. In the Focused / Dynamic switch the selected pill slides (200 ms) under whichever option the pointer is over and that option's label brightens; it slides back when the pointer leaves. Only a click changes the layout. `[implemented; hidden Electron fixture checks with the animations stepped frame by frame; packaged app not checked]`
- Reduced motion turns all three animations off. Renderer-only: no new settings keys, permissions or network use.

## Focused workspace and panel motion refinement

Implemented in the current change; 25 focused tests, desktop typecheck, production build, and hidden macOS Electron runtime checks pass. Matching 1400px/760px light/dark captures and timestamp-timed GIFs exist; the parent inspected matching stills and sampled motion frames (not a frame-rate benchmark): Focused mode removes
the pane's outer frame, so the workspace does not read as a floating window. (It
hid the title strip too until 2026-11-06, see below.) Other layouts retain window
controls and borders.
Agents and Monitors use short reversible enter/exit transitions, with outgoing
content inert and hidden from accessibility APIs. Reduced motion skips the delay.
The navigation outline and its lower tail share the same short timing; labels
reveal together near the end of expansion, without stagger or text blur. Its
translucent tint no longer applies a backdrop blur during shape morphing.
No profile data or external permissions change.

## Title strip in Focused (2026-11-06)

User intent: "in focused view the top bar with information and controls are missing add them."

`[implemented; unit-tested; hidden Electron fixture checks and screenshots at 1400px in light and dark and 760px in light; packaged app and macOS not checked]`

- The Focused window shows the same title strip as a Dynamic window: Nekko with its status badge, chat name, branch, Find, Changes, Files, Browser, Logs, Minimize and Complete. The window stays unframed.
- **No window number in Focused.** User intent: "i dont need the number on the left for the focused view." The number tells tiled windows apart, and Focused shows one.
- **Clean start is unchanged.** An untouched new chat keeps its quiet page with no strip, so the composer does not move. The strip arrives with the first send.
- **No Zen button in Focused.** The window is already focused, so it would do nothing.
- **The strip does not move the window.** Focused shows one window, so the strip has no grab cursor, no "Drag to move" tooltip and no drag.
- With both side panels open in a very narrow app window (760px leaves the chat about 210px), the strip's right-hand controls clip. Their keyboard shortcuts still work.

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

## Consolidated View dropdown

Implemented; 102 focused tests and desktop typecheck pass. Matching 1440px/460px dark-theme captures were inspected; 15 isolated Electron checks cover layout/snap/dismissal, keyboard opening and focus return, screen-toggle and placement bridge callbacks, and 460×400 short-window scrolling. Desktop production build passes. Physical display placement and packaged builds have not been exercised.

The Agents toolbar has a **View** button immediately to the right of **+**. Its viewport-bounded dropdown consolidates **Single agent** (formerly Focused), **Multi-agent** (formerly Dynamic), **Snap to grid**, and desktop screen/desktop selection and new-agent placement. Screen controls are embedded, not another nested popup; the Local Web UI omits desktop-only controls. The dropdown opens by click or keyboard, closes on Escape/outside click or focus leaving, and scrolls within short windows. Single/Multi-agent retain the saved `focus`/`grid` keys and Cmd/Ctrl+Shift+1/2 shortcuts. This changes how many agents are visible, not how many may run.

### View panel visual hierarchy

Implemented in source; visual review pending. Seventy focused tests, desktop typecheck, the production app build, and 25 isolated Windows Electron interaction/layout checks pass. Matched default-dark-theme captures exist at 1440/768/460/320 widths and a short window. Browser screenshot inspection timed out, the capture tool returned `UnknownVizError`, and native capture did not expose the hidden fixture, so captured pixels have not been inspected and this redesign is not yet verified for landing. The View trigger is a quiet, borderless toolbar control with an original single-pane or tiled-pane glyph reflecting the current layout and an SVG chevron. Keyboard focus still receives a visible accent outline. The panel leads with **Workspace view** and two illustrated radio cards: **Single agent / One chat at a time** and **Multi-agent / Chats side by side**, with the existing shortcuts below. Selection uses a restrained accent tint, not a bright outline around the toolbar button.

**Snap to grid** is a secondary switch with an explanatory disabled state. A single connected display appears as a compact **Screen 1 / Main screen · always on / Connected** status row instead of an oversized locked tile. Multiple displays retain their proportional toggles with a visible explanation of what selecting them does. **Open new agents** uses **Spread across screens** and **Prefer main screen**, retaining the existing `empty-first` and `main-first` values. With one display, the panel explains that this preference applies when more screens are connected. macOS desktop controls and their permission boundaries are unchanged.

Acceptance: native radio/switch semantics, readable descriptions, no horizontal panel overflow at 320/460/768/1440 CSS pixels, internal scrolling in short windows, the same screen-toggle/placement callbacks, and no new permissions or external calls. These responsive widths include folded/unfolded-sized viewports, not a claim of native foldable-device testing. Visual inspection of captured before/after evidence is required before landing.

Snap to grid remains available only in free-form Multi-agent; Single agent and Fixed grid disable it without clearing the saved preference. The divider's magnetic capture range is reduced by 25%, from 4% to 3% of its containing split on either side of an evenly spaced boundary. Pane sizes, equal-spacing targets and persistence do not change.

Acceptance: View follows + at wide/narrow widths; selection and snap controls update the existing wall; screens and placement call the existing bridge; Escape restores trigger focus; the popover fits the viewport; a divider within 2.9% snaps and one 3.5% away does not. No new data access, network calls, OS permissions or automatic monitor changes are introduced. Actual physical multi-monitor window placement remains the existing implementation, not a new capability.
