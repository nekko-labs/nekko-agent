---
title: "Design quality: one type scale, readable faint text, tinted elevation, 4px spacing"
area: desktop
---

# Design quality: one type scale, readable faint text, tinted elevation, 4px spacing

User intent: the app is read for hours a day, so its small print has to be legible and its sizes, spacing and shadows have to come from one system instead of drifting screen by screen ([#1410](https://github.com/nekko-labs/nekko-agent/issues/1410)). Applies to the shared renderer, so the desktop app and the Local Web UI change together.

## Acceptance criteria

- **Faint text passes AA.** `--ink-faint` (timestamps, hints, counts, secondary labels) reaches 4.5:1 on paper, window, surface and surface-2 in every theme and preset. `contrast.test.ts` fails if a theme drops below.
- **One type scale.** Text sizes are 11, 12, 14, 16, 20 and 24px, as the theme tokens `text-2xs`, `text-xs`, `text-sm`, `text-base`, `text-xl` and `text-2xl` (and `var(--text-*)` in CSS). Nothing is set below 11px. No arbitrary `text-[Npx]` classes remain in the renderer; Tailwind's 18px (`lg`) and 30px (`3xl`) steps are gone. Sizes carry no line height of their own.
- **Tinted elevation.** Shadows come from four theme tokens (`--shadow-sm`, `--shadow-md`, `--shadow-float`, `--shadow-lift`), tinted with the theme's ink (light) or a near-black in the paper's hue (dark), blur about twice the offset. Tailwind's default black shadow scale is switched off. Resting cards have a border and no shadow.
- **4px spacing.** Padding, margin and gap sit on a 4px grid. The off-grid values (6, 10, 14, 18px, Tailwind's 1.5 / 2.5 / 3.5 steps) were rounded: vertical spacing down, horizontal and two-axis spacing up. 1px and 2px remain for hairlines. Geometry tied to something outside the grid (the Windows caption buttons, offsets paired with a border-spacing or a fixed width) is left as it was. `--pane-gap` is the single gap between panels, now 8px everywhere (it was 7px beside an 8px `--wall-gap`).

## Status

- Implemented: everything above.
- Not covered here: the iPhone draws its theme presets from `packages/shared/src/themes.ts`, whose `inkFaint` values still carry the old, lower-contrast greys. Updating them regenerates `apps/ios/App/Platform/ThemePresets.swift` and is left for an iOS change.
- Later passes under the same issue: readable chat measure, sentence-case labels, flat primary buttons, neutral menus and nav, and calmer navigation motion.
