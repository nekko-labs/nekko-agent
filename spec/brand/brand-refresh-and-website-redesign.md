---
title: "Brand refresh and website redesign (2026-10-18)"
area: brand
split-from: SPEC.md (2026-10-22)
---

# Brand refresh and website redesign (2026-10-18)

`[implemented; icons and docs regenerated with repo tooling; no before/after screenshots yet; beta form not live]` The brand moves from a dark tile to a **gradient**: deep indigo `#453A92` to lavender `#9D8CE6`, left to right. This supersedes the dark-tile and "dark-only" wording under *App icon*, *Marketing website* and *Documentation hub* below.

- **App icon and installers.** The same outline cat mark, now white on a gradient squircle tile with no rim light. `apps/desktop/scripts/icon-art.cjs` is still the one source: `make-icons.cjs` repaints the desktop icons, the NSIS installer bitmaps (gradient panel, white product name) and the phone icons; Android's adaptive-icon background is the gradient and the Expo splash/adaptive colour is `#453A92`. The in-app `BrandMark` is unchanged.
- **Site mark.** `scripts/make-site-icon.cjs` writes `favicon.svg` (the tile) and a new `logo.svg`: the cat in the gradient with no tile, used in the site and docs nav and footer.
- **Two looks, White by default.** A sun/moon button switches the homepage between **White** and **Colourful** (lavender ground). The choice is kept in `localStorage` (`nekko-theme`), applied before first paint, and read by the docs pages too; it never leaves the browser. If storage is blocked the choice lasts for that page only. The docs are now light, with a matching colourful variant, instead of dark-only.
- **Homepage redesign.** Handjet and Space Mono accent fonts, retro sticker buttons, a liquid-glass floating nav and lavender/aqua section bands. A dot-matrix pixel wave canvas replaces the starfield: about 20 fps, moved along by scrolling, paused while the tab is hidden, and held still (still following scroll) under reduced motion.
- **Media slots.** The product screenshot and feature GIF slots open in a lightbox (Escape, backdrop or Close shuts it and returns focus). They are placeholders until the real media lands.
- **Beta sign-up section.** An email form hosted by an animated Nekko (idle, watching, eager, confused, celebrate). An invalid email shows the confused state. When the form has an endpoint it POSTs `{ email }` as JSON and shows an error on failure. **Planned, not live:** `data-endpoint` is empty, so today it only shows the thank-you card and sends nothing. Wiring it to the signup backend above is separate work.
