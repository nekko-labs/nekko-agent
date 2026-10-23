---
status: accepted
date: 2026-10-23
---

# 0015. Build the Experimental Dark themes on a 60 / 30 / 10 split with near-black panels

## Context

The Dark versions of the Experimental theme families ([spec](../../spec/code/rich-responses-reports-and-design-workspace.md#experimental-themes)) put one hue on everything: the brand colour as the ground, lighter tints of it for windows and panels, and the pale partner colour as the text. The colours were right, but at that intensity across the whole app the result was overwhelming (Philip, 2026-10-23; issue #896). Every token also has to keep the WCAG checks in `contrast.test.ts`.

## Options considered

1. **Keep the single-hue look and only lower saturation.** Smallest change. Still one colour everywhere, so the eye has nothing to rest on, and desaturating the ground loses the brand colour the families exist to try out.
2. **Neutral grey panels.** Calm and familiar. Grey on a coloured ground looks pasted on, the mismatch the tinted presets (`nebula`, `terminal`, `nord`) already guard against.
3. **60 / 30 / 10 with hue-tinted near-black panels.** 60% near-black windows and panels that keep the brand hue at very low chroma, 30% brand-coloured ground, 10% partner colour as accent only, near-white text.

## Decision

Option 3. Tokens are derived in OKLCH so equal lightness steps look equal across hues:

- Windows and panels: family hue, chroma 0.016, lightness 0.19 (`--win`, `--surface`), +0.045 (`--surface-2`), +0.13 (`--line`).
- Ground: the main colour capped at lightness 0.32 and chroma 0.11. On a ground already darker than 0.26 (Forest, Inkberry) the windows sit 0.06 lighter than the ground instead, since black panels would vanish into it.
- Text: lightness 0.965 / 0.88 / 0.74 (ink, ink-soft, ink-faint), chroma under 0.012.
- Accent: the partner colour, unchanged; `--on-accent` is the window colour.

Every text pairing is checked with the WCAG 2.x formula: all meet AA (lowest 4.8:1, ink-faint on Forest's surface-2), most meet AAA, and accent text and button labels are 9:1 or better.

## Consequences

- The brand colour now reads as a frame around the work, and the partner colour marks what is actionable, so the accent means something again.
- Windows sit only 1.2 to 1.4:1 off the ground; the border does the separating. If windows feel lost on the ground, raise `--line` before lightening `--win`.
- Blueberry and Quantum Dark now differ mostly by their ground and look close. If only one survives review, that is fine; if both do, push one hue apart.
- White and Colourful versions are unchanged. A new Dark family should derive its tokens the same way rather than tinting the ground.
