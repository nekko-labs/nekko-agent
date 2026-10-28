---
title: "Stay out of the way of full-screen apps (games)"
area: desktop
---

# Stay out of the way of full-screen apps (games)

**User intent.** Nekko Agent running, in any form, must not affect other programs. A user saw
Overwatch drop from 200-300 FPS to 60-90 while Nekko ran, and only a game restart restored it.
The cause found: Nekko brought something forward over the exclusive-fullscreen game (a
"finished" toast at a turn's end, matched to the second in the game's focus log; the window's
`show()`+`focus()` at launch and on a second launch). The game lost exclusive mode and stayed
slower, composed by the desktop window manager, until it restarted. A process spawn storm
(`nvidia-smi` and `where` every 6 s, each with a console host) added CPU wakeups beside it.
Investigation: `.scratch/ow/` (local), issue linked from the PR.

**Behavior (implemented, Windows).**

- nekkod answers `activity:fullscreen` with `{ quiet, state }` from
  `SHQueryUserNotificationState`: quiet for a Direct3D exclusive-fullscreen app, another
  full-screen app (busy), or presentation mode. Elsewhere, and when it cannot be read, it is
  never quiet. It never says which app.
- While quiet, the desktop's native notices are held and delivered when it ends, the newest per
  chat and kind. Nothing is dropped.
- While quiet, a window that would come forward on its own waits until it ends and then shows and
  focuses as before: the first show at launch, a second launch, a deep link. Anything a person
  does to reach Nekko (the tray, a toast, a shortcut) means they already left the game, so it
  passes straight through; so does any request while one of Nekko's own windows has focus.
- Without an answer within 400 ms (service stopped or still starting), nothing waits: the
  previous behavior.
- The tray's 6 s refresh asks `engine:running` and `engine:installedBin(runtime)` instead of
  `engine:status`, so it no longer probes the GPU or searches for runtimes.
  `engine:installedBin` takes an optional runtime (`llama` by default, as before).
- Runtime lookups on PATH (`where`/`which`) are searched in the daemon's own process, with the
  same rules (Windows: the current folder first, then PATH, a bare name only with a `PATHEXT`
  extension; elsewhere an executable file on PATH).
- The page's `engine:status` and `gpu:stats` reads return the last answer while the page is
  hidden (minimized, in the tray, or covered: Chromium reports an occluded window as hidden),
  and ask again once it is visible.

**Cost to Nekko.** None intended: notices and windows arrive late, not lost; meters are not
refreshed while nobody can see them.

**Not done (by choice).** Separate profiles for development and agent launches; preferring the
integrated GPU for Nekko's own rendering.

**Unverified.** An end-to-end run with a real exclusive-fullscreen game; macOS and Linux have no
full-screen check (never quiet).
