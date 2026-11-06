---
title: "Stay out of the way of full-screen apps (games)"
area: desktop
---

# Stay out of the way of full-screen apps (games)

**User intent.** Nekko Agent running, in any form, must not affect other programs. A user saw
Overwatch drop from 200-300 FPS to 60-90 while Nekko ran, and only a game restart restored it.
The suspected cause: Nekko brought something forward over the exclusive-fullscreen game (a
"finished" toast at a turn's end matched the second the game lost focus in its log). This is
one data point and has not been reproduced: Windows toasts do not take the foreground, and
Windows already holds its toast banners during a Direct3D fullscreen game. The drop also
lasted after Nekko quit, until the game restarted. A process spawn storm
(`nvidia-smi` and `where` every 6 s, each with a console host) added CPU wakeups beside it.
Investigation: `.scratch/ow/` (local), issue linked from the PR.

**Behavior (implemented, Windows).**

- nekkod answers `activity:fullscreen` with `{ quiet, state }` from
  `SHQueryUserNotificationState`: quiet only for a Direct3D exclusive-fullscreen app. Another
  full-screen app (busy: borderless games, F11 browsers, video) and presentation mode are
  reported in `state` but are not quiet. Elsewhere, and when it cannot be read, it is never
  quiet. It never says which app.
- While quiet, the desktop's native notices are held and delivered when it ends, the newest per
  chat and kind. Nothing is dropped.
- Windows are never held. Every window Nekko brings forward follows something the user did (a
  launch, a second launch, a link, the tray). Holding them (as first shipped in #1296) made the
  app look like it had not started while any full-screen app was in front, held links clicked
  in a full-screen browser, and then took the foreground at a moment nobody chose when the
  full-screen app went away.
- Notices are not held while one of Nekko's own windows has focus, or without an answer within
  400 ms (service stopped or still starting): the previous behavior.
- The tray's 6 s refresh asks `engine:running` and `engine:installedBin(runtime)` instead of
  `engine:status`, so it no longer probes the GPU or searches for runtimes.
  `engine:installedBin` takes an optional runtime (`llama` by default, as before).
- Runtime lookups on PATH (`where`/`which`) are searched in the daemon's own process, with the
  same rules (Windows: the current folder first, then PATH, a bare name only with a `PATHEXT`
  extension; elsewhere an executable file on PATH).
- The page's `engine:status` and `gpu:stats` reads return the last answer while the page is
  hidden (minimized, in the tray, or covered: Chromium reports an occluded window as hidden),
  and ask again once it is visible.

**Cost to Nekko.** None intended: notices arrive late during exclusive fullscreen, not lost; meters are not
refreshed while nobody can see them.

**Not done (by choice).** Separate profiles for development and agent launches; preferring the
integrated GPU for Nekko's own rendering.

**Unverified.** The cause itself, and an end-to-end run with a real exclusive-fullscreen game
(reproduce the drop before building more on it); macOS and Linux have no
full-screen check (never quiet).
