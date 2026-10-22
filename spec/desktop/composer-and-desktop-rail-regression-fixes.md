---
title: "Composer and desktop rail regression fixes (2026-10-07)"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Composer and desktop rail regression fixes (2026-10-07)

Implemented; focused tests and isolated renderer interactions are required before release, with matching visual inspection still pending. The shared composer wrapper is transparent and has no outer shadow, removing the redundant square behind the rounded editor while retaining the editor surface and header. The send-cat control has a 4px right margin. Desktop builds with app chrome omit the duplicate brand row above navigation; web builds without chrome retain their identity row. The Agent navigation icon itself remains. Acceptance: Add hover/focus never reflows cards, click opens creation; composer and send controls remain reachable in wide/narrow light/dark layouts. No new reads, network access, permissions, or changes to persisted user data.

PR 364 follow-up: width observers consume delivered ResizeObserver widths rather than forcing another layout read; cold mounting still performs one bootstrap read. Focused width/cache/cleanup regression checks pass. This does not establish the cause or resolution of CI streaming/cold-frame budget misses; final unchanged-budget CI measurements remain required. Local capture-tool inspection, sidebar visual evidence and motion inspection are deferred by explicit user request, not marked verified.

## Stable wall edges and composer resizing

Implemented; verification pending: remove the agent/terminal counts subtitle and show Agents beside the desktop Nekko Agent brand; browser/mobile retain the in-view heading. The bottom Add glyph is optically raised 3px without moving its hit target. Hidden Add cards do not contribute scroll overflow; wall width reserves a stable vertical scrollbar gutter and clips unintended horizontal overflow, preventing scrollbar/geometry feedback during transitions. The height drag handle sits immediately against the composer and follows its width and alignment. Both side handles resize the composer between 320px (or the available narrower width) and the wall-column width. Center docking resizes symmetrically; left/right docking retains its anchor. Arrow keys resize; Home/double-click reset to 75% desktop/100% narrow width. Width remains local to the mounted composer; no persisted settings, host actions, credentials or external requests are added. Acceptance requires stable geometry across repeated resize/scroll frames, accessible keyboard and pointer resizing/reset, preserved drafts, and matching light/dark desktop/narrow before/after screenshots plus motion evidence.
