# Style notes: what the concept animations reuse

Source of truth: the six website pillar demos, `video/pillars/` (Remotion 4.0.541, React 19).
They render to `apps/website/media/pillar-*.mp4` and play in the "Why Nekko" pillar tour
(`apps/website/index.html` ~line 227, `site.js` advances every 8 s).

Note: the headlines named in the brief ("See what it sends", "Know if it fits", "Changed your mind?")
do not exist anywhere in the repo (git grep, 2026-11-20). The pillar tour titles are
"Built for local models", "Fast. Really fast.", "Your data stays yours", "One fleet, every machine",
"Take it anywhere", "Your own image studio". The headlines in these concepts follow that tone.

## Format
- 1280x720, 30 fps. Pillars are 240 frames (8 s); concepts are 240 to 330 frames (8 to 11 s).
- Loop: the whole scene fades in from `paper` over frames 0 to 10 and out over the last 12
  (`Stage` in `video/pillars/src/index.tsx`). Start and end frames are the plain background, so it loops cleanly.
- Dark and light versions of every demo (`-dark` / `-light` compositions).

## Tokens (`video/pillars/src/kit.tsx` → `THEMES`, from `apps/desktop/src/renderer/styles.css`)
- Dark: paper `#0c0c11`, win `#17171e`, surface `#16161c`, surface2 `#20202a`, ink `#eceaf3`, soft `#a3a1b0`,
  faint `#898894`, line `#26262f`, accent `#c084b5`, ok `#4cc38a`, warn `#e5a54b`.
- Light: paper `#fbfbfd`, ink `#17171d`, accent `#5a2352`, ok `#1f8a55`, warn `#a8650c`.
- Petrol (info, third series): `#6BB8D4` dark / `#1F6680` light (`spec/brand/colour-palette.md`). Concepts use it
  only for the "frontier / cloud" side of a split, as the palette's third series.
- Retired colours (lavender, aqua, mint, rose) are not used.

## Type
- Inter Tight for UI (`SANS`), JetBrains Mono for numbers, paths, code (`MONO`); fonts from `video/pillars/public/fonts`.
- Sizes as in the pillars: region label 22/500 `soft` (`Label`), big title 30/600 (Fleet "Your fleet"),
  body 21 to 25, meta 16 to 18 `faint`, big counters MONO 64/600 (Speed lane).
- Sentence case, never tracked caps.

## Motion
- One curve: `ease = Easing.bezier(0.22, 1, 0.36, 1)`; `p(f, a, b)` eased 0→1.
- `In`: fade + 8px un-blur + 14px rise over 12 frames. Things enter staggered 6 to 8 frames apart.
- `typed()` typewriter for prompts; caret is a 2px accent left border.
- Progress bars: 4px tall, radius 2, `surface2` track, accent fill (Speed / Fleet). Skeleton reply lines: 10px pills.
- Status: `Dot` (10px, optional pulse ring), `Check` (accent or ok), "Working…" → "✓ Done".

## Layout (docs/design-system.md, "quiet surfaces")
- Space and type separate things; a 1px `line` hairline between regions of different kinds (Speed's centre rule).
- Only objects get boxes: `AppWindow` (radius 16, title row with the pixel cat), `Composer`, code blocks (`codeBg`).
- Side-by-side comparisons: two lanes at x=60 and x=680, 540 wide, hairline at x=660 (Speed).
- Left label at (60, 52), content from y=96.
- Footer meta: MONO 15 `faint` at bottom 22 (Speed's source line). Concepts put "Illustrative numbers" there.

## Mascot
- Only `Cat` from kit.tsx (the app's `PixelHead`, colours fixed per `spec/brand/colour-palette.md`), used unmodified,
  `open` or `happy` eyes as the pillars do. He is "he".

## Concept-only additions (minimal)
- "Concept" tag, top-right: MONO 15, `faint`, 1px `line` border, radius 8 — the same treatment as the pillar
  footer meta, made into a small tag.
- Headline: 30/600 ink at (60, 46), like Fleet's "Your fleet". Pillars carry their headline in the website
  tour, not in the video; the concepts put it on screen because they're reviewed standalone.
