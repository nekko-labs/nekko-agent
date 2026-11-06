---
title: "Empty wall opens the new-chat screen; glass prism composer (2026-10-18)"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Empty wall opens the new-chat screen; glass prism composer (2026-10-18)

`[implemented; unit-tested; verified in an isolated hidden renderer (12 checks, dark and light, 1400px) with matched before/after captures; packaged app, narrow widths, multi-screen and macOS not checked]`

- **No more empty wall.** When the Agents wall has no windows (first launch with a provider set up, or the last window closed or completed), the main window switches to **Focused** and shows the new-chat screen ("What should we work on?") instead of "The wall is empty". It reuses the newest untouched chat (no messages, nothing queued, not completed, not an image, sub-agent, automation or training chat) before creating one, so emptying the wall repeatedly never piles up blank chats. It waits for the chat lists to load, does nothing while a completed chat is being read, does nothing on a second screen's window (those may be empty on purpose), and does nothing until a provider is set up (the setup path still applies). A failure is toasted once and not retried until the wall has had a window again. The "The wall is empty" placeholder remains only for those cases.
- **Glass prism composer.** The round radial halo behind the clean-start composer is gone. The page gets a full-surface, static diagonal prism gradient (theme accent through its partner colour to a soft pink), not separate corner orbs. A low-opacity, fixed-seed monochrome SVG noise layer sits over the gradient to reduce banding; it never intercepts pointer input, covers text, animates or fetches a remote resource. The composer itself is frosted glass: a translucent tint over a blur of that light, a top highlight, and a violet-cyan-teal-amber-pink prism hairline as its only edge, brighter while it has focus. Light themes use a whiter glass. `prefers-reduced-transparency` falls back to the solid window colour. Nothing animates, so the glass adds no per-frame repaint.
- Renderer-only: no new settings keys, host calls, permissions or network use. A new chat is created only through the existing create-session path.

## Full static gradient (issue #1108)

Implemented. Matching unchanged-base and working-tree Electron window captures in default dark at 1440×900 and 900×900 were inspected. The full-surface diagonal gradient and fixed-seed grain leave the glass composer and its prism edge intact. Automated renderer checks confirm the linear gradient, embedded SVG grain, no grain animation, pointer pass-through, visible composer bounds and successful typing. The sandbox is hidden, off-screen, non-focusable, network-blocked and uses a separate profile. The shared full-App fixture emits the same unrelated missing app-info/list-data warnings on base and head. Other themes, Windows/Linux and packaged rendering are not visually verified. Reproduce with `NEKKO_LAYOUT_SANDBOX=new-chat-gradient-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs`; point `NEKKO_TEST_SOURCE` at an unchanged archive for the baseline.
