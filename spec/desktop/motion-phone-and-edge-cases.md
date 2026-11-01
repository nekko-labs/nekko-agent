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

## Status

- Implemented: everything above. Measured numbers are in `docs/perf-history.md` (2026-11-01).
- Phone: verified in headless Chromium with touch and mobile emulation at 320 and 390px; not checked on a real iPhone or Android device (safe areas and zoom-on-focus need hardware).
- Worst-case-data fixes are a later pass under the same issue.
- Not done: the held window card still moves by left/top per pointer move (one fixed element), and the rail's hover expansion still animates its width (bounded to the rail).
