---
title: "Full-pane dot wave and pixel view reveal"
area: desktop
---

# Full-pane dot wave and pixel view reveal

[Implemented 2026-11-02; verified in the isolated hidden Electron fixture on Windows at 125% scaling. Packaged builds, macOS and Linux unverified.]

## Empty-agent dot wave

User intent: the wave behind a new, empty agent read as slow and broken. It was one 720×360 image centred in the pane, so a tall or narrow agent window showed a cut-off band, and it crept 1px every ~0.6s, which looked stuck. It also landed on fractional device pixels at Windows display scaling, so dots came out uneven.

Supersedes the bounded-texture paragraph of [Quiet empty-agent decoration](../brand/mascot-polish-onboarding.md); everything else there (where the wave appears, first-send removal, the cat) is unchanged.

- The wave covers the whole agent pane at any size. One seamless tile (80×40 dots on a 9px pitch, repeating in both directions) is drawn once per display scale, at whole device pixels, and copied across the pane.
- It moves like a dot-matrix sign: the pattern advances one dot column at a time, about every 190ms at the default speed (Experimental themes half that), so dots never leave the grid or blur. Each step only copies the tile; nothing is recomputed per dot.
- The dot colour runs `from` to `to` across the pane and stays put while the wave moves through it.
- It still stops while the app is unfocused or hidden, while the pane is hidden or scrolled out of view, and under reduced motion (where it holds one still frame). The Background animation switch still removes it.

## Pixel view reveal

User intent: switching rail views (Agents, Artifacts, Models, Settings, ...) showed the new view's layout shifting as it settled. Cover that with a fast skeleton transition: a subtle colour aura, ASCII-art-style chunky pixels resolving into view.

- On every rail view change, the main area is covered in the same frame the new view mounts, in 16px blocks of the page's paper colour with a faint radial glow of the theme accent.
- After a 60ms hold, blocks clear from the centre outwards with per-block jitter (no visible ring). Each block steps down through four shades, like ASCII art's █ ▓ ▒ ░: solid, then a slightly inset block, then smaller accent-tinted blocks, then clear. Everything is clear 300ms after the switch.
- The cover never takes input: clicks and keys reach the new view at once. Nothing is drawn while idle. Reduced motion skips it, and the first view at launch does not play it.

Acceptance: an empty agent in a 460px-wide pane shows dots top to bottom; dots are crisp at 125% scaling; the wave advances while focused and freezes on blur, hidden pane and reduced motion; a view switch is covered on its first frame and clear within 300ms. No settings, permissions, network access or stored data change.
