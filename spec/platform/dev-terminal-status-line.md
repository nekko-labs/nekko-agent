---
title: "npm run dev: a status line pinned under the logs"
area: platform
---

# npm run dev: a status line pinned under the logs

`[implemented 2026-11-19; unit tests for the line, the heartbeat and the daemon's counts; the pinned line checked in a real pseudo-terminal rendered through xterm.js (VS Code's terminal), with 90 log lines and a clear-screen scrolling past it; not yet checked in Terminal.app, iTerm2 or Windows Terminal, nor through a full npm run dev session]`

**User intent (Philip, 2026-11-19).** Have the shutdown message persist in front of the logs. If possible, keep a status for building n, verifying n or idle as the latest line, with a small indicator icon or ASCII art, so when the UI freezes I can tell whether things are still running.

## What it shows

The `npm run dev` (and desktop `start`) terminal keeps its bottom row for one line. Logs from electron-vite, Electron and the engine scroll in the rows above it and never cover it.

- **Starting Nekko Agent... 14s** until the app first reports in.
- **⠋ ( o.o ) Building 2 · Verifying 1 · 1 waiting on you** while chats work, counted as the Agent board groups them: a chat checking or landing its work is Verifying, one waiting on an answer or approval is waiting on you, anything else working (reading, editing, making a picture, just sent) is Building. A part with nothing in it is left out.
- **zz ( -.- ) Idle** when no chat is working; the z's grow slowly.
- **Stopping cleanly... 3s · q again to force** from the moment q, Enter or Ctrl+C is pressed, or the app starts quitting on its own (Cmd+Q, the tray), until it has exited. Then the line is cleared and the terminal is given back whole.
- **! ( o.O ) No word from the app for 12s: it may be frozen** once its heartbeat is more than 3 seconds old. The spinner and the z's move only while heartbeats arrive, so a frozen app never looks busy.
- **· a window is not responding** after any of the above while Electron reports a window unresponsive (its renderer is stuck) and the main process still beats.
- **The engine is not answering** when the main process beats but the engine does not answer within 0.8 s.
- The right end keeps the keys: **q stop · r restart**. The line is cut to the terminal's width, and follows a resize.

## How

- The app's main process, only under `npm run dev` (`NEKKO_DEV_STATUS_FILE` set by the launcher), writes a heartbeat file once a second: the time, whether it is quitting, the engine's `chat:activity` counts and how many windows are unresponsive. A packaged app never writes it.
- `chat:activity` is a daemon channel that counts the running turns by the phase the turn's forwarder last saw, and the chats with pending input. It reads no chat files. Not in the phone's allowlist.
- The launcher draws the line every 120 ms, reading the file every fourth draw. It sets a scroll region over every row but the last (DECSTBM), so programs writing straight to the terminal stay above it, and resets it on exit and before an `r` restart.
- Only in an interactive terminal at least 5 rows tall. `NEKKO_DEV_STATUS=off` turns it off.

## Boundaries

- Some terminals may not keep lines scrolled out of a partial scroll region in their scrollback. xterm.js keeps them (checked); Terminal.app, iTerm2 and Windows Terminal are unverified. `NEKKO_DEV_STATUS=off` is the way out if logs go missing from scrollback.
- A forced stop (the second press, or the 10 second fallback) ends the launcher's children with SIGKILL; the launcher still clears the line on its own exit.
