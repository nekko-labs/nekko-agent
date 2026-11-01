---
title: "Ask before memory runs out (low-memory prompt)"
area: desktop
---

# Ask before memory runs out (low-memory prompt)

**User intent (2026-11-01).** nekkod crashed with `memory allocation of 1048576 bytes failed` while a game held 14 GB and the machine had committed 58 of its 62.7 GB. Nekko was not leaking; it was simply the process whose next allocation failed. When memory runs low, Nekko should say so from the tray and offer a way out before something crashes: close the app holding the most memory, shut down Nekko's local models, or ignore it. The person can remember the choice, and change it in Settings.

## Sensing `[implemented; unit- and daemon-tested; Windows checked on this machine]`

`memory:state({ detail }?)` (nekkod, from nekko-machine `memory.rs`) answers `level` (`ok`, `low`, `critical`), total and available memory, and on Windows the commit limit and what is left of it.

- **Low:** under 10% left. **Critical:** under 5%. On Windows the worse of physical memory and the commit charge counts: an allocation fails at the commit limit however much memory sits on standby.
- **When not `ok`** (or when `detail` asks), it also reads the process list and answers:
  - `topApp`: the app holding the most, a process name summed over its processes (a browser is many). On Windows that is private commit; elsewhere resident memory. Nekko's processes (nekkod, everything under it, anything named Nekko), the system's (Explorer, `dwm`, WSL's `vmmem`, `WindowServer`, ...) and any app under 1 GiB are never named.
  - `nekkoBytes`: what Nekko's own processes hold.

## The prompt `[implemented; unit-tested; not yet seen on macOS or Linux]`

The desktop main process (`memoryWatch.ts`) reads `memory:state` every 15 s while the service runs.

- **When low,** a small card appears above the tray, with Nekko in its top-left corner wearing the iOS refresh mascot's alarm pose (shocked ring eyes, open mouth, a "!" over the right ear; `ALERT_MASCOT`), (the corner of the screen where the tray reports no position, as on most Linux desktops), without taking focus:
  - **Close &lt;app&gt;** (when there is one). The app is asked to close the way its close button would (Windows: `taskkill` without `/F`; macOS: AppleScript `quit`, then `SIGTERM` for a helper; Linux: `SIGTERM`), so it can still ask to save. Never forced.
  - **Shut down Nekko's local models** *(agents using them stop)*: unloads every loaded local model, kept resident or mid-reply (`engine:unloadAll`). The label says the cost, so it does not read as a free win (2026-11-01; it was "Free Nekko's memory" and left busy models loaded). The model server keeps listening, so the next message loads its model again. The note afterwards says how many replies were stopped.
  - **Ignore.**
  - **Remember this choice.** Remembering Close adds that app to `lowMemoryCloseApps`; remembering Shut down or Ignore sets `lowMemoryAction`.
- **Remembered choices:** an app in `lowMemoryCloseApps` that holds the most is asked to close without a question. Otherwise `lowMemoryAction` `release` shuts down Nekko's local models and `ignore` does nothing. A short note says what was done.
- **Not nagging:** after it asks or acts, it stays quiet for 30 minutes unless low turns critical. An unanswered card goes away after 2 minutes. Back to `ok` resets this.
- **Full-screen games:** while one is in front (`activity:fullscreen`, see [Stay out of the way of full-screen apps](stay-out-of-the-way-of-full-screen-apps.md)), nothing is shown over it. The question waits for the game to leave; a remembered choice still runs, without its note.
- **The card has no script:** a sandboxed `data:` page whose form submits to `https://nekko.invalid/choose`, read from the navigation by the main process.

## Settings `[implemented; renderer-tested]`

**Settings → Desktop behavior → When memory runs low:** Ask me (default), Shut down local models, or Do nothing. Below it, **Always ask these apps to close** lists the remembered apps, each with a button to forget it. Settings search finds it under "memory", "ram", "free" and "shut down".

## Security

- `memory:closeApp` refuses Nekko's own processes, the system's and an empty name, and only asks; it never force-kills.
- Phones may never call it (`PHONE_DENIED_FOREVER`): closing an app on the computer is for the person at it.

## Not built

- Releasing memory in nekkod without the desktop app (headless daemons). The policy lives in the desktop app today.
- Trimming nekkod's own caches beyond unloading models; the daemon itself holds tens of MB.
