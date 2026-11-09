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

**Third colour: Petrol** (`--info`), `#1F6680` in light and `#6BB8D4` in dark, settled 2026-11-09 with the design system ([decision 0075](../../docs/decisions/0075-quiet-design-system.md)). It carries information: notices, tips, "New" tags and the third chart series (`--accent-2` is the second). It replaced the blue `--info` (`#3F7FB8` / `#5B9DD9`). Indigo was considered and rejected as too close to plum.

Retired, do not use in new material: lavender `#9D8CE6`, indigo `#453A92`, `#5B4EA7`, `#6D5EFC`, aqua `#8AE4F2`, mint `#A5F9DF`, rose `#DFB6B2`.

## Accent shades

The main colours are near-black, so small accents (links, icons, headings, toggles, focus rings) use lighter shades of the same hue.

| Theme | `accent` (small accents) | `accent2` (secondary accents) | Selected rows (`--accent-soft`) |
|---|---|---|---|
| Light Nekko | `#5A2352` | `#8A4A7F` | `#5A2352` at 16% over the surface |
| Dark Nekko | `#C084B5` | `#C99BB3` | `#5A2352` at 55% over the surface |
| Light Indigo | `#4A2A7A` | `#6E4FA0` | `#4A2A7A` at 16% over the surface |
| Dark Indigo | `#A68FD0` | `#C99BB3` | `#4A2A7A` at 55% over the surface |

## Surfaces

Light Nekko and Indigo use pale family-tinted surfaces so the same colour roles as Dark remain visible without becoming dark themes. Dark surfaces are unchanged. The desktop/Local Web UI and generated iOS/Android palette catalogs share these light surface tokens. Native apps retain their own existing backdrop geometry.

| Token | Light Nekko | Light Indigo | Dark, Dusk (both) |
|---|---|---|---|
| Page (`--paper`) | `#FBF6F9` | `#F7F5FC` | `#0B0C14` |
| Window (`--win`) | `#FCF8FB` | `#FAF8FE` | `#181A25` |
| Panel (`--surface`) | `#FFFBFD` | `#FDFBFF` | `#14151F` |
| Raised panel (`--surface-2`) | `#F2E7EF` | `#EDE8F6` | `#1D1F2C` |
| Lines (`--line`) | `#E3D3DF` | `#DDD4EB` | `#252735` |
| Muted text (`--ink-soft`) | `#40313F` | `#3C314A` | `#A3A4B6` |
| Faint text (`--ink-faint`) | `#493648` | `#43384F` | `#87899B` |

Selected rows mix the primary accent into the panel surface, as Dark does, rather than stacking a translucent secondary accent over whatever happens to sit behind them. Body text stays black, main buttons stay deep plum/indigo with white text, and saved custom accents are not migrated or overwritten.

## Components

