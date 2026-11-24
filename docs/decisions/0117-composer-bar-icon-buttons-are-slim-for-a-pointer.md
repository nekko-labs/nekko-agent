---
status: accepted
date: 2026-11-23
---

# 0117. Make the composer bar's icon buttons slim for a pointer, like `.btn`

## Context

[Decision 0079](0079-buttons-are-slim-for-a-pointer-and-44px-for-a-finger.md) made `.btn` 28px with a mouse or trackpad and 44px under a finger, but kept 44px on every device for composer controls that use `action-target` directly. In the composer bar that left the attach plus, the microphone and send/stop standing well taller than the 28px model chip, folder and permissions controls beside them, and the microphone's 44px island left a wide gap before Send. The plus, microphone and send were asked to match the model chip's height, and the gap to close (2026-11-23, #3241).

## Options considered

1. **Keep 44 everywhere (0079 as written).** Safe for touch; the bar's icon buttons stay taller than everything beside them with a mouse.
2. **Slim for a fine pointer, 44 for a coarse one.** The same trade 0079 made for `.btn`.

## Decision

Option 2. The composer bar's attach, dictation and send/stop buttons share `composer-bar-button`: 28 × 28 with a fine pointer and 44 × 44 under a coarse pointer. Closed, the dictation island is as wide as its button (28px, or 44px on touch). Picker chips in the bar's model row take a 28px minimum so the heights match exactly. Glyph sizes are unchanged.

## Consequences

- Amends 0079: composer attach, dictation and send/stop no longer keep 44px with a mouse. Question options and Back still use `action-target` directly and keep 44px on every device.
- The Local Web UI on a phone or a touch laptop with a coarse pointer is unchanged.
- Nekko's 24px avatar on Send nearly fills its 28px button.
