---
title: "Presenter mode for screen recordings"
area: desktop
---

# Presenter mode for screen recordings

## Intent

Record demo videos of the desktop app and the Local Web UI without any personal
detail on screen. The account email beside each provider in the model picker
was the main leak; home-directory paths, the OS user and machine name, and
key-shaped strings can also appear in chats, tool output, file paths and
tooltips.

## Behavior

- Turned on by `NEKKO_PRESENTER=1` in the desktop app, or `?presenter=1` in the
  Local Web UI (remembered for that tab until `?presenter=0`).
- Outside Settings, every visible text node and the `title`, `aria-label`,
  `placeholder` and `alt` attributes are masked as they render:
  emails become `you@example.com`; home-directory paths become `~`; the OS user
  name (and any user name seen in a home path) becomes `demo`; the machine name
  becomes `workstation`; API-key-shaped tokens (`sk-`, `sk-ant-`, `ghp_`,
  `github_pat_`, `xoxb-`, `AIza…`) become `sk-••••`.
- Settings (`[data-presenter-exempt]`) is left unmasked so the presenter can
  check what is configured. Do not open Settings while recording.
- `NEKKO_WINDOW_SIZE=WxH` opens the desktop window at a fixed size, centred,
  ignoring the saved size, so takes frame identically.
- `npm run presenter -w apps/desktop` launches dev with both set (1600x900 by
  default); `-- --demo` uses a separate profile at `~/.nekko-agent-demo`, and
  `-- --demo --reset` wipes it first.

## Scripted demos

Intent: a pre-built demo that plays itself in the real app while it is
recorded, because only the real app looks like the real app.

- `npm run demo -w apps/desktop -- <scene>` starts the app in presenter mode on
  the demo profile with `NEKKO_DEMO_DEBUG_PORT` set (a remote-debugging port on
  127.0.0.1, opened only when that variable is set and only in a dev build; an
  installed app never opens it), counts down five seconds
  so recording can start, then plays `scripts/demo/scenes/<scene>.mjs`.
- Each click or hover finds the element in the live page, glides the real
  Windows cursor there (eased) and clicks with the real mouse, so recorders that
  follow the cursor see genuine movement. Typing is sent to the focused field at
  a steady pace. macOS and Linux fall back to page-level clicks with no cursor
  movement.
- `--attach` plays in an app already running with the port; `--dry --url`
  rehearses headless against the Local Web UI and saves a screenshot per step.
- The runner waits for Enter (press it once recording has started), then counts down 3 seconds; `--no-wait` skips the wait.
- Scenes ship for the five website panels (`control`, `experience`, `fast`, `secure`, `convenient`) plus `tour`. Setup steps run before recording; the demo project is reset to its first commit before each take.
- `fast` keeps tok/s readouts hidden unless run with `--benchmark` on the machine its numbers were measured on.
- Presenter mode leaves reserved `example.com`/`.org`/`.net` addresses unmasked (demo scripts type them on purpose) and never rewrites text inside an editable field (it moved the caret mid-typing).



Display-only. Engine data, settings, and what models receive are unchanged.
Text inside inputs, textareas and editors is not masked; neither are images,
folder or project names that are not under a home path, nor names the masker
cannot know (a colleague's name in a chat). Use the demo profile for footage
that must be clean.

## Status

- Implemented: masker, Settings exemption, Local Web UI flag, fixed window size,
  launcher, demo profile and reset. Unit tests cover the masker.
- Verified in the Local Web UI (live masking, attributes, Settings exemption).
- Verified: the `tour` scene rehearsed headless against the Local Web UI; the Windows cursor driver starts and answers.
- Not yet verified: a live run moving the real cursor over the Electron window, and the desktop preload path (`NEKKO_PRESENTER=1` exposing the
  user, home and host names) in a running Electron window.
