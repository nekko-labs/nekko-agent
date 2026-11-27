---
title: "Brand pack, press kit and trademark policy (2026-11-28)"
area: brand
---

# Brand pack, press kit and trademark policy

`[implemented in source; docs build and tests pass locally; not deployed]` Requested by Philip (#3605): a brand pack others can use to reference our icons and branding in articles and the like, with the right licensing and guidelines. Decision: [0126](../../docs/decisions/0126-brand-assets-under-a-trademark-policy-not-mit.md).

## What people get

- **The files** at `nekkoagent.com/brand/<file>`, committed in `apps/website/brand/`: the cat mark (plum gradient, plum, white, black), the NEKKO AGENT lockup (light, white, black), the app icon, and Nekko the mascot (dark and light), each as SVG and as PNG on a transparent ground (1024 px wide; lockups 2400 px). The social banner (`docs/brand/nekko-banner-1280x640.png`) is copied beside them on deploy.
- **One zip** of everything, `nekkoagent.com/brand/nekko-agent-brand-pack.zip`, with the license and a README listing each file's use. Built on deploy by `scripts/build-docs.mjs` (`writeBrandZip`), gitignored, byte-for-byte reproducible (fixed dates, deflate).
- **The page** [/docs/brand](../../docs/hub/brand.md) ("Brand and press kit", Introduction section): the download, an overview sheet of each file on its ground, a file table, which file on which ground, clear space and minimum sizes, a "please don't" sheet, the mascot rules, colours, fonts, how to write the names, a one-line and a one-paragraph description to paste, and the contact address. `/brand`, `/press`, `/press-kit` and `/media-kit` redirect to it.
- **The policy** [/docs/trademarks](../../TRADEMARKS.md) (`TRADEMARKS.md`, Contributing section, after Credits): who owns the names and marks, that MIT covers the code and not the marks, what is fine without asking, what needs permission, what is never allowed, what forks must change, and the brand pack license itself. `apps/website/brand/LICENSE.md` is the short form that travels in the zip; the policy wins where they differ.
- The README's License section and the credits page (`ASSETS.md`) point to the policy.

## Rules the pack follows

- **One source per drawing.** The marks and icon come from `apps/desktop/scripts/icon-art.cjs` (the app's own icon source), Nekko from the website's pixel head, coloured exactly as the mascot rule in [the colour palette](colour-palette.md#nekko-the-mascot-read-this-first) says (dark face on dark grounds, white face on light grounds, never mixed). The wordmark is Inter Tight 800 at 0.14em, as in the website nav, outlined once into `scripts/brand-kit/wordmark.json`.
- **Regenerate, never hand-edit.** `node scripts/make-brand-kit.mjs` writes the SVGs, PNGs (via `rsvg-convert`, a build tool only) and the two docs sheets (`docs/brand/brand-pack-overview.png`, `brand-pack-misuse.png`). `--check` fails on a stale SVG; `scripts/brand-kit.test.mjs` runs it, and checks Nekko's colours, the zip's contents, and that the docs page links every file. `--wordmark` re-outlines the wordmark (needs `npm i --no-save fontkit@2.0.4 wawoff2@2.0.1`).
- **Caching.** Files under `/brand/` are cached for an hour, not a year like other images, so a regenerated file reaches people the same day under the same name.

## Licensing boundaries

- The code stays MIT. The brand assets (names, cat mark, lockup, app icon, Nekko and his likeness) are owned by Nekko Labs (G.K. and LLC) and licensed only under the brand pack license: free, non-exclusive, revocable, unmodified files, to refer to Nekko Agent or Nekko Labs.
- Source files that draw the marks stay MIT as code; a modified build shared with others must replace the name, icon and mascot. Unmodified official builds may be repackaged under the name.
- Personal, labelled, non-commercial fan art of Nekko is allowed; any other new depiction, merchandise, advertising, or implied endorsement needs written permission from hello@nekkoagent.com.
- Other companies' marks shown in the app or screenshots are theirs and outside the license.

## Not done / open

- Not deployed; the zip, the redirects and the `/brand/` cache rule are unverified on Vercel.
- The terms have not been reviewed by a lawyer in Japan or the US. No trademark registrations are claimed, so the policy uses no ® symbol.
- No product screenshots or videos in the pack: the page points to the walkthrough. A curated screenshot set is a possible follow-up.
- No Japanese version of the page or policy.
