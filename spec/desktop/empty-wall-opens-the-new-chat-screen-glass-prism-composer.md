---
title: "Empty wall opens the new-chat screen; glass prism composer (2026-10-18)"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Empty wall opens the new-chat screen; glass prism composer (2026-10-18)

`[implemented; unit-tested; verified in an isolated hidden renderer (12 checks, dark and light, 1400px) with matched before/after captures; packaged app, narrow widths, multi-screen and macOS not checked]`

- **No more empty wall.** When the Agents wall has no windows (first launch with a provider set up, or the last window closed or completed), the main window switches to **Focused** and shows the new-chat screen ("What should we work on?") instead of "The wall is empty". It reuses the newest untouched chat (no messages, nothing queued, not completed, not an image, sub-agent, automation or training chat) before creating one, so emptying the wall repeatedly never piles up blank chats. It waits for the chat lists to load, does nothing while a completed chat is being read, does nothing on a second screen's window (those may be empty on purpose), and does nothing until a provider is set up (the setup path still applies). A failure is toasted once and not retried until the wall has had a window again. The "The wall is empty" placeholder remains only for those cases.
- **Glass prism composer.** The round radial halo behind the clean-start composer is gone. The page gets soft, static prism light anchored off its corners (violet bottom-left, cyan top-right, a pink touch bottom-right), never a centred disc. The composer itself is frosted glass: a translucent tint over a blur of that light, a top highlight, and a violet-cyan-teal-amber-pink prism hairline as its only edge, brighter while it has focus. Light themes use a whiter glass. `prefers-reduced-transparency` falls back to the solid window colour. Nothing animates, so the glass adds no per-frame repaint.
- Renderer-only: no new settings keys, host calls, permissions or network use. A new chat is created only through the existing create-session path.

## Peeking greeting Nekko

`[implemented; isolated renderer interaction checks passed at 1280px and 460px; matched before/after renderer screenshots visually reviewed at both widths]`

- The new-chat greeting places Nekko to the left of “What should we work on?”, reusing the pixel head and edge-resting paws from Travis's website beta-signup design (PR #763). The eyes glance right toward the heading. Model Providers is unchanged.
- The small static SVG inherits the active theme's surface, ink, line and accent colors. It has no extra animation, settings, network requests, permissions or host calls.
- Acceptance: cat and heading remain side by side without clipping at desktop and narrow widths; the heading remains readable, the SVG is decorative and non-focusable, and composing a message still works. Existing clean-start visibility rules remain unchanged, so transcript views do not gain artwork.
- Verified through a synthetic full-App fixture with an isolated profile, blocked networking and a hidden, non-focusable Electron window. Packaged desktop and physical mobile devices are not part of this check. Native capture source enumeration failed on the host; evidence covers Electron renderer pixels, not OS window chrome.
