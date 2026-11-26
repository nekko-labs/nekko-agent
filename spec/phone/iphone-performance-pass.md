---
title: "iPhone performance pass: photo thumbnails, quieter refreshes, off-main writes (2026-11-26)"
area: phone
---

# iPhone performance pass (2026-11-26)

`[implemented per section below; unit-tested in NekkoKit; not profiled on a device]` From the phone apps performance audit (`reports/2026-11-26-phone-apps-performance.md`). No screen changes: this is how the iPhone spends its main thread and its reads.

## User intent

Scrolling a chat, streaming a reply and opening a chat should not hitch, and the phone should not ask the computer for things it already has.

## Prompt photo thumbnails (#3383)

- The small copies of a prompt's photos (`PhotoStrip`) are decoded with ImageIO thumbnailing (longest side 240 px, orientation applied) on a background task, never in a view's `body`.
- Decoded thumbnails are kept in `PhotoThumbnails.shared` (`NekkoKit`), a bounded `NSCache`: 200 images or 24 MB. A photo that cannot be shown (withheld by the computer, unreadable) is remembered too, so it is not decoded again. A row scrolling back into view reads the cache; until a decode finishes the strip shows a plain tile of the same size.
- The message box's and the on-this-iPhone chat's photo previews use the same cache.
- Android already did this (`PromptPhotos.kt`: off the main thread, downsampled, 16 MB LRU).
