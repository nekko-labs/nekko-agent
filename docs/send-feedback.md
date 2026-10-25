# Send feedback

Every Nekko Agent app has a **Send feedback** button. It opens one sheet with three ways to reach Nekko Labs. Use whichever is easiest.

| Where | How to open it |
| --- | --- |
| Desktop, Local Web UI, Docker | The speech-bubble button at the bottom of the left rail, **Send feedback** in the command palette (⌘K / Ctrl+K), Help → Send Feedback… on macOS, or Send feedback… in the tray menu |
| iPhone and iPad | **Send feedback** in the computer menu on the Chats screen, or Settings → About → Send feedback |
| Android | Settings → Feedback → Send feedback |

## 1. Copy for an agent

**Copy prompt** puts a ready-made prompt on your clipboard. Paste it into the coding agent you already use: Claude Code, Codex, or a Nekko agent. The prompt tells the agent to:

- ask what happened and what you expected (or what you'd like),
- look through the [existing issues](https://github.com/nekko-labs/nekko-agent/issues) for a duplicate,
- draft a title and description and show them to you,
- file the issue on `nekko-labs/nekko-agent` only after you approve it,
- leave out anything personal: names, emails, file paths, keys and chat contents.

The sheet shows the full prompt before you copy it. Its last line names the app version, OS and CPU type, for example `App: Nekko Agent 1.4.0 (desktop, macOS 15.1, aarch64)`.

## 2. Quick note

Type a note (up to 4,000 characters) and press **Send**. It goes straight to Nekko Labs through Nekko Cloud. You don't need an account, and nobody is signed in for it, even if you are signed in to Nekko Cloud.

**Include app info** is off by default. Switch it on to add the app, version, OS and its version, and CPU type, so we can reproduce what you saw. The sheet shows those values before you send.

What the note never carries: your name or email, an account or device id, the device's name or model, your language, IP address, chats or files. Nekko Cloud doesn't log the request, and it stores the note with only the day it arrived. That also means we can't reply to it. If you'd like an answer, open a GitHub issue instead.

## 3. GitHub issues

**Open GitHub** opens the [bug report and feature request forms](https://github.com/nekko-labs/nekko-agent/issues/new/choose). Issues are public, and you can follow along and get replies there.
