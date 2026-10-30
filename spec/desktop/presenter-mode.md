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

## Privacy boundary

Display-only. Engine data, settings, and what models receive are unchanged.
Text inside inputs, textareas and editors is not masked; neither are images,
folder or project names that are not under a home path, nor names the masker
cannot know (a colleague's name in a chat). Use the demo profile for footage
that must be clean.

## Status

- Implemented: masker, Settings exemption, Local Web UI flag, fixed window size,
  launcher, demo profile and reset. Unit tests cover the masker.
- Verified in the Local Web UI (live masking, attributes, Settings exemption).
- Not yet verified: the desktop preload path (`NEKKO_PRESENTER=1` exposing the
  user, home and host names) in a running Electron window.
