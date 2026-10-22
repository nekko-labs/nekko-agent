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
- **Active destination:** one shared tile (a 12% accent tint with the brand-gradient notch on the wall) slides between rows with a small spring when the view changes, instead of each row painting its own highlight. Where no title bar carries the brand mark (web and phone builds) the tile starts below the brand row.
- Reduced motion removes every transition. No host calls, settings, permissions or network use change.
