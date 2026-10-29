---
title: "Subtle rail and compact board gutters"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Subtle rail and compact board gutters

Historical candidate, rail geometry superseded by **Rail background alignment** below; compact-board spacing remains applicable: the navigation wave occupied the middle 60% of the available content height, with 4% accent mixed into paper (7% on hover/focus), and icon gaps increase from 4px to 7px. The rail retains its existing 52px collapsed/188px expanded widths and keyboard access. The board has 1px horizontal padding, with vertical halo clearance unchanged. Composer horizontal insets reserve its existing 14px resize handles plus 1px clearance on each side and the existing right scrollbar gutter. The page left inset decreases from 4px to 3px and right inset from 6px to 1px; the agent-list-to-chat gap decreases from 2px to 1px. These are presentation-only changes; no host actions, permissions or saved settings change. Acceptance: matched light/dark desktop and narrow captures, hover/focus expansion, and usable composer resizing. Native macOS/Linux verification remains untested.

## Agent window edge refinement

Implemented; isolated desktop geometry and keyboard resizing verified: pixels remain behind an opaque Focus agent surface. The agent board removes its 6px page-bottom inset and 14px wall-bottom inset so agent windows reach the bottom of the available app content. The left agent-list gap decreases from 8px to 6px; the right monitor-panel gap decreases from 6px to 3px. The earlier ink-derived agent-list boundary is superseded by the hover-only edge grips below. Resize targets and saved layout data are unchanged. Acceptance: matched desktop captures show the bottom edge, side spacing and visible Inkberry boundary without pixels through the transcript. No new permissions or data access.

## Hover-only side resize grips

Implemented: remove the permanent vertical shadow beside the agent list. Both side-panel handles draw a 3px opaque accent/white line with a small accent glow only on hover, keyboard focus or active dragging. Their existing widths, saved sizes and keyboard controls stay unchanged. Open panels use an expanded clip-path instead of overflow clipping so outboard resize targets remain visible and hit-testable; closed panels still clip to zero and ignore pointer input. The narrow agent drawer remains unclipped. Reduced motion disables grip fades. Verification: focused stylesheet regressions and isolated macOS Electron pointer/keyboard checks; matched wide/narrow screenshots and hover motion evidence. Windows/Linux native rendering is unverified.
