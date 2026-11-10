---
title: "Style: universal fonts, text size and your own fonts (desktop)"
area: desktop
---

# Style: universal fonts, text size and your own fonts (desktop)

User intent: the app reads in the same two fonts everywhere, and anyone should be able to make text bigger or switch to a font they like, including one they add themselves, without editing files by hand.

## Universal fonts

- The app's fonts are **Geist** for the interface (`--font-sans`) and **Geist Mono** for code, paths and other fixed-width text (`--font-mono`), chosen with the design system ([decision 0075](../../docs/decisions/0075-quiet-design-system.md); they replaced the website's Inter Tight and JetBrains Mono on 2026-11-09, and the website keeps those for now). They are bundled with the renderer (Fontsource variable fonts, OFL-1.1), so the desktop app and the Local Web UI show them with no network fetch. A saved choice of another font is unchanged.
- Every surface reads the two tokens; nothing names a font family directly. The terminal is the exception: it keeps its own installed-font list so Nerd Font prompt glyphs still draw.

## Settings > Style

A **Style** group sits third in Settings, after Phone pairing, with one card, **Fonts and text**:

- **Text size**: 80%, 90%, 100% (default), 110%, 125%, 150%. It scales the whole interface, since most sizes in the app are fixed pixels. The desktop app uses page zoom, the same as a browser's own zoom, so measured positions, clicks, the window size and scrolling all stay in one coordinate space, and a window at a large size lays out as a narrower one would. The Local Web UI cannot set page zoom and uses CSS `zoom` on the root, where menus placed from a measured position can land away from their button at sizes other than 100%. See [decision 0060](../../docs/decisions/0060-text-size-is-page-zoom-on-the-desktop.md). Saved as `textScale`; anything out of range reads as the nearest bound, anything not a number as 100.
- **Interface font** and **Code font**: the default (Geist / Geist Mono), **System**, and every font in the fonts folder. Saved as `fontSans` / `fontMono`; an empty string means the default. A chosen font always falls back to the bundled one, so a missing file never leaves the app unstyled, and the list shows it as "(missing)".
- Each font row previews its font.
- Right after **Code font**, a preview shows sample text (a title, a line, a faint line and code) in both fonts at the current size. A size or font change applies at once and the preview follows it; there is no Apply step.
- Text size lives only here. The card that held a second text size stepper is now **Animations**, with just Agent activity animation.
- Settings' section list and search land in the right place at every size, under CSS `zoom` too: there, element rects are in zoomed pixels and `scrollTop` is not, so a distance from one is divided by the zoom before it scrolls the other.

## Keyboard and wheel

User intent: make text bigger or smaller from anywhere in the app with the usual zoom keys, without opening Settings.

- **Ctrl/⌘ + Plus** (or `=`, or the number pad's `+`) and **Ctrl/⌘ + Minus** step the same `textScale` one size up or down, through the same steps and limits as Settings. They apply at once, with no preview or Apply, and are saved once the steps stop (about 300 ms).
- **Ctrl/⌘ + scroll wheel** does the same: up is bigger, one step per mouse notch. A trackpad pinch adds up its small movements, so it steps too, but only after a deliberate move.
- Something that zooms itself, like the full-window diagram view, keeps the wheel; Chromium's own Ctrl+wheel zoom is stopped so it can't zoom outside the setting.
- On macOS the View menu no longer has the stock zoom items, which would take ⌘+, ⌘− and ⌘0 before the page did.
- **Ctrl/⌘ + 0** puts the text size back to 100%, the same way.

## Your own fonts

- The fonts folder is `fonts` in the data directory (`~/.nekko-agent/fonts`). The daemon creates it on first look (`fonts:list`).
- **Open fonts folder** opens it in the file manager; **Reload fonts** reads it again; **How to add fonts** opens [the docs page](../../docs/fonts-and-text.md). The folder path is shown beside the buttons.
- Each `.ttf`, `.otf`, `.woff` or `.woff2` file is one family named after the file. Up to 64 files, each up to 16 MB; other files are ignored.

## Boundaries

- `fonts:list` reads only that folder and returns the files' bytes to the UI, which registers them with `FontFace`; nothing is fetched by URL, so the renderer's CSP is unchanged.
- The channel is not on the phone allowlist, and the font settings are not part of the public appearance a paired phone mirrors.

## Status

- Implemented 2026-10-24: bundled fonts, Style section, text size, fonts folder. Checked in the hidden layout harness (`apps/desktop/scripts/style-sandbox.cjs`); not yet checked in a packaged build.
- Implemented 2026-11-06: text size in Settings > Accessibility with a preview and Apply, and page zoom on the desktop. Checked in the hidden layout harness (`text-size-sandbox.cjs`, `text-size-nav-sandbox.cjs`, `text-size-popover-sandbox.cjs`) and by hand in a dev build; not yet checked in a packaged build.
- Implemented 2026-11-08: Ctrl/⌘ + Plus/Minus and Ctrl/⌘ + scroll wheel step the text size, and Ctrl/⌘ + 0 resets it. Unit-tested; not yet checked by hand in a dev or packaged build.
- Changed 2026-11-08: the text preview moved under Code font in Style and applies at once; the Accessibility stepper and its Apply were removed, and the card was renamed **Animations**. Unit-tested; `text-size-sandbox.cjs` updated but not rerun.
- Planned: the phone apps following the desktop's font choice.
