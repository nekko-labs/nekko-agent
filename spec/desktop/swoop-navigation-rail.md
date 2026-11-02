---
title: "Swoop navigation rail (2026-10-17)"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Swoop navigation rail (2026-10-17)

`[implemented; 14 rail geometry and source tests, 1,291 desktop tests (the one failure, a Cmd/Ctrl shortcut label in PaneFrame.test.tsx, fails the same way on main on macOS), desktop typecheck, and matched before/after captures of the full App fixture in a hidden off-screen renderer (light and dark, rest and hover, open and close motion, with and without a title bar); packaged desktop app not checked]` User intent: keep the rail's position and its icons centred a little high, but replace the shoulders and concave tails with the reference's playful curve, and have the expanded rail be one even width rather than a wide block with tails.

- **At rest** the rail's outline starts as a 3px hairline 4px below the top of the rail (just under the title bar), swoops out to the 52px icon column 10px above the first destination, runs straight beside the destinations, swoops back to a hairline 10px below the last one, and runs on as a hairline to 4px above the bottom. The lower swoop matches the upper one's length (at least 120px), so both ends read alike even though the destinations sit high (spare space still splits 1:4).
- **Open** (hover, keyboard focus inside the rail, or a `data-open` attribute on `.rail`) every point of the outline moves to x = 198px, so the whole rail becomes one even column from top to bottom with 20px rounded ends. Rest and open outlines share one command list, so the SVG path `d` morphs between them: 440ms to open, 320ms to close, on a curve with a quick start and a long settle and no overshoot. Opening waits 50ms and closing 120ms, so sweeping the pointer past never opens it and a brief slip out never snaps it shut. Pointing at any painted part of the outline keeps it open.
- **Fill:** a pale accent tint of the paper at rest; open, a tint of the surface plus a soft accent shadow on the content. The colorful icons are unchanged.
- **Labels** fade in from a 2px blur and 6px to the left as the edge passes them, top row first, 18ms apart.
- **Active destination:** one shared tile (a neutral ink wash since the 2026-11 design pass; it was a 12% accent tint with a brand-gradient notch) slides between rows when the view changes, instead of each row painting its own highlight. Where no title bar carries the brand mark (web and phone builds) the tile starts below the brand row.
- Reduced motion removes every transition. No host calls, settings, permissions or network use change.


## Wing restoration after animation simplification

Implemented; 18 focused tests, desktop typecheck, and seven hidden macOS Electron
interaction checks passed. Matched default-theme rest/open captures and sampled
opening/closing motion frames inspected; 900px and 390px layout checks passed.
Packaged builds and Windows/Linux rendering remain unverified:
the animation simplification accidentally replaced the shaped backdrop with a
rounded rectangle. Restore the upper and lower swooping wings using the existing
layout geometry, both at rest and when expanded. The SVG viewport widens from
52px to 198px with the rail; its path stays static during hover. Keep the darker,
nearly opaque paper fill, 180ms width transitions, delayed opacity-only labels,
and reduced-motion support. No path morph, animated clip, text blur, backdrop
blur, frame loop, or per-frame React state updates. Observe layout owners only
when their height changes. Hover over painted wings, keyboard focus, and pinning
must all open the rail; mobile keeps its existing navigation. Renderer-only,
with no new permissions, network requests, settings, or data access. This section
supersedes the historical morph, fill, and label-motion details above.

## Tapered ends and Send feedback under the destinations (2026-11-02)

Implemented; 19 rail geometry and source tests and the desktop typecheck pass, with
before/after rest captures of the full App fixture in a hidden off-screen renderer.
The open state was checked by its path data only (the hidden Windows renderer does
not animate the rail open, on `main` as well); packaged builds are unverified.
User intent: cut off the outline's ends that ran on as hairlines to the top and
bottom of the rail with rounded caps, and have the shape just taper out of the edge
of the window and back into it. Send feedback looked out of place alone at the
bottom of the rail, so it moves up under the last destination, set apart.

- **Outline:** the shape starts at the wall up to 160px above the first destination
  (less when there is not that much room), swells to the icon column 10px above it,
  runs beside the destinations, and tapers back into the wall below the last row,
  mirroring the upper taper (at least 120px where there is room). Nothing runs on
  past either taper: no hairline, no rounded cap. Open, the same path widens with
  the rail, as before.
- **Send feedback** sits inside the shape directly below the last destination
  (Settings by default), after a 1px divider with 16px of space above it and 12px
  below, more than the 7px row gap, so it reads as separate from the destinations.
  It is still a button that opens the Send feedback sheet, not a destination: it
  never takes the active tile and is not part of the drag-to-reorder list.
- Renderer-only. No host calls, settings, permissions or network use change.