- **Main button:** fill is the main colour (`#190019` or `#2B124C`), text `#FFFFFF`. In Dark it also has a 1px `#854F6C` inside outline.
- **Merged-PR banner text:** Light uses the main colour; Dark uses `#C99BB3`.
- **Active-window gradient** (revised for #1791; other themes keep their existing treatment): a soft plum field from the top of the selected chat window, an ellipse 110% wide and 90% tall fading to nothing by 85%.
  - Dark: `#854F6C` at 30%. Light: the same `#854F6C` hue at 22% (#2015), replacing the near-black main colour at 10%. Violet/rose overlay colours, geometry, timing and grain stay unchanged.
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

## Light/dark colour alignment (#2015)

Implemented in the shared desktop/Local Web UI renderer: pale family-tinted Light Nekko and Indigo surfaces, stronger shared plum glow, primary-accent selection fills, and darker family-tinted muted text. System resolving to Light Nekko inherits the treatment. Other named palettes, Dark, primary buttons, custom accent values and motion timing are unchanged.

Acceptance: recognizable colour relationships between the light/dark pair; body, muted, faint and primary-accent text at WCAG AA 4.5:1 on surfaces, selection fills and a conservative fully overlapping gradient/grain bound; unchanged input pass-through, inactive panes and reduced-motion behavior. No new settings, external assets, network access, permissions or storage changes.

Verification: 549 focused desktop theme/contrast tests plus 16 shared catalog/golden tests and desktop typecheck pass. The isolated Windows Electron fixture passes 21 checks on both base and head, with matching existing/new-chat screenshots at 1400×900 and 460×900 and a short real-time gradient recording. Captures were inspected using an off-screen, non-focusable native evidence viewer; browser capture failed, not the app renderer. At the narrow width, existing-chat composers require scrolling on both base and head. Android and iOS before/after evidence passed, was inspected and published in #2021. Android uses API 34 at 1080×1920; iOS uses matched iPhone 18 Pro / iOS 27.0 / Xcode 27.1 at 1206×2622 (run 42236644110). All light and dark native pairs were inspected: intended family tints, no visible layout regression, dark appearances retained. These are synthetic component fixtures, not live paired-chat or physical-device coverage. The first mismatched iOS 27.2/27.0 run was rejected; the evidence workflow now accepts an explicit runtime pin. macOS/Linux desktop and packaged builds have not been run locally.

Reproduce with `NEKKO_CONTROLS_SANDBOX=light-theme-sandbox.cjs node apps/desktop/scripts/agent-window-controls-integration.cjs`; add `NEKKO_TEST_REVISION=bdd59fa38` for the baseline. Media stays outside git and is published in the PR description.

## App icon

`[implemented in source; #2272 supersedes the green/cream icon palette]` Shipped app icons use plum and white independently of the user's chosen app theme. The existing outline cat geometry is unchanged.

- **Tile:** left-to-right gradient `#190019` to `#3A1438`, rounded square on desktop/web and full bleed on iOS/Watch. Android keeps the same gradient in its adaptive background.
- **Mark:** white `#FFFFFF`; iOS dark appearance and Windows installer ink use light plum `#C99BB3` on deep plum. Android resource colors are opaque AARRGGBB (`#FF190019`, `#FFFFFFFF`).
- **Shared generation:** `npx electron apps/desktop/scripts/make-icons.cjs` writes desktop PNG/SVG/ICO, web/PWA assets, installer BMPs, iOS light/dark SVG/opaque RGB PNGs and the matching Watch PNG. It uses a throwaway profile and hidden non-focusable window. Raster encoding avoids host ICC metadata; transparent pixels are unpremultiplied before PNG encoding.
- **Site and docs:** `node scripts/make-site-icon.cjs` writes the favicon and logo from the shared artwork and renders `og.png` from `docs/brand/nekko-banner-1280x640.png`, replacing the pre-rename name and secret-agent mascot. Website, privacy, generated docs, renderer favicon and touch/manifest references use a `plum-white-2` cache key. The social banner is unchanged. The renderer now declares its favicon explicitly.
- **Checks:** focused tests inspect current generator output, committed vectors, PNG palettes/dimensions/opacity, every embedded ICO PNG, installer pixels, Android ARGB values and cache keys. Native catalog/resource compilation and visual evidence are recorded in the linked PR. Full Windows installer, Android launcher, selected iOS dark appearance and Watch launcher are not established by these tests.
- **OS consumers:** macOS Settings/Finder/Dock, Windows taskbar/shortcuts and Linux launchers inherit the packaged icon; the desktop window/taskbar button, tray and notification artwork resolve to the same renderer asset (`apps/desktop/src/main/appIcon.ts`). An unpackaged run reads `src/renderer/public/icon-512.png` first, because `electron-vite dev` never rebuilds `out/renderer/` and a leftover copy there kept the tray and taskbar violet after the logo changed. Development bundles hash the icon to rebuild their ICNS/EXE on the next launch. Do not mutate a running bundle or clear user OS caches. Existing installed bundles need an updated build and restart; OS cache refresh is not claimed by source checks. The DMG and both installer-art generators use the same plum family.
- **Verification boundary:** source/container checks and matched asset previews cover the generated icons, not installed macOS Settings/Dock, Windows/Linux shells, native device launchers, iOS selected dark mode or Watch launchers. These OS journeys require disposable platform sessions/builds.
- **Preserved deliberately:** existing cat-mark geometry, seasonal Spooky artwork, user-selected plum/indigo themes, third-party provider logos, historical screenshots/evidence and immutable release files. This asset cleanup is not a whole-site/theme recolor or a mascot redesign.

## Fixed brand surfaces: launch, splash and the pixel mascot (2026-11-08)

What the app draws in the brand's own colours, whatever theme is chosen. Before this the iPhone had gone back to the retired green on its launch screen, opening animation, app lock cover and pixel mascot, and the desktop's pixel mascot had never moved off it.

| Surface | Ground / fill | Line and mark | Small accent |
|---|---|---|---|
| iPhone launch screen (`LaunchBrandPlum.storyboard`), opening animation, return dissolve and app lock cover | plum `#190019` | white cat | none |
| Android 12+ opening splash | plum `#190019` (`ic_launcher_background`) | white mark (`ic_launcher_mark`) | none |
| Desktop / Local Web UI startup splash | plum `#190019` (already, #2272) | white | none |
| Pixel mascot (iPhone `PixelCat`, the paw refresh, the Live Activity cat, the pairing celebration; Android `PixelCat`; desktop `PixelHead`) | plum `#190019` | white line and eyes | mouth `#C99BB3` |
| Outline brand mark on a themed screen (iPhone first run and pairing) | none | the theme's `accent` | none |
| iPhone Live Activity card (fixed dark plum `#190019`, washed with the accent from the top, 16% to 4%; was grey `#1C1C1E`) | plum `#190019` | none | Dark Nekko accent `#C084B5` (mic, filled buttons; 5.5:1 at the top of the wash, 6.8:1 on plain plum, 6.7:1 under its dark text), was the retired lavender `#8B7DFF`; secondary buttons `#3A1438` |

- The iPhone reads all of these from `BrandColor` (`apps/ios/App/Shared/BrandColor.swift`); a themed surface uses the theme's `Palette` instead.
- The launch storyboard is renamed whenever its colour changes (`LaunchScreen`, `Launch`, `LaunchPlum`, now `LaunchBrandPlum`) because iOS keeps showing a cached launch screen under the old name.
- `scripts/brand-colours.test.mjs` (in `npm test`) checks the storyboard ground, the Android splash, the desktop mascot and the Live Activity accent, and that no iOS, Android or desktop component source uses the retired green (`#101714`, `#263D2D`, `#F2F1E9`, `#A7C8AC`) or the Live Activity's old lavender.
- Status: implemented. The source checks pass on Linux; the iPhone build and UI tests run in the Native iOS workflow on the PR. Not yet seen on a physical iPhone, where iOS may keep the cached launch screen until the app is updated, or on an Android device.

## Base looks and other brand surfaces

`[updated 2026-11-05]` The last places that still drew the old lilac and violet now use the palette above.

- **System, Light and Dark** (the base looks, and the default accent a fresh profile saves): Light `#5A2352` / `#8A4A7F`, Dark `#C084B5` / `#C99BB3`, on the desktop, the iPhone and Android. A saved `#6D5EFC` (the old default) migrates to `#5A2352` on load, and the old base accents (`#6D5EFC`, `#06B6D4`, `#8B7DFF`, `#22D3EE`) read as the new ones, so nobody who never picked a colour keeps the violet. A phone paired to a computer that still sends the old violet keeps plum.
- **Desktop startup splash** (#2272): first launch, System, base Light/Dark and Nekko use main plum `#190019` with a white cat. Indigo uses `#2B124C`; deliberately selected alternative palettes retain their colours. Unversioned cached fills are ignored before paint, removing stale lilac intros. The **iPhone launch screen, opening animation and lock cover** remain `#101714` with the cream cat (`#F2F1E9`), unchanged by the desktop follow-up.
- **iPhone brand mark** (first run, pairing): the cat in sage `#A7C8AC`. Android uses the white launcher/splash mark.
- **Recovery kit export** (#2272): the key outline uses the Light Nekko accent `#5A2352`, not the retired violet.
- **Tray companion and memory warning popups** (desktop): `#16161C` panel, `#C99BB3` outlines, `#190019` main button with a `#854F6C` outline.
- **Nekko Cloud beta emails and the confirm/unsubscribe pages**: `#FBF6F8` page, `#5A2352` wordmark and links (`#C99BB3` in dark), `#190019` to `#3A1438` button, `#5A2352` to `#C084B5` headline.

Not changed: themes a user picks by name (Nebula, and the older Lilac, Lavender and Nekko Dark presets, no longer in the picker) keep their own colours, as do the multicolour nav icons.

## Website

The site theme remains plum; the favicon and logo use the plum icon assets above. The social card retains its existing first-party banner. The tables below describe site UI colors, not the superseded icon colors. The site theme is plum only. Dark and White are its two main looks; Colourful follows the same palette.

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
| Favicon | current plum/white app icon (see above) |
| Browser bar colour | Dark `#0C0C11`, White `#FBF6F8`, Colourful `#854F6C` |
| Speed chart | Nekko `#5A2352`, Ollama `#177A89` (kept teal so it stays distinct), LM Studio `#A0601E` |
| Hero screenshot frames | Dark `#241F23`, Light `#C9A9C4` |

The previous lavender site is kept at tag `website-lavender-original`.

## Dusk, state words and status badges (2026-11-09)

`[implemented in the shared desktop/Local Web UI renderer, #2400]`

- **Dusk** replaces the cool black (`#0C0C11`) as the dark neutrals of the base Dark look and of Dark Nekko and Dark Indigo: a hint of blue in panels and lines, almost none in the page. The iPhone and Android theme catalogs (written from `packages/shared/src/themes.ts`) carry Dusk for Dark Nekko and Dark Indigo; their base Dark look keeps its own palette until the phone follow-up.
- **State words**: each state colour has a `-text` value for words, because the base hues fall under 4.5:1 as text on light surfaces. Light: success `#226F49`, warning `#8A5A0C`, danger `#B23A2D`, attention `#A84C0A`, info `#1F6680`. Dark: the base hues, except danger `#EF6A5D`.
- **Working is green**: `--running` is the success green (the working rocket); `--highlight` (best so far) is the warning amber. The blue running colour and the third amber are retired.
- **Status badges** on Nekko (agent windows) use the state tokens: working and done success, needs you attention, error danger, watching neutral. They previously used the iPhone's system tints, including a blue for watching.
- Light Nekko and Light Indigo keep their faint ink: it sits over the plum selection gradient, where a lighter value falls under 4.5:1.

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
