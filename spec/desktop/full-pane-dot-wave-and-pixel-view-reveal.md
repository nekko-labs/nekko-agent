---
title: "Full-pane dot wave and pixel view reveal"
area: desktop
---

# Full-pane dot wave and pixel view reveal

[Implemented 2026-11-02; verified in the isolated hidden Electron fixture on Windows at 125% scaling. Packaged builds, macOS and Linux unverified.]

## Empty-agent dot wave

User intent: the wave behind a new, empty agent read as slow and broken. It was one 720×360 image centred in the pane, so a tall or narrow agent window showed a cut-off band, and it crept 1px every ~0.6s, which looked stuck. It also landed on fractional device pixels at Windows display scaling, so dots came out uneven.

Supersedes the bounded-texture paragraph of [Quiet empty-agent decoration](../brand/mascot-polish-onboarding.md); everything else there (where the wave appears, first-send removal, the cat) is unchanged.

- The wave covers the whole agent pane at any size, on a 9px dot pitch drawn at whole device pixels so dots stay crisp and evenly sized at fractional display scaling.
- `[Revised 2026-11-04, #1663 and its follow-up]` It flows like water rather than sliding: every dot's brightness is recomputed each frame (about 20 a second) from Travis's original swell, `sin(x/110 - t*1.4 + sin(y/150 + t*0.5) * 1.6)`, with continuous time. The inner term shifts each row's phase, so neighbouring rows crest at different moments and the field undulates instead of moving as one block. Dots stay on the grid; only their brightness changes. Experimental themes run at half speed. This replaces the 2026-11-02 dot-matrix stepping (one whole column about every 190ms), which read as too slow, uneven and monotone down the whole pane. The wave's clock survives a pause, so it resumes where it stopped.
- The dot colour runs `from` to `to` across the pane and stays put while the wave moves through it.
- It still stops while the app is unfocused or hidden, while the pane is hidden or scrolled out of view, and under reduced motion (where it holds one still frame). The Background animation switch still removes it.

## Pixel view reveal

User intent: switching rail views (Agents, Artifacts, Models, Settings, ...) showed the new view's layout shifting as it settled. Cover that with a fast skeleton transition: a subtle colour aura, ASCII-art-style chunky pixels resolving into view.

- On every rail view change, the main area is covered in the same frame the new view mounts, in 16px blocks of the page's paper colour with a faint radial glow of the theme accent.
- After a 60ms hold, blocks clear from the centre outwards with per-block jitter (no visible ring). Each block steps down through four shades, like ASCII art's █ ▓ ▒ ░: solid, then a slightly inset block, then smaller accent-tinted blocks, then clear. Everything is clear 300ms after the switch.
- The cover never takes input: clicks and keys reach the new view at once. Nothing is drawn while idle. Reduced motion skips it, and the first view at launch does not play it.

Acceptance: an empty agent in a 460px-wide pane shows dots top to bottom; dots are crisp at 125% scaling; the wave flows while focused and freezes on blur, hidden pane and reduced motion; a view switch is covered on its first frame and clear within 300ms. No settings, permissions, network access or stored data change.
