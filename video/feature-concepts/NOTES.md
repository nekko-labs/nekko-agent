# Feature concepts: notes

## Summary

- **Built: 16 of 16** concept animations (A1, A2, B1–B3, C1–C5, D, E1, E2, F, G, H), each in dark and light,
  8 to 10 s, 1280x720, 30 fps, looping (fade in from and out to the background, like the pillars).
- **Gallery:** `.scratch/feature-concepts/index.html` (Dark/Light toggle; videos autoplay; posters are the stills).
- **Stills:** `.scratch/feature-concepts/stills/<id>.png` and `<id>-light.png`.
- **Videos:** `.scratch/feature-concepts/<id>/<id>.mp4` and `<id>-light.mp4`. See `render-videos.log` and
  `render-errors.log` (only present if something failed).
- **Source:** `.scratch/feature-concepts/remotion/` (Remotion, same version and setup as `video/pillars`).
  Re-render: `cd .scratch/feature-concepts/remotion; node render.mjs [stills|videos|all] [id-prefix]`.
  Its `node_modules` is a junction to `video/pillars/node_modules`; fonts and the photo come from
  `video/pillars/public` via `--public-dir`. No existing file was changed.

**Strongest three**
1. **A1 Same task. Less sent.** The two big counters make the point in one glance and reuse the Speed pillar almost exactly.
2. **G Use any model. Keep your data.** The four-step loop (write, model reads, model answers, you see) reads clearly, and "Everything else goes through as you wrote it" makes it screening, not blocking.
3. **C5 Game pipeline.** The fan-out and fan-in is clear, and the folder filling up is a satisfying ending.

**Weakest three**
1. **F Three Macs. One brain.** Laptop outlines plus two bars is thin; it shows parallel work more than "one brain", and needs a better visual for pooled memory/compute.
2. **B3 Change it by asking.** The edits (rounder corners, palette collapse) are subtle at gallery size, and the cat badge is a generic cat that a viewer could confuse with Nekko.
3. **E1 Cloud sync.** Correct but static: two lists and dots. It could use the real app windows on both devices.

## Decisions made without asking

- **Tech:** the pillar demos are Remotion compositions rendered to MP4 (`video/pillars`), so these are too. I import
  `video/pillars/src/kit.tsx` unchanged (tokens, fonts, `p`, `In`, `typed`, `Cat`, `Dot`, `Check`) and copy its
  unexported `Stage`, `Label`, `AppWindow`, `Composer` and the Photo pillar's `Resolving` into `remotion/src/ckit.tsx`
  and `cloud.tsx`.
- **Headlines on screen:** the pillar videos carry no headline (the website tour shows it beside the video). The brief
  asks for one, so each concept puts it top left at 30/600, like the Fleet pillar's "Your fleet".
- **The example headlines in the brief** ("See what it sends", "Know if it fits", "Changed your mind?") are not in the
  repo; the dot wave is the hero `<canvas id="pixelwave">`. I matched the six real pillars instead.
- **"Concept" tag:** top right on every frame (MONO 15, faint, hairline border). It sits outside the fade so it is always visible.
- **"Illustrative numbers":** in the footer (bottom right, the Speed pillar's source-line style) on every concept that
  shows token counts, costs, file sizes, times or counts. Scenes with no numbers have no tag.
- **No logos.** Model names are plain text (Claude, Opus 5.5, Qwen3 8B, FLUX.2 klein 4B), as the pillars already do.
- **Nekko:** only the kit's `Cat` (the app's PixelHead), unmodified, inside `AppWindow` title rows and in E2. The cats in
  B1 and B3 are user-generated logo content, drawn deliberately in a different (line / rounded) style.
