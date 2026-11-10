---
status: accepted
date: 2026-11-10
---

# 0079. Make buttons slim for a pointer and 44px for a finger

## Context

Since #2079 every `.btn` reserved a real 44 × 44 layout target, on every device. On a desktop that made each button taller than the 40px rows around it, and the [design system](../design-system.md) already said buttons are 32. Many call sites asked for a compact button (`btn px-2 py-1 text-xs`) and got a 44px one anyway. Philip asked for slimmer buttons in the design system and across the app (2026-11-10).

The 44px rule exists for touch: the same renderer is the Local Web UI on a phone.

## Options considered

1. **Keep 44 everywhere.** Safe for touch, heavy with a mouse.
2. **Slim everywhere.** Right for a mouse, too small for a finger in the Local Web UI.
3. **Slim visible button with an invisible 44px hit area.** Keeps both, but overlapping invisible targets were what #2079 removed: neighbours steal each other's clicks.
4. **Slim for a fine pointer, 44 for a coarse one.** One class, sized by `@media (pointer: coarse)`.

## Decision

Option 4. `.btn` is 28px tall (12px side padding, 14/500 label, 8px radius) and takes `min-width` and `min-height` of 44px only under a coarse pointer. The target stays real layout on touch and the button is slim where a cursor is precise.

## Consequences

- Every `.btn` in the desktop app and the Local Web UI gets shorter on pointer devices; layouts that leaned on the 44px height tighten. Screens are checked as they are touched.
- Composer and question controls that use `action-target` directly keep 44px on every device.
- A touch laptop reports a fine primary pointer and gets slim buttons; that is the same trade every desktop app makes.
- The native iOS and Android apps are not affected: they follow their platforms' sizes.
- The spec passages that promised 44px for `.btn` on desktop are amended ([question pages and action targets](../../spec/chat/question-pages-and-action-targets.md)).
