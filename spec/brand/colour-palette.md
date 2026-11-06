---
title: "Colour palette: Nekko and Indigo themes, app icon and website (2026-11-03)"
area: brand
---

# Colour palette: Nekko and Indigo themes, app icon and website

[implemented 2026-11-03; lands with #1596 (app themes and icon) and #1598 (website)]

The reference for every colour in the Nekko and Indigo app themes, the app icon and the website. Use it for screenshots, videos, decks and anything else that shows the product. If a value here and the code disagree, the code is right and this file needs fixing.

## Core palette

| Role | Hex | Use |
|---|---|---|
| **Plum** (main, Nekko) | `#190019` | Main buttons, the app icon tile, website download button, big fills. Too dark for text or thin lines on dark backgrounds. |
| **Indigo** (main, Indigo theme) | `#2B124C` | Same role as plum, in the Indigo themes only. |
| **Secondary** | `#854F6C` | Outlines, glows, installer marks, the cat on the website, wash gradients, chart/dot-wave ends. Not for small text on dark (2.9:1). |
| **Secondary, light** | `#C99BB3` | The secondary as **small text on dark** (7.6:1): links, labels, merged-PR text in Dark. |
| **Text, dark mode** | `#FFFFFF` | All body text in Dark. |
| **Text, light mode** | `#000000` | All body text in Light. |

There is no third accent yet (open question, 2026-11-03).

Retired, do not use in new material: lavender `#9D8CE6`, indigo `#453A92`, `#5B4EA7`, `#6D5EFC`, aqua `#8AE4F2`, mint `#A5F9DF`, rose `#DFB6B2`.

## Accent shades

The main colours are near-black, so small accents (links, icons, headings, toggles, focus rings) use lighter shades of the same hue.

| Theme | `accent` (small accents) | `accent2` (secondary accents) | Selected rows (`--accent-soft`) |
|---|---|---|---|
| Light Nekko | `#5A2352` | `#8A4A7F` | `#8A4A7F` at 16% |
| Dark Nekko | `#C084B5` | `#C99BB3` | `#5A2352` at 55% over the surface |
| Light Indigo | `#4A2A7A` | `#6E4FA0` | `#6E4FA0` at 16% |
| Dark Indigo | `#A68FD0` | `#C99BB3` | `#4A2A7A` at 55% over the surface |

## Surfaces

The Nekko and Indigo themes use the standard Light and Dark surfaces unchanged; only text and accents differ.

| Token | Light | Dark |
|---|---|---|
| Page (`--paper`) | `#FBFBFD` | `#0C0C11` |
| Window (`--win`) | `#FCFCFE` | `#17171E` |
| Panel (`--surface`) | `#FFFFFF` | `#16161C` |
| Raised panel (`--surface-2`) | `#F2F2F7` | `#20202A` |
| Lines (`--line`) | `#E8E8EF` | `#26262F` |
| Muted text (website Dark) | n/a | `#A3A1B0` |

## Components

- **Main button:** fill is the main colour (`#190019` or `#2B124C`), text `#FFFFFF`. In Dark it also has a 1px `#854F6C` inside outline.
- **Merged-PR banner text:** Light uses the main colour; Dark uses `#C99BB3`.
- **Active-window gradient** (revised for #1791; other themes keep their existing treatment): a soft plum field from the top of the selected chat window, an ellipse 110% wide and 90% tall fading to nothing by 85%.
  - Dark: `#854F6C` at 30%. Light: the main colour at 10%.
  - **When:** the selected agent keeps the same gradient from its new-chat greeting into its full transcript, working or idle. In Dynamic only the active pane has it; background agents stay neutral even while working. Selection fades the base field over 0.7 s.
  - **Colour transition:** a static violet/rose palette (`rgb(107 77 153 / .22)` top-left, `rgb(163 80 119 / .12)` bottom-right) crossfades by composited opacity from .1 to .9 over 24 s, alternating. It never intercepts input. Reduced motion disables the cycle and selection fade, retaining a static plum field.
  - **Existing-chat dithering (#1891):** the selected conversation adds the new-chat screen's faint (5.5% opacity), fixed-seed monochrome grain behind its content, reducing harsh gradient bands without blurring text. The tile is static even while the colours crossfade. New chat keeps its existing single grain layer; inactive panes, standalone composers and other themes are unchanged. No network assets, settings, host calls or permissions are added. Acceptance: smoother-looking transitions, readable text, pointer and typing pass-through, and unchanged new-chat appearance at desktop and narrow widths. Implemented and verified with 484 focused tests, desktop typecheck and nine isolated Electron checks on both base and head. Matching Windows desktop (1400×900) and narrow (460×900) captures were inspected; new-chat pixels are identical at both sizes. The narrow fixture scrolls to reach its composer on base and head. Reproduce with `NEKKO_CONTROLS_SANDBOX=chat-gradient-dither-sandbox.cjs node apps/desktop/scripts/agent-window-controls-integration.cjs` (add `NEKKO_TEST_REVISION=13f3f189` for the baseline). Native phone apps, macOS/Linux, other presets and packaged builds are not visually verified by this change.
  - Implemented in the shared desktop/Local Web UI renderer. Windows hidden Electron fixture verification is tracked in #1791; native macOS/Linux and packaged builds are not verified by this change.
- **Dot wave** (faint dots behind the new-chat page; drawn at 60% strength and slowed, as for every Experimental theme):

| Theme | From | To |
|---|---|---|
| Light Nekko | `#190019` | `#854F6C` |
| Dark Nekko | `#C084B5` | `#854F6C` |
| Light Indigo | `#2B124C` | `#854F6C` |
| Dark Indigo | `#A68FD0` | `#854F6C` |

## App icon

Plum in every theme (there is no indigo icon).

- **Tile:** left-to-right gradient `#190019` to `#5A2352`, rounded square.
- **Mark (the cat):** white `#FFFFFF` (implemented in #1943); geometry and the plum tile gradient are unchanged.
- **Installer banners:** keep the original plum `#854F6C` cat, text and edge stripe, not the white app-icon mark. The generator selects installer ink explicitly (#2003). Non-icon brand marks keep their existing plum treatments.
- **Implemented and tested (#2003):** regression tests cover white app-icon output at nine sizes, explicit ink for fill and small-size strokes, and exact header/sidebar SVG equality with the pre-#1943 generator, including supersampled dimensions. No visual change to current UI or installers: committed icon and installer assets are not regenerated or changed. This restores future banner regeneration to the original plum art, not a new design. Cross-platform raster reproducibility and native launcher/installer appearance are not verified by this source-only follow-up.
- Source of truth: `apps/desktop/scripts/icon-art.cjs`; regenerate with `npx electron apps/desktop/scripts/make-icons.cjs`.

## Base looks and other brand surfaces

`[updated 2026-11-05]` The last places that still drew the old lilac and violet now use the palette above.

- **System, Light and Dark** (the base looks, and the default accent a fresh profile saves): Light `#5A2352` / `#8A4A7F`, Dark `#C084B5` / `#C99BB3`, on the desktop, the iPhone and Android. A saved `#6D5EFC` (the old default) migrates to `#5A2352` on load, and the old base accents (`#6D5EFC`, `#06B6D4`, `#8B7DFF`, `#22D3EE`) read as the new ones, so nobody who never picked a colour keeps the violet. A phone paired to a computer that still sends the old violet keeps plum.
- **Startup splash, first launch** (desktop) and the **iPhone launch screen, opening animation and lock cover**: `#190019` with the white cat.
- **iPhone brand mark** (first run, pairing): the cat in `#854F6C`, as on Android.
- **Tray companion and memory warning popups** (desktop): `#16161C` panel, `#C99BB3` outlines, `#190019` main button with a `#854F6C` outline.
- **Nekko Cloud beta emails and the confirm/unsubscribe pages**: `#FBF6F8` page, `#5A2352` wordmark and links (`#C99BB3` in dark), `#190019` to `#3A1438` button, `#5A2352` to `#C084B5` headline.

Not changed: themes a user picks by name (Nebula, and the older Lilac, Lavender and Nekko Dark presets, no longer in the picker) keep their own colours, as do the multicolour nav icons.

## Website

The site is plum only. Dark and White are its two main looks; Colourful follows the same palette.

| Element | Value |
|---|---|
| Dark page | `#0C0C11`, with plum glows `rgba(25, 0, 25, 0.9)` top-left and `0.7` bottom-left |
| Dark panels / lines | `#16161C` / `#26262F` |
| Dark links and accent text | `#C99BB3` |
| Dark outlines, cat, sticker shadows | `#854F6C` |
| Headline highlight ("you can trust."), Dark | gradient `#854F6C` to `#E6D0DC` |
| White text | `#000000` |
| Download button | gradient `#190019` to `#3A1438`, text `#FFFFFF` |
| Pale tints (bands, hovers, White page) | `#E6D0DC`, `#F3E8EE`, `#FBF6F8` |
| Logo (nav, footer) | gradient `#5A2352` to `#C084B5` |
| Favicon | same as the app icon |
| Browser bar colour | Dark `#0C0C11`, White `#FBF6F8`, Colourful `#854F6C` |
| Speed chart | Nekko `#5A2352`, Ollama `#177A89` (kept teal so it stays distinct), LM Studio `#A0601E` |
| Hero screenshot frames | Dark `#241F23`, Light `#C9A9C4` |

The previous lavender site is kept at tag `website-lavender-original`.

## Rules

- Text meets WCAG AA, 4.5:1, on whatever it sits on. `apps/desktop/src/renderer/contrast.test.ts` enforces this for every theme.
- Never put `#190019`, `#2B124C` or `#854F6C` as small text or thin lines on a dark background; use the light shades above.
- On a main-colour fill, text is `#FFFFFF`.
- Body text is pure `#FFFFFF` in Dark and pure `#000000` in Light.

## For screenshots and video

- **App:** Settings, Appearance, Theme, Experimental: **Dark Nekko** (default for marketing) or **Light Nekko**. Use Indigo only when showing the theme choice itself.
- **Window size:** match existing material (hero shots are 2560 by 1392; renderer captures 1440 by 900).
- **Show the glow honestly:** only a window whose agent is thinking or replying carries it; capture it mid-reply, never on a finished chat.
- **Check before publishing:** nothing should show the retired lavender, aqua or rose listed above, including the cat, logo and icon.
- **Website embeds:** dark shots sit on a `#241F23` frame, light shots on `#C9A9C4`. The hero screenshots are recoloured originals; re-record the intro and demo videos in Dark Nekko.

## Where the values live

- App themes: `packages/shared/src/themes.ts` (presets `x-plum-white`, `x-plum-dark`, `x-indigo-white`, `x-indigo-dark`) and `apps/desktop/src/renderer/styles.css` (search `--nekko-main`).
- App icon: `apps/desktop/scripts/icon-art.cjs`.
- Website: `apps/website/styles.css` (the "Plum palette" block at the end), `site.js`, `logo.svg`, `favicon.svg`.