- **Generated assets** (fox, tiles, items, chest, B3's badge colours) use their own game colours. All interface around them uses app tokens.
- **Petrol** (`#6BB8D4` / `#1F6680`, the palette's info / third series) marks the frontier model in H, the image
  sub-agent in D and return trips. Plum accent marks local.
- **Models named:** Qwen3 8B / 4B for local text, FLUX.2 klein 4B for images (both already used in the pillars),
  Opus 5.5 for frontier. The sprite, mesh and sound sub-agents are labelled generically ("pixel model", "mesh model",
  "sound model") because I don't know which models Nekko will ship.

## Per animation

| ID | What it shows | Reused from | Assumptions / issues |
|---|---|---|---|
| A1-fusion-tokens | Two lanes, same 4-step task. Left sends every step to Claude; right runs 3 steps on Qwen3 8B locally. Live token and cost counters, "36,300 handled locally". | Speed pillar lanes, counter, hairline, footer; Fleet status dots and bars | Cost at an illustrative $15/M tokens. Assumes Fusion splits by step. |
| A2-fusion-what-leaves | A code file scanned line by line. Left: all 13 lines leave, key and emails flagged "sent". Right: only the 5-line function leaves; key and emails get a lock. Same answer. | Speed lanes; Privacy pillar lock; code block style | Assumes the local model selects context. |
| B1-svg-logo | Prompt "Minimal cat logo for a coffee shop"; a 5-path logo draws stroke by stroke, then fills. | Photo pillar layout (chat left, result right), Composer, AppWindow | Stroke-dash drawing via `pathLength`. |
| B2-svg-icon-set | Six line icons (home, search, notes, settings, share, trash) draw in one style. | Same as B1 | Icons hand-drawn by me on a 24 grid. |
| B3-svg-edit-by-chat | Badge; "Make it rounder" morphs corners and ears; "Two colours only" collapses the palette swatches; v1/v2/v3 chips. | Photo pillar "Then edit it"; Local pillar selection pill | Edits are subtle; see weakest. |
| C1-game-sprites | 10-frame pixel fox sheet (idle 4, run 6) appears cell by cell; preview plays idle then run at 10 fps with a moving ground. | Photo pillar layout; Local pillar selection highlight | Fox pixel art drawn by me. Sheet cells are small at gallery size. |
| C2-game-2d-assets | Tiles, items, UI appear as groups, then assemble into a small scene strip with the fox. | Group labels and staggered `In` | |
| C3-game-3d-asset | A 16-vertex chest builds as a plum wireframe, then shades and turns on a turntable. | Photo pillar layout | Real 3D projection with painter's sort; flat shading per face, no lighting. |
| C4-game-audio | Three waveforms draw in, then each plays with a playhead. | Bars and labels | No actual audio (pillars are silent too). |
| C5-game-pipeline | Prompt → main agent → 4 sub-agents (Sprites, Tiles, 3D, Audio) with progress → files flow into `forest-level/`. | Fleet lanes, status lines | |
| D-two-models | Qwen3 8B parent writes the intro, sends a brief to the FLUX.2 image sub-agent (right), the picture resolves step by step and returns into the chat. | Photo pillar `Resolving` and its real FLUX.2 picture (`desk-night.png`) | Picture is the real Photo pillar output, labelled in the footer. |
| E1-cloud-sync | MacBook lists (Chats with lock, Library, Artifacts, Photos) sync through "Nekko Cloud · encrypted on your device" to an iPhone. **No video shown.** | Privacy pillar lock and copy tone; Fleet rows and bars | "We can't read it" assumes end-to-end encryption, as the phone relay already claims. Counts illustrative. |
| E2-cloud-optional | Offline local chat works with no account; then Settings › Nekko Cloud switch turns on and the four categories sync. | Local pillar chat; app switch per design system (36x20 drawn larger) | "optional and paid" in the footer. |
| F-fleet-pooling | Three Mac laptops link; one task (index 200 h of interviews): one Mac ~9 h vs pooled ~3 h. | Fleet pillar wording, bars, footer | Simplified laptop outline drawn by me. Shows work split, not memory pooling. |
| G-privacy-shield | Prompt with a name, email and key → Shield masks them locally → Claude reads placeholders → answers with placeholders → real values restored. | Privacy pillar (marking underline, placeholder chips, wording) | Placeholder names `[NAME_1]` style, close to the Privacy pillar's `[PII_EMAIL_1]`. |
| H-model-routing | "Ship the sync refactor" splits into 5 parts; 3 go to Qwen3 8B local, 2 to Opus 5.5; both lanes finish; one answer. | Fleet lanes, Speed hairline | Routing rule (easy vs hard) shown as fact, no explanation. |

## What didn't work / was changed

- First C3 render looked at the chest from below (tilt sign); fixed.
- The composer's model row wrapped in the narrower C-scene chat windows; shortened to "Qwen3 8B · Local" there.
- C5's still landed in the fade-out; moved the still frame.
- Video render results: see `render-videos.log`.

## Update 2026-11-20 (after dev feedback)

- "Claude + Nekko local" renamed "Claude + Nekko Agent" (A1, A2): "Nekko local" read like our own model.
- Every local text model is now Qwen3-32B (was Qwen3 8B / 4B), with the machine named once in each footer:
  "Qwen3-32B on MacBook Pro M5 Max, 64 GB". G, E1 and F show no local model and have no machine line.
- B1/B2 footer "Small model, no upload" became "Made on this computer, no upload".
- Swap in the benchmarked model and real numbers once Fusion is tested against Claude.
