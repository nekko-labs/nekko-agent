---
title: "Style: universal fonts, text size and your own fonts (desktop)"
area: desktop
---

# Style: universal fonts, text size and your own fonts (desktop)

User intent: the app should read like the website, in the same two fonts everywhere, and anyone should be able to make text bigger or switch to a font they like, including one they add themselves, without editing files by hand.

## Universal fonts

- The website's two fonts are the app's fonts: **Inter Tight** for the interface (`--font-sans`) and **JetBrains Mono** for code, paths and other fixed-width text (`--font-mono`). They are bundled with the renderer (Fontsource variable fonts, OFL), so the desktop app and the Local Web UI show them with no network fetch.
- Every surface reads the two tokens; nothing names a font family directly. The terminal is the exception: it keeps its own installed-font list so Nerd Font prompt glyphs still draw.

## Settings > Style

A **Style** group sits third in Settings, after Phone pairing, with one card, **Fonts and text**:

- **Text size**: 80%, 90%, 100% (default), 110%, 125%, 150%. It scales the whole interface, since most sizes in the app are fixed pixels. The desktop app uses page zoom, the same as a browser's own zoom, so measured positions, clicks, the window size and scrolling all stay in one coordinate space, and a window at a large size lays out as a narrower one would. The Local Web UI cannot set page zoom and uses CSS `zoom` on the root, where menus placed from a measured position can land away from their button at sizes other than 100%. See [decision 0060](../../docs/decisions/0060-text-size-is-page-zoom-on-the-desktop.md). Saved as `textScale`; anything out of range reads as the nearest bound, anything not a number as 100.
- **Interface font** and **Code font**: the default (Inter Tight / JetBrains Mono), **System**, and every font in the fonts folder. Saved as `fontSans` / `fontMono`; an empty string means the default. A chosen font always falls back to the bundled one, so a missing file never leaves the app unstyled, and the list shows it as "(missing)".
- Each font row previews its font.

## Settings > Accessibility

Text size is also the first row of **Accessibility**, above Agent activity animation, for people who look for it there.

- It is the same setting as Style's **Text size** (`textScale`), with the same steps and the same limits, 80% and 150%. Changing either one moves the other. There is no second scale: `zoom` multiplies, so two would compound.
- **−** and **+** step through the sizes, and each is disabled at its limit.
- A preview under the row shows sample text at the picked size, live. The app itself does not change until **Apply**. **Cancel**, leaving the page, or a change of size from Style or the command palette drops the unapplied size.
- The preview is scaled by picked size over applied size, since the page is already zoomed to the applied one.
- Settings' section list and search land in the right place at every size, under CSS `zoom` too: there, element rects are in zoomed pixels and `scrollTop` is not, so a distance from one is divided by the zoom before it scrolls the other.

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
- Planned: the phone apps following the desktop's font choice.
