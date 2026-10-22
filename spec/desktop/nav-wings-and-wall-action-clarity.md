---
title: "Nav wings and wall action clarity"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Nav wings and wall action clarity

Implemented; 49 focused tests and desktop typecheck passed, isolated Electron Focus/Minimize and rail keyboard checks passed, matched wide/narrow light/dark captures inspected: the left rail retains its destination positioning and existing rest/hover tint. Its curved top and bottom wings each have a height about half the band width (32px at rest, 100px expanded), independent of destination count. Wall creation icons have bottom-right plus indicators, increased spacing, and a subtle divider separating creation from layout modes. Window Focus is a 20px accent-colored action immediately before Minimize, outside the pane's portalled action group. Existing creation, focus and minimize behavior and privacy boundaries are unchanged. Acceptance: wide/narrow light/dark matched captures, keyboard rail expansion, Focus adjacency and Focus/Minimize behavior; native OS chrome is outside this renderer-only change.
