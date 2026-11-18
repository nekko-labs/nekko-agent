---
title: "Tooltips: one quiet style everywhere, rich tips for PRs and issues"
area: desktop
---

# Tooltips: one quiet style everywhere, rich tips for PRs and issues

User intent: Philip asked (2026-11-17) that hovering a PR in chat show more than the operating system's plain grey tooltip, in a richer design with rounded corners that matches our colours and quiet design, and that every tooltip in the app use that style ([#2955](https://github.com/nekko-labs/nekko-agent/issues/2955)). Applies to the shared renderer, so the desktop app and the Local Web UI change together.

## Acceptance criteria

- **One style.** Every tooltip is one small floating surface, styled like a popover: `--surface` with the popover shadow and its faint edge, 10px squircle corners (12px for a rich tip), 12/500 `--ink` text, short words on one line and long ones wrapped at 320px. No border box, no system tooltip.
- **Every `title` too.** Controls that still use the native `title` attribute (most of the app) show the same tip, without each call site changing. While the pointer or keyboard focus is on such an element its `title` waits in `data-title-tip`, so the system tooltip never appears alongside it, and it comes back when the pointer leaves. An icon-only control whose only name was its title keeps that name as `aria-label` while it is held. A large element (wider than 320 or taller than 48px) gets its tip under the pointer instead of under its centre. `data-native-title` opts an element out.
- **Timing.** A tip shows after the pointer rests 350ms, at once on keyboard focus, and at once with no motion when moving from one tip to the next within 600ms. A press, a scroll, Escape or leaving hides it; after a press it stays hidden until the pointer leaves and comes back, as the system tooltip does.
- **Motion.** The tip fades in and moves 4px out from its anchor, from 0.98 scale, over 200ms on `--ease-out`. Reduced motion keeps only the fade.
- **PR tips.** Hovering a PR chip, in a reply or on an agent card, shows the PR's state glyph and word in the state's colour with `owner/repo #N` beside it, then the title (up to three lines). While the PR is open or a draft a faint line adds its size (`+184 −37`, in the success and danger text colours), the number of files and its checks (passing, failing or running). A merged or closed PR leaves that line out. Before the state is read, the tip shows the repo and number.
- **Issue tips.** An issue chip shows the issue's state glyph and word (open, done, not planned), `owner/repo #N` and the title.
- Tips render in a portal at a fixed position, so no panel clips them, and they flip to the other side and stay inside the window when there is no room.

## Status

`[implemented 2026-11-17; unit-tested (placement, pointer anchoring for large elements, PR tip content, chips no longer carrying a native title); verified in a hidden, off-screen Electron fixture against the base revision (default theme: open, merged and issue chips, a native-title button, a HoverTip control, the entrance stepped frame by frame); not yet checked in the packaged app or the Local Web UI]`
