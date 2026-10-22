---
title: "Navigation panel, media fade and macOS app menu (2026-10-16)"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Navigation panel, media fade and macOS app menu (2026-10-16)

Implemented; focused rail geometry tests, desktop typecheck and isolated-sandbox renderer captures (CDP, separate `NEKKO_DATA_DIR`); native macOS menu and window-chrome alignment not yet checked by eye in a packaged build:

- **Left navigation panel.** `[superseded 2026-10-17 by the swoop navigation rail, see above]` The panel outline has rounded bends and each end finishes in a concave curve into the window edge. The shoulders start about 10px beyond the top and bottom destination rows, narrowing into mirrored tails with matching concave curves at the window edge. At rest the body is 52px and the tails 26px; on hover or keyboard focus the body widens to 198px and the tails to 52px together (the SVG path `d` interpolates between two outlines with matching commands). Pointing at any painted part of the panel opens it, not just the icons. The destinations sit about 20% higher (spare space split 1:4 instead of 1:3). The tails no longer reach into the title bar.
- **Composer.** Verified on a fresh profile: the wall composer's editor opens at 64px, two 20px text rows plus padding; no change needed. A height dragged by the user is still remembered.
- **Media fade.** Newly pasted or attached images, videos and file chips fade and scale in over 160ms; existing items do not re-animate; reduced motion disables it.
- **macOS app menu.** The "Nekko Agent" menu has **Settings…** (⌘,) and **About Nekko Agent**, which opens an in-app About page (Nekko Labs; pet the cat). Both go through the existing `nekko-agent://` link path (`settings`, `about`). Other platforms keep no menu bar.
- **macOS title bar.** The mark, heading and version sit 8px higher, on the traffic lights' line.
