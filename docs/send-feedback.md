# Send feedback

Every Nekko Agent app has a **Send feedback** button. It opens a sheet with three ways to reach Nekko Labs. Use whichever is easiest.

| Where | How to open it |
| --- | --- |
| Desktop, Local Web UI, Docker | The speech-bubble button under Settings in the left rail, **Send feedback** in the command palette (⌘K / Ctrl+K), Help → Send Feedback… on macOS, or Send feedback… in the tray menu |
| iPhone and iPad | **Send feedback** in the computer menu on the Chats screen, or Settings → About → Send feedback |
| Android | Settings → Feedback → Send feedback |

## 1. Quick note

On desktop, the Local Web UI and Docker, start by choosing **Good** or **Needs improvement**. The form then opens up:

- **Summary**: one line, up to 120 characters.
- **Description**: what happened, or what you'd like. The summary and description share a limit of 4,000 characters, and the count under the description shows how much you've used.
- **Screenshots** (optional): for Needs improvement only. Drop, paste or browse for up to 3 PNG, JPG or JPEG images, up to 5 MB each. Screenshots can show names, chats or file paths, so check yours before you send.
- **Include app info**: for Needs improvement only.

Press **Send feedback**, or Ctrl+Enter (⌘+Enter on a Mac). If you close the sheet with something written, it asks before throwing it away. If sending fails, what you wrote stays there so you can try again.

On iPhone, iPad and Android, the quick note is one text box of up to 4,000 characters with a **Send** button.

The note goes straight to Nekko Labs through Nekko Cloud. You don't need an account, and nobody is signed in for it, even if you are signed in to Nekko Cloud.

**Include app info** is off by default. Switch it on to add the app, version, OS and its version, and CPU type, so we can reproduce what you saw. The sheet shows those values before you send.

What the note never carries: your name or email, an account or device id, the device's name or model, your language, IP address, chats or files, apart from any screenshots you choose to add. Nekko Cloud doesn't log the request, and it stores the note with only the day it arrived.

Screenshots are checked again by Nekko Cloud: a file that isn't a whole PNG or JPEG is refused, and the sheet tells you which one. Before storing them, Nekko Cloud removes hidden details such as a phone photo's location, camera details and text an editor wrote in, and it never keeps the file name. Screenshots are deleted 90 days after they arrive; the note stays. That also means we can't reply to it. If you'd like an answer, open a GitHub issue instead.

## 2. Copy for an agent

On desktop, the Local Web UI and Docker, this is under **Other ways** in the sheet.

**Copy prompt** puts a ready-made prompt on your clipboard. Paste it into the coding agent you already use: Claude Code, Codex, or a Nekko agent. The prompt tells the agent to:

- ask what happened and what you expected (or what you'd like),
- look through the [existing issues](https://github.com/nekko-labs/nekko-agent/issues) for a duplicate,
- draft a title and description and show them to you,
- file the issue on `nekko-labs/nekko-agent` only after you approve it,
- leave out anything personal: names, emails, file paths, keys and chat contents.

The sheet shows the full prompt before you copy it. Its last line names the app version, OS and CPU type, for example `App: Nekko Agent 1.4.0 (desktop, macOS 15.1, aarch64)`.

## 3. GitHub issues

**Create issue** (under **Other ways** on desktop, the Local Web UI and Docker) or **Open GitHub** on the phone apps opens the [bug report and feature request forms](https://github.com/nekko-labs/nekko-agent/issues/new/choose). Issues are public, and you can follow along and get replies there.

## Contributing

Nekko Agent is open source. The sheet links to the [contributing guide](https://github.com/nekko-labs/nekko-agent/blob/main/CONTRIBUTING.md) if you'd like to help build it.
