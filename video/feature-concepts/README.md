# Feature concept videos

Concept animations for Nekko Agent features, in the website pillar style, plus two launch-style tests
(`G-launch`, `what-is-nekko`). Remotion 4.0.541, the same setup as `video/pillars`, whose `kit.tsx`,
fonts and photos this project reuses. See `NOTES.md` for what each animation shows and `STYLE-NOTES.md`
for the style rules. Videos (`*.mp4`) are not committed; render them as below. `stills/` has a PNG of each.

## First time on a Mac

Needs Node 20 or later (`brew install node`).

```sh
cd video/feature-concepts/remotion
npm run setup        # installs video/pillars' packages and links them here
```

## Edit and preview

```sh
npm run studio       # opens Remotion Studio in the browser, with every composition
```

Sources are in `remotion/src/`: `fusion.tsx` (A1, A2, G, H), `svg.tsx` (B1–B3), `game.tsx` (C1–C5),
`orchestra.tsx` (C6), `cloud.tsx` (D, E1, E2, F), `launch.tsx` (G-launch), `whatis.tsx` (What is Nekko Agent?).
The list of concept scenes is `remotion/src/scenes.tsx`.

## Render

```sh
npm run render                 # every concept, stills and MP4s, dark and light
node render.mjs videos C6      # one concept (id prefix); "stills" for PNGs only
npm run render:what-is         # the 30 s "What is Nekko Agent?" film
npm run render:g-launch        # the Privacy Shield launch test
```

`render.mjs` skips MP4s that already exist; delete one to render it again. Output goes to `<id>/<id>.mp4`.
`index.html` is a local gallery of the rendered videos.
