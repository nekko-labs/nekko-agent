---
title: "Brand refresh and website redesign (2026-10-18)"
area: brand
split-from: SPEC.md (2026-10-22)
---

# Brand refresh and website redesign (2026-10-18)

`[implemented; icons and docs regenerated with repo tooling; no before/after screenshots yet; beta form not live]` The brand moves from a dark tile to a **gradient**: deep indigo `#453A92` to lavender `#9D8CE6`, left to right. This supersedes the dark-tile and "dark-only" wording under *App icon*, *Marketing website* and *Documentation hub* below.

- **App icon and installers.** The same outline cat mark, now white on a gradient squircle tile with no rim light. `apps/desktop/scripts/icon-art.cjs` is still the one source: `make-icons.cjs` repaints the desktop icons, the NSIS installer bitmaps (gradient panel, white product name) and the phone icons; Android's adaptive-icon background is the gradient and the Expo splash/adaptive colour is `#453A92`. The in-app `BrandMark` is unchanged.
- **Site mark.** `scripts/make-site-icon.cjs` writes `favicon.svg` (the tile) and a new `logo.svg`: the cat in the gradient with no tile, used in the site and docs nav and footer.
- **Two looks, White by default.** *(Superseded 2026-10-22: there are now three looks and Dark is the default, see below.)* A sun/moon button switches the homepage between **White** and **Colourful** (lavender ground). The choice is kept in `localStorage` (`nekko-theme`), applied before first paint, and read by the docs pages too; it never leaves the browser. If storage is blocked the choice lasts for that page only. The docs are now light, with a matching colourful variant, instead of dark-only.
- **Homepage redesign.** Handjet and Space Mono accent fonts, retro sticker buttons, a liquid-glass floating nav and lavender/aqua section bands. A dot-matrix pixel wave canvas replaces the starfield: about 20 fps, moved along by scrolling, paused while the tab is hidden, and held still (still following scroll) under reduced motion.
- **Media slots.** The product screenshot and feature GIF slots open in a lightbox (Escape, backdrop or Close shuts it and returns focus). They are placeholders until the real media lands.
- **Beta sign-up section.** An email form hosted by an animated Nekko (idle, watching, eager, confused, celebrate). An invalid email shows the confused state. When the form has an endpoint it POSTs `{ email }` as JSON and shows an error on failure. **Planned, not live:** `data-endpoint` is empty, so today it only shows the thank-you card and sends nothing. Wiring it to the signup backend above is separate work.

## Trust-first homepage: slogan and five demo panels (2026-10-22)

`[implemented; before/after screenshots in the PR; demo videos not yet produced]` The homepage leads with the slogan **"The personal, local agent you can trust."** (changed from "Your" on 2026-10-22, see below) and a lede about control: the user chooses the models, chooses what data is used, and sees what is happening. The eight-card "What you can do" grid is replaced by **five promise panels** (`#why-nekko`), modelled on Orca's feature panels: each is one wide card with a copy column (number, headline, paragraph, three points, a link) beside a 16:10 demo slot, sides alternating down the page and stacking media-first on phones.

1. **In control**: model choice per chat, Context Inspector, command approvals and line-by-line review.
2. **No compromise**: terminal power with the polish of a finished app; CLI and MCP for people who prefer the shell.
3. **Fast**: "Fast. Really fast. Maybe the fastest." with a bar chart of decode, code edit and four-at-once tokens/s against Ollama and LM Studio, numbers quoted from [docs/benchmarks.md](../../docs/benchmarks.md) (2026-09-30) with the losses named in the note. The chart is static HTML and CSS (no library) and its three colours pass a colour-blindness check.
4. **Secure**: the Apple-style "even we can't see in" stance: local chats stay on the machine, phone traffic is end-to-end encrypted so the relay carries ciphertext, Privacy Shield and Incognito for cloud models.
5. **Convenient** (Beta chip): the phone app, pairing, approvals by tap, on-phone models.

The demo slots are the existing `.media` lightbox placeholders with a `data-demo` key per panel; Travis is producing the videos, and each drops in as a `<video>` inside its slot. The page title, meta descriptions and Open Graph text carry the slogan; the structured data is unchanged. Everything below the panels (beta, model server, privacy manifest, editions, roadmap, download) is as before.

## Dark by default, a tertiary primary button, GitHub marks (2026-10-22)

`[implemented; before/after screenshots in the PR; saved-theme migration and docs pages deliberately unchanged, see below]`

- **Three looks, Dark first.** The homepage opens in a new **Dark** look (ground `#0d0b18`, white text, lavender and aqua washes turned into glows, pale-lavender sticker outlines and hard shadows). The nav button now cycles **Dark → White → Colourful → Dark**; its icon shows where the next click goes (sun, drop, moon) and its label names both the current and the next look. `data-theme="dark"` is on `<html>` in the markup, so it is dark with no flash and with JavaScript off. A saved `white` or `colour` choice in `localStorage` (`nekko-theme`) replaces it before first paint, so visitors who already picked a look keep it; anyone who never chose now sees Dark. The `<meta name="theme-color">` follows the look.
- **Brighter top bar in Dark.** The liquid-glass nav is lit from within in Dark: a higher white fill, a near-white rim and a stronger sheen, with white link text.
- **Slogan.** "The personal, local agent you can trust." in the hero, `<title>`, meta descriptions, Open Graph and Twitter text.
- **Primary button.** One new tertiary-colour gradient (pink `#ff7eb6`, tangerine `#ff9f6e`, butter `#ffd36b`) replaces the lavender fill in every look, including the colourful one, with dark ink in all of them. A custom download icon (an arrow dropping into a cat-eared tray) sits before the label on the nav button and both download pills, and the two download pills carry a small three-stroke sparkle on their top-right corner that blinks in steps and holds still under reduced motion. The gradient slides on hover.
- **GitHub mark** (Octicons) beside the nav "GitHub" link, the hero "View GitHub repo" button and the footer link.
- **Not changed, on purpose.** The docs pages still read only `colour` from `nekko-theme`, so they stay White (or Colourful) and do not follow Dark yet. `og.png` is unchanged.
