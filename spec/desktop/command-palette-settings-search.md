---
title: "Settings in the command palette (desktop)"
area: desktop
---

# Settings in the command palette (desktop)

User intent (Philip, 2026-10-28): "searching with command k should also show any partially matching settings. have the search results show the toggle or setting that they can quick change literally in the window without having to go to the page."

- Typing in the Ctrl/Cmd+K palette lists matching settings below the matching commands. Matching ignores case, accepts partial words and needs every typed word (`notif`, `git base`, `crash`). Each setting is matched on its label, a few extra search words (for example `telemetry` for Help improve Nekko Agent) and its Settings group. Nothing is listed until something is typed.
- A setting row shows its own control: a switch for yes/no settings and a dropdown for choices, plus the group it lives in ("Settings: General"). Changing it saves at once through the same settings write the Settings page uses, and the palette stays open so several can be changed in a row. Keyboard: highlight the row and press Enter to flip a switch or step to the next choice; Shift+Enter steps back.
- Settings groups match too, by name or by the sections they hold (`guardrail` lists **Settings: Safety**, `hooks` lists **Settings: Agents**). Choosing one opens Settings scrolled to that group.
- Covered in place: the app-wide switches and choices (Help improve Nekko Agent, sidebar shortcuts, background animation, language, chat pane action, idle completion, tips, delete confirmation, close behavior, mascot, tray farewell, desktop notifications, text size, internet recovery, prompt caching, git checkout and baseline, server controls and the Experimental flags). Per-item controls (each hook, MCP server, guardrail), fonts, the theme picker and anything that needs typing stay on their page and are reached through the group entry.
- Privacy and safety: the search runs in the renderer over a fixed list; nothing is sent anywhere. A change is the same local settings write as on the Settings page, with the same error toast.

Status: implemented 2026-10-28. Unit-tested (matching, nested patches keep sibling keys, every choice's current value is one of its options) and checked in a hidden renderer of the real App (dark, 1400x900): rows, switch flipping the saved setting with the palette still open, dropdown rows and group entries. Not checked: the installed app, light theme, narrow windows, and the Local Web UI (which shares the palette). The list is curated (`settingsIndex.ts`), so a new app-wide setting is only searchable once it is added there.
