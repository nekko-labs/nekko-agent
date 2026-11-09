---
title: "Winter theme and its hidden extras (2026-11-09)"
area: brand
---

# Winter theme and its hidden extras (2026-11-09)

**User intent:** Philip asked (2026-11-09) for a Winter theme, similar to Spooky, with some Easter eggs hidden in it.

**Status `[implemented 2026-11-09 on desktop and the Local Web UI; renderer unit tests, contrast tests and hidden-sandbox screenshots. The iPhone and Android apps get the palette from the shared catalog; Winter's phone extras (a limited app icon like Spooky's) are follow-up work, not claimed here]`**

## The theme

- **Where it is.** Settings → Customize → Appearance (and the onboarding theme step) lists **Winter** under **Seasonal**, next to Spooky. Its preset id is `winter` (`THEME_PRESETS` in `packages/shared/src/themes.ts`).
- **Dark: a snowy night.** Midnight-blue ground and windows (`--paper` `#0a111d`, `--win` `#0f1828`, surfaces `#111b2b` / `#1a2638`, line `#233249`), cool near-white ink, an **ice-blue** accent (`#8fd3fe`) and an **aurora-mint** partner (`#9ef0c9`). Primary buttons take midnight text on the pale accent. Every text pairing meets WCAG AA (`contrast.test.ts`).
- **Light.** Like Spooky, the core light surfaces with deeper accents that stay readable on them: ice `#0a6694` and pine `#13795b` (`LIGHT_ACCENTS` in `themeMode.ts`).
- **Phones.** The iPhone and Android catalogs are written from the shared one, so both list Winter and apply its colours and, in dark mode, its surfaces.

## What everyone sees

All decoration is `aria-hidden`, never takes input, uses theme colours so it reads in light and dark, and stops moving under reduced motion.

- **Snow.** Eight faint flakes drift down behind the app on slow, staggered falls, with a soft snowdrift along the bottom edge (`WinterBackground.tsx`). It pauses while the window is hidden. Under reduced motion the flakes hang still.
- **Nekko's beanie.** The per-chat Nekko (the cat peeking over a chat's composer) wears a blue knit beanie with a white pompom, ears poking out either side. As with Spooky's wizard hat, the greeting cat, the empty-wall cat and the title-bar mark stay undressed.
- **Merged PRs.** A merged PR's banner scatters static snowflakes and snowmen.
- **The empty wall.** Snow lies along the top of the wall, icicles hang in the gaps above the frames, a few flakes are in the air and a snowman with a red scarf stands on the floor.

## Hidden extras

Not mentioned in the app or the user docs; they are for people to find. Each is local and decorative: no network, no sound, no settings change.

1. **Snowball.** On a new chat, tap the greeting Nekko three times within 1.5 seconds and he throws a snowball: it arcs up and away and bursts into a puff of flakes. Under reduced motion it just appears where it would land, then goes. The tap count restarts after each throw.
2. **The snow cat.** One of the falling flakes is Nekko's pixel head, falling more slowly than the rest and staying upright so its face reads.
3. **Snow piles up.** The drift along the bottom starts low and slowly grows over the first hour the app is open (it starts over on relaunch). Under reduced motion it stays at a fixed middle height.
4. **Aurora.** Between 22:00 and 04:00 local time, a faint aurora in the theme's two accents shimmers along the top of the window (checked every five minutes). Under reduced motion it is still.
5. **Christmas.** On December 24 and 25 Nekko's beanie becomes a Santa hat whose tip flops over his right ear, and merged-PR confetti turns to trees, snowflakes and presents.
6. **Oshogatsu.** From January 1 to 3 the empty wall's snowman gives way to a kagami mochi (two rice cakes and a mikan on a sanbo stand), and merged-PR confetti turns to kadomatsu and snowflakes.

Dates and hours are the computer's local time. The rules live in `apps/desktop/src/renderer/seasonal.ts` (`seasonalHat`, `mergeConfetti`, `isChristmas`, `isShogatsu`, `isAuroraHour`, `snowballTap`), shared with Spooky's wizard hat and confetti.

## Acceptance

- Winter appears once, under Seasonal, after Spooky; choosing it keeps the current light/dark mode, as every palette does.
- Leaving Winter removes the snow, the hat, the confetti and the wall dressing at once.
- Only one hat at a time: the wizard hat is Spooky's, the beanie (or Santa hat) Winter's, none on any other theme.
- Reduced motion: no falling, flying or shimmering; everything that remains is still.

## Not yet

- Winter extras on the phones: a limited Winter app icon (iOS alternate icon, Android activity alias) and the beanie on the phone mascots ([#2411](https://github.com/nekko-labs/nekko-agent/issues/2411)).
