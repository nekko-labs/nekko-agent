---
title: "Full-pane dot wave and pixel skeletons"
area: desktop
---

# Full-pane dot wave and pixel skeletons

[Dot wave implemented 2026-11-02; pixel skeletons implemented 2026-11-04. Verified in the isolated hidden Electron fixture on Windows at 125% scaling. Packaged builds, macOS and Linux unverified.]

## Empty-agent dot wave

User intent: the wave behind a new, empty agent read as slow and broken. It was one 720×360 image centred in the pane, so a tall or narrow agent window showed a cut-off band, and it crept 1px every ~0.6s, which looked stuck. It also landed on fractional device pixels at Windows display scaling, so dots came out uneven.

Supersedes the bounded-texture paragraph of [Quiet empty-agent decoration](../brand/mascot-polish-onboarding.md); everything else there (where the wave appears, first-send removal, the cat) is unchanged.

- The wave covers the whole agent pane at any size, on a 9px dot pitch drawn at whole device pixels so dots stay crisp and evenly sized at fractional display scaling.
- `[Revised 2026-11-04, #1663 and its follow-up]` It flows like water rather than sliding: every dot's brightness is recomputed each frame (about 20 a second) from Travis's original swell, `sin(x/110 - t*1.4 + sin(y/150 + t*0.5) * 1.6)`, with continuous time. The inner term shifts each row's phase, so neighbouring rows crest at different moments and the field undulates instead of moving as one block. Dots stay on the grid; only their brightness changes. Experimental themes run at half speed. This replaces the 2026-11-02 dot-matrix stepping (one whole column about every 190ms), which read as too slow, uneven and monotone down the whole pane. The wave's clock survives a pause, so it resumes where it stopped.
- The dot colour runs `from` to `to` across the pane and stays put while the wave moves through it.
- It still stops while the app is unfocused or hidden, while the pane is hidden or scrolled out of view, and under reduced motion (where it holds one still frame). The Background animation switch still removes it.

## Pixel skeletons

User intent: a loading placeholder should read as part of the same house style as the empty-agent wave (chunky ASCII-art pixels), not as a shimmering gradient row. The earlier page-level cover on rail-view switches was wrong on two counts: it treated a tab change as a page transition when the destinations load quickly, and it covered the whole main area when only specific panels are actually waiting for data.

- A rail-view switch no longer plays any full-pane cover. Each view mounts directly, and any panel that is still waiting for its data shows its own skeleton where that data will go.
- The skeleton uses the same block language as the wave: 16px cells, four ASCII-art shades (█ ▓ ▒ ░), the fuller two in the page's paper colour and the lighter two tinted with the theme accent over a faint radial glow. Cells are weighted toward the fuller shades so the card reads as a filled surface.
- On mount, the blocks dissolve in from clear over about 320ms, then stay still. Nothing animates while the skeleton is idle, so a wall of them stays cheap. When the data arrives, the caller swaps the skeleton for the real content.
- Reduced motion skips the dissolve-in and paints the resting pattern at once. The skeleton fills its container (devicePixelRatio and resizes handled), so the caller controls the frame.
- Used anywhere a shimmering gradient card used to sit: a remote photo that is loading, a model-placement plan being computed, a runtime-fit bar being measured.

Acceptance: an empty agent in a 460px-wide pane shows dots top to bottom; dots are crisp at 125% scaling; the wave flows while focused and freezes on blur, hidden pane and reduced motion; a rail-view switch mounts the new view directly with no page cover; a panel that is still loading shows a pixel skeleton in its place that dissolves in under 320ms. No settings, permissions, network access or stored data change.
