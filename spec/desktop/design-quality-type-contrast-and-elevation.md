---
title: "Design quality: type scale, readable text, quiet buttons and navigation"
area: desktop
---

# Design quality: type scale, readable text, quiet buttons and navigation

User intent: the app is read for hours a day, so its small print has to be legible and its sizes, spacing and shadows have to come from one system instead of drifting screen by screen ([#1410](https://github.com/nekko-labs/nekko-agent/issues/1410)). Applies to the shared renderer, so the desktop app and the Local Web UI change together.

## Acceptance criteria

- **Faint text passes AA.** `--ink-faint` (timestamps, hints, counts, secondary labels) reaches 4.5:1 on paper, window, surface and surface-2 in every theme and preset. `contrast.test.ts` fails if a theme drops below.
- **One type scale.** Text sizes are 11, 12, 14, 16, 20 and 24px, as the theme tokens `text-2xs`, `text-xs`, `text-sm`, `text-base`, `text-xl` and `text-2xl` (and `var(--text-*)` in CSS). Nothing is set below 11px. No arbitrary `text-[Npx]` classes remain in the renderer; Tailwind's 18px (`lg`) and 30px (`3xl`) steps are gone. Sizes carry no line height of their own.
- **Tinted elevation.** Shadows come from four theme tokens (`--shadow-sm`, `--shadow-md`, `--shadow-float`, `--shadow-lift`), tinted with the theme's ink (light) or a near-black in the paper's hue (dark), blur about twice the offset. Tailwind's default black shadow scale is switched off. Resting cards have a border and no shadow.
- **4px spacing.** Padding, margin and gap sit on a 4px grid. The off-grid values (6, 10, 14, 18px, Tailwind's 1.5 / 2.5 / 3.5 steps) were rounded: vertical spacing down, horizontal and two-axis spacing up. 1px and 2px remain for hairlines. Geometry tied to something outside the grid (the Windows caption buttons, offsets paired with a border-spacing or a fixed width) is left as it was. `--pane-gap` is the single gap between panels, now 8px everywhere (it was 7px beside an 8px `--wall-gap`).

## Reading, buttons and navigation

- **Readable measure.** Chat replies, the user's own turns and documents stop prose at about 68 characters (`max-width: 68ch` on paragraphs, lists, quotes and headings) with a 1.6 line height. Code blocks, tables and diagrams keep the full width.
- **Sentence-case labels.** The small uppercase, letter-spaced labels above groups and fields are 12px sentence case at weight 500 in `--ink-soft`. Badges that are a single word (`new`, a file extension) keep their caps.
- **Flat primary, ink titles.** `.btn-primary` is one flat accent fill with no gradient, resting shadow or hover filter; its hover darkens the fill. View titles and the title bar heading are plain ink. The violet-to-cyan `--brand-grad` token is gone; `--accent-2` remains only as a data colour (charts, the code highlight, a celebration).
- **Neutral menus and nav.** Context-menu and creation-menu rows, catalog rows and the nav rail use a neutral wash for hover and the active item (no accent fill, no gradient notch). The accent is kept for the primary action, focus rings and data.
- **Calm navigation.** Rail icons change opacity only: no spring scale or rotate on hover, no squish on press, no pop when a view becomes active. The command palette (Ctrl/Cmd+K) opens without a fade, and fits a phone (`max-width: calc(100vw - 16px)`).

## Status

- Implemented: everything above.
- The Agents panel's group labels (Needs input, Working, ...) keep their accent colour and 14px size, a recorded choice; they lose only the caps and tracking.
- Not covered here: the iPhone draws its theme presets from `packages/shared/src/themes.ts`, whose `inkFaint` values still carry the old, lower-contrast greys. Updating them regenerates `apps/ios/App/Platform/ThemePresets.swift` and is left for an iOS change.
- Later passes under the same issue: wall window motion on transforms, and the website.
