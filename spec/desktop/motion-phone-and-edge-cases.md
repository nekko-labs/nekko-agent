---
title: "Motion, phone and edge cases: interruptible motion, frame budget, worst-case data"
area: desktop
---

# Motion, phone and edge cases: interruptible motion, frame budget, worst-case data

User intent: motion should never fight the user or cost frames, the Local Web UI should work from a phone, and real-world data (long paths, huge counts, right-to-left text) should not break layouts ([#1411](https://github.com/nekko-labs/nekko-agent/issues/1411)). Applies to the shared renderer, so the desktop app and the Local Web UI change together.

## Motion

- **Interruptible open and close.** The composer question, the agent logs drawer and the PR deck open and close on CSS transitions (with `@starting-style` for the entry), so toggling one mid-flight reverses from where it is. The question grows from 96% (never from nothing, so its text keeps its proportions). Every exit uses the same ease-out as the entry; none uses an ease-in.
- **Focus first send.** The chat is revealed out of the composer's rectangle with a clip-path (260 ms); the new-agent fade is 240 ms and the collapse 260 ms.
- **Tooltips.** After one tooltip has shown, the next one within 600 ms shows at once with no fade. Keyboard focus shows it at once too.
- **One curve.** Motion uses `--ease-out` in CSS and `EASE_OUT` (`easing.ts`) for `Element.animate`; there is no spring token. The wall's own push curve is a stronger ease-out with no overshoot (`cubic-bezier(.23, 1, .32, 1)`, 220 ms).
- **Wall windows.** A window whose place changes slides there on a transform (`wallMotion.slideWindow`), interruptibly; its box never tweens left, top, width or height. Picking up a window and the zone options use no overshoot or spin. The monitors dock's landing zone opens on a grid row, not a height tween. Buttons answer the press with `scale(.97)`.

## Frame budget

- **New-chat background.** The colour drift is three static gradient layers crossfaded by opacity (composited) over the static base, instead of animating registered custom properties; the frosted composer and Focus panel blur at 12 px.
- **Resize drags.** Wall dividers, the chat composer's height, the context inspector's Folders/Context split and the monitors dock's width and monitor heights write to the page while dragging and commit to state once, on release. The wall's preview is drawn at most once a frame.
- **Timestamp swipe.** The swipe transforms the transcript list directly and shows the times with one class, not inherited custom properties.
- **No continuous layout or paint animation.** Usage and progress bars scale rather than animate width; the add tile's liquid border runs once; the companion share is set on the companions column rather than the whole window; the Settings and Models section spies read layout at most once a frame.

## Phone (Local Web UI)

- **Touch-visible actions.** Actions that appear on hover (message Copy and Retry, code-block Copy, the workspace card close, a project's + agent / + terminal, automation and context-inspector row actions, the chat finder's row action, attachment remove) show on a device with no hover (the `touch:` variant, `@media (hover: none)`); message actions at 70% opacity.
- **No zoom on focus.** On a coarse pointer every field, select and the composer editor is 16px, so iOS does not zoom the page.
- **Fits 320px.** The command palette, toasts and the web update card stay inside a 320px screen; toast text wraps; the toast stack sits above the tab bar and is announced politely.
- **Safe areas.** The shell keeps clear of the notch and side insets (`viewport-fit=cover`); the main area reserves the tab bar plus the home indicator's inset; the tab bar pads the side insets and answers the press.
- **Native feel.** No tap highlight or text inflation; no pull-to-refresh on the app (`overscroll-behavior: none`) and the transcript contains its overscroll; `touch-action: manipulation` on controls; `100dvh` instead of `100vh`; every `:hover` rule in the renderer's CSS sits under `@media (hover: hover)`, so a tap leaves no sticky hover; `theme-color` follows the app's own light or dark paper.

## Worst-case data

- **Long unbroken text wraps.** Chat bubbles, inline code and error rows wrap a long path, hash or URL (`overflow-wrap: anywhere`); code blocks keep their own horizontal scroll.
- **Right-to-left text.** Markdown paragraphs, list items and headings, and chat, file and folder names carry `dir="auto"`.
- **Truncation keeps what matters.** Model ids, file names and paths lose their middle, not their end (`MiddleTruncate`), with the full text as the tooltip: the folder picker, file pane header, file tree, downloads, model library and provider model lists. Truncated chat, group and window names have a `title`.
- **Controls stay reachable.** A long folder path no longer pushes the folder picker's revoke button out; a long file name no longer hides the file pane's Save and Reveal; a long automation cadence truncates and the row wraps instead of squeezing the title to nothing.
- **Phone width.** The skills marketplace stacks its shelves above the detail below md; download rows wrap their progress under the file name; schedule kind tiles stack below 360px; the composer's model chip keeps a minimum width.
- **Numbers.** Byte sizes under a megabyte read in KB or B (not "0 MB" / "0 GB"); stars, installs and downloads use compact `Intl` formatting ("1M", not "1000k"); "1 step", "1 skill"; a NaN download reading counts as unknown.
- **Big folders.** The file tree shows 200 entries per folder, then "Show N more"; an empty folder says so and an unreadable one says it can't be read.
- **Long lists page.** The chat list's Completed group and the model library render 50 rows, then "Show 50 more of N"; a selected or just-completed chat is always among the rendered rows, and a new library search or filter starts from the first page. Paging rather than the transcript's windowing, because both lists sit inside other scrollers with groups and expanding rows.
- **Toasts stay few.** At most 3 toasts show at once; a new one pushes the oldest info or success out first, so an error outlives later chatter. Infos and successes leave after 5 s; errors stay until clicked or closed (they carry a close button). A dismissed toast fades down over 160 ms with an ease-out; with reduced motion it just goes.

## Status

- Implemented: everything above. Measured numbers are in `docs/perf-history.md` (2026-11-01).
- Phone: verified in headless Chromium with touch and mobile emulation at 320 and 390px; not checked on a real iPhone or Android device (safe areas and zoom-on-focus need hardware).
- Done from the edge-case audit (#1478): toasts are capped, sticky for errors and have an exit motion; the chat list's Completed group and the model library are paged. Verified in a headless Chromium fixture of the real App with 400 completed chats and 400 models, not on a real library.
- Not done from the edge-case audit: a pasted 50k-character prompt is not clamped; token and duration stats in the done row are not compact (`2400k in`). The RunBoard best-run label (`slice(0, 26)`) is left for the change already editing that file.
- Not done: the held window card still moves by left/top per pointer move (one fixed element), and the rail's hover expansion still animates its width (bounded to the rail).
