---
title: "Winter theme and its hidden extras (2026-11-09)"
area: brand
---

# Winter theme and its hidden extras (2026-11-09)

**User intent:** Philip asked (2026-11-09) for a Winter theme, similar to Spooky, with some Easter eggs hidden in it.

**Status `[implemented 2026-11-09 on desktop and the Local Web UI; renderer unit tests, contrast tests and hidden-sandbox screenshots. Native iOS and Android snow and mascot hats are implemented in source with Android builds and unit tests passing; hosted native screenshot, interaction and motion verification are pending. Limited Winter launcher icons remain follow-up work]`**

## The theme

- **Where it is.** Settings → Customize → Appearance (and the onboarding theme step) lists **Winter** under **Seasonal**, next to Spooky. Its preset id is `winter` (`THEME_PRESETS` in `packages/shared/src/themes.ts`).
- **Dark: a snowy night.** Midnight-blue ground and windows (`--paper` `#0a111d`, `--win` `#0f1828`, surfaces `#111b2b` / `#1a2638`, line `#233249`), cool near-white ink, an **ice-blue** accent (`#8fd3fe`) and an **aurora-mint** partner (`#9ef0c9`). Primary buttons take midnight text on the pale accent. Every text pairing meets WCAG AA (`contrast.test.ts`).
- **Light.** Like Spooky, the core light surfaces with deeper accents that stay readable on them: ice `#0a6694` and pine `#13795b` (`LIGHT_ACCENTS` in `themeMode.ts`).
- **Phones.** The iPhone and Android catalogs are written from the shared one, so both list Winter and apply its colours and, in dark mode, its surfaces.

## What everyone sees

All decoration is `aria-hidden`, never takes input, uses theme colours so it reads in light and dark, and stops moving under reduced motion.

- **Snow.** Eight faint flakes drift down behind the app on slow, staggered falls, with a soft snowdrift along the bottom edge (`WinterBackground.tsx`). It pauses while the window is hidden. Under reduced motion the flakes hang still.
- **Nekko's beanie.** The per-chat Nekko (the cat peeking over a chat's composer) wears a knitted cat-ear beanie: berry-red knit with V-stitch rows, its own knitted cat ears with pink insides (covering Nekko's real ears), a cream ribbed brim and a cream snowflake on the front. It was chosen from a design round of eight cat-ear beanies (oatmeal, ice-blue, striped, earflap, paw-patch and berry variants): the berry stands out best against Winter's midnight-blue at the 80px chat size, where the blue versions blend in. As with Spooky's wizard hat, the greeting cat, the empty-wall cat and the title-bar mark stay undressed.
- **Merged PRs.** A merged PR's banner scatters static snowflakes and snowmen.
- **The empty wall.** Snow lies along the top of the wall, icicles hang in the gaps above the frames, a few flakes are in the air and a snowman with a red scarf stands on the floor.

## Hidden extras

Not mentioned in the app or the user docs; they are for people to find. Each is local and decorative: no network, no sound, no settings change.

1. **Snowball.** On a new chat, tap the greeting Nekko three times within 1.5 seconds and he throws a snowball: it arcs up and away and bursts into a puff of flakes. Under reduced motion it just appears where it would land, then goes. The tap count restarts after each throw.
2. **The snow cat.** One of the falling flakes is Nekko's pixel head, falling more slowly than the rest and staying upright so its face reads.
3. **Snow piles up.** The drift along the bottom starts low and slowly grows over the first hour the app is open (it starts over on relaunch). Under reduced motion it stays at a fixed middle height.
4. **Aurora.** Between 22:00 and 04:00 local time, a faint aurora in the theme's two accents shimmers along the top of the window (checked every five minutes). Under reduced motion it is still.
5. **Christmas.** On December 24 and 25 the snowflake on Nekko's beanie becomes a holly sprig, and merged-PR confetti turns to trees, snowflakes and presents.
6. **Oshogatsu.** From January 1 to 3 the empty wall's snowman gives way to a kagami mochi (two rice cakes and a mikan on a sanbo stand), and merged-PR confetti turns to kadomatsu and snowflakes.

Dates and hours are the computer's local time. The rules live in `apps/desktop/src/renderer/seasonal.ts` (`seasonalHat`, `mergeConfetti`, `isChristmas`, `isShogatsu`, `isAuroraHour`, `snowballTap`), shared with Spooky's wizard hat and confetti.

## Acceptance

- Winter appears once, under Seasonal, after Spooky; choosing it keeps the current light/dark mode, as every palette does.
- Leaving Winter removes the snow, the hat, the confetti and the wall dressing at once.
- Only one hat at a time: the wizard hat is Spooky's, the knitted beanie Winter's, none on any other theme.
- Reduced motion: no falling, flying or shimmering; everything that remains is still.

## Native phone decorations (issue #2479)

- Both native apps resolve decorations from the same preset as the palette, including Match my computer. Winter shows eight faint, deterministic flakes with one upright cat-shaped flake. Positions scale to compact, unfolded and landscape windows rather than assuming a phone width.
- The chat/list toolbar mascot wears Winter's cat-ear knitted beanie or Spooky's wizard hat. The hat follows the mascot's existing working and greeting movement without changing its 44-point touch target, greeting action or accessibility Refresh action. Other themes have no hat. Greeting illustrations, launch screens and brand marks remain undressed.
- Phone hats use the native palette tokens: a muted berry crown, contrasting folded brim and snowflake for Winter; a dark crown and accent brim for Spooky. They are native adaptations, not new image dependencies.
- Snow and hats have no pointer handlers or accessible copy. Reduced motion holds snow still. The snow clock stops while iOS is inactive or Android is stopped. Leaving Winter removes its snow and replaces/removes the hat immediately.
- Decoration is local only: no network requests, sounds, persistent particles, notifications or settings writes. No date-based phone extras are added in this change.
- Verification status (2026-11-10): Android app/instrumentation builds and 592 unit tests passed locally. Eight matched phone/open-fold Winter/Spooky screenshots were inspected and published in PR #2480. Open-fold means the API 34 emulator in OPENED state, not folded, tabletop or hardware coverage. Android recordings still showed Launcher despite passing Compose snapshots; those movies are rejected, and an app-owned debug host is being tested. Strict reduced-motion equality passed in diagnostic runs, with an earlier intermittent fold resume mismatch still unexplained. Corrected iOS source compiles; 389 protocol tests and the hosted journey shard passed. Inspected iOS head attachments show seasonal decoration, but matched baseline review, actual motion publication, refresh assertions and remaining native shards are pending. Greeting polling passed; refresh assertions failed in Light as well as seasonal themes. No native shipped or fully device-verified claim is made.

## Not yet

- Winter extras on the phones: a limited Winter app icon (iOS alternate icon, Android activity alias) ([#2411](https://github.com/nekko-labs/nekko-agent/issues/2411)).
