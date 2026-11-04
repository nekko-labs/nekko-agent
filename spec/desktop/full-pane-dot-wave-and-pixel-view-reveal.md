---
title: "Full-pane dot wave and pixel skeletons"
area: desktop
---

# Full-pane dot wave and pixel skeletons

[Dot wave implemented 2026-11-02; pixel skeletons implemented 2026-11-04. Verified in the isolated hidden Electron fixture on Windows at 125% scaling. Packaged builds, macOS and Linux unverified.]

## Empty-agent dot wave

User intent: the wave behind a new, empty agent read as slow and broken. It was one 720×360 image centred in the pane, so a tall or narrow agent window showed a cut-off band, and it crept 1px every ~0.6s, which looked stuck. It also landed on fractional device pixels at Windows display scaling, so dots came out uneven.

Supersedes the bounded-texture paragraph of [Quiet empty-agent decoration](../brand/mascot-polish-onboarding.md); everything else there (where the wave appears, first-send removal, the cat) is unchanged.

- The wave covers the whole agent pane at any size. One seamless tile (80×40 dots on a 9px pitch, repeating in both directions) is drawn once per display scale, at whole device pixels, and copied across the pane.
- It moves like a dot-matrix sign: the pattern advances one dot column at a time, about every 190ms at the default speed (Experimental themes half that), so dots never leave the grid or blur. Each step only copies the tile; nothing is recomputed per dot.
- The dot colour runs `from` to `to` across the pane and stays put while the wave moves through it.
- It still stops while the app is unfocused or hidden, while the pane is hidden or scrolled out of view, and under reduced motion (where it holds one still frame). The Background animation switch still removes it.

## Pixel skeletons

User intent: a loading placeholder should read as part of the same house style as the empty-agent wave (chunky ASCII-art pixels), not as a shimmering gradient row. The earlier page-level cover on rail-view switches was wrong on two counts: it treated a tab change as a page transition when the destinations load quickly, and it covered the whole main area when only specific panels are actually waiting for data.

- A rail-view switch no longer plays any full-pane cover. Each view mounts directly, and any panel that is still waiting for its data shows its own skeleton where that data will go.
- The skeleton uses the same block language as the wave: 16px cells, four ASCII-art shades (█ ▓ ▒ ░), the fuller two in the page's paper colour and the lighter two tinted with the theme accent over a faint radial glow. Cells are weighted toward the fuller shades so the card reads as a filled surface.
- On mount, the blocks dissolve in from clear over about 320ms, then stay still. Nothing animates while the skeleton is idle, so a wall of them stays cheap. When the data arrives, the caller swaps the skeleton for the real content.
- Reduced motion skips the dissolve-in and paints the resting pattern at once. The skeleton fills its container (devicePixelRatio and resizes handled), so the caller controls the frame.
- Used anywhere a shimmering gradient card used to sit: a remote photo that is loading, a model-placement plan being computed, a runtime-fit bar being measured.

Acceptance: an empty agent in a 460px-wide pane shows dots top to bottom; dots are crisp at 125% scaling; the wave advances while focused and freezes on blur, hidden pane and reduced motion; a rail-view switch mounts the new view directly with no page cover; a panel that is still loading shows a pixel skeleton in its place that dissolves in under 320ms. No settings, permissions, network access or stored data change.
