# Instagram videos

Vertical (1080x1920, 30 fps) videos for Instagram, in the website's Dark look
(`spec/brand/colour-palette.md`): page `#0C0C11` with its plum glows, the
pixel-dot wave, panels `#16161C` / `#26262F`, white text, `#C99BB3` accent
text, the `#854F6C` to `#E6D0DC` headline gradient, and Nekko in his fixed
dark-mode colours. The website draws in CSS pixels, so the wave and glows are
scaled 2.75x here to look the same on a phone.

| Composition | Length | Shows |
| --- | --- | --- |
| `HeroReel` | 34 s | The website hero (`apps/website/media/hero-v2.mp4`) for launch day: "Meet Nekko." and the shipped features, "Built in Rust.", "It's fast. Like, really fast.", the six published speed results, then the whole-file rename replay (Nekko 2.5 s, Ollama 13.9 s, fast-forwarded after 5 s) and the end card |
| `Reel-dark` | 20 s | Pick a local model, ask, approve a risky step, done |

They are illustrations in the app's design, not screen recordings. The speed
numbers are the published medians from `docs/benchmarks` (the same as
`video/hero-intro`), and the replay says so on screen. Content stays between
y 200 and 1640, clear of Instagram's own overlays. There is no sound: add a
licensed track or an Instagram sound when posting.

    npm install
    npx remotion render src/index.tsx HeroReel out/nekko-hero-instagram.mp4 --codec=h264 --crf=18 --pixel-format=yuv420p
    npx remotion still src/index.tsx HeroReel out/nekko-hero-instagram-cover.jpg --frame=120 --image-format=jpeg --jpeg-quality=90

`out/` is not committed. Fonts in `public/fonts` are copies of
`apps/website/fonts` (OFL-1.1). Preview with `npx remotion studio src/index.tsx`.
