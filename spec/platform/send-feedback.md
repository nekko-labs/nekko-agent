---
title: "Send feedback from every app (2026-10-24)"
area: platform
---

# Send feedback from every app

Issue: [#1004](https://github.com/nekko-labs/nekko-agent/issues/1004).

## Intent

Anyone using Nekko Agent, on any device, can tell Nekko Labs something is broken or missing in a few seconds, the way that suits them. One **Send feedback** button opens one sheet with three routes:

1. **Copy for an agent.** One button copies a ready-made prompt for the person's own coding agent (Claude Code, Codex, Nekko Agent itself). The prompt asks the agent to interview them, search existing issues for a duplicate, draft a title and description, and file the issue on `nekko-labs/nekko-agent` only after they approve, leaving out anything personal. The sheet shows the text before it is copied.
2. **Quick note.** A text box (up to 4,000 characters) that sends straight to Nekko Labs through Nekko Cloud. An **Include app info** switch, off by default, adds what the sheet lists: app, version, OS and its version, and CPU type.
3. **Open GitHub issues.** A link to <https://github.com/nekko-labs/nekko-agent/issues/new/choose>, which offers the bug report and feature request forms.

## Where the button is

- **Desktop, Local Web UI and Docker** (one renderer): a Send feedback button at the bottom of the left rail, a **Send feedback** command in the command palette, and Help → Send feedback… in the desktop menu (macOS app menu bar). It works whether or not anyone is signed in to Nekko Cloud.
- **iPhone and iPad** (native SwiftUI, `apps/ios`) and **Android** (native Compose, `apps/android`): from the app's settings/menu.
- The Expo app (`apps/mobile`) is being replaced by the native apps and does not get the sheet.

## The copied prompt

The same text on every app (`packages/shared/src/feedback.ts` is the reference; the Swift and Kotlin copies match it), ending with one line of app info, for example `App: Nekko Agent 1.4.0 (desktop, macOS 15.1, arm64)`. That line carries the same non-identifying fields as the quick note's app info.

## The quick note's wire contract

`POST https://nekko-agent-api.fly.dev/v1/feedback` (desktop: through `nekkod`, `cloud:feedback`, which honours `NEKKO_CLOUD_URL`; phones: direct).

```json
{ "message": "The model picker forgets my choice", "app": { "app": "ios", "version": "1.4.0", "os": "iOS", "osVersion": "18.1", "arch": "arm64" } }
```

- `message`: trimmed, 1-4,000 characters (code points).
- `app`: present only when the switch is on. `app` is one of `desktop`, `web`, `ios`, `android`; `version` and `os` are required, `osVersion` and `arch` optional; every value is 1-32 characters (`arch` 16) of letters, digits, space and `._+-`. Any other key is dropped; a value outside these rules fails the whole note.
- Answers: `202 {"ok":true}`; `400 {"error":"bad-feedback"}`; `429 {"error":"rate-limited"}` after 10 notes per IP per hour.

## Privacy boundary

- No account, token, device id, device name or model, locale, IP, chat content or file path is sent or stored. The request is unauthenticated even when someone is signed in.
- The server does not request-log the route, keeps rate-limit counts in memory only, and stores each note with only the day it arrived (`feedback` table: `message`, `app_info`, `received_on`), so a note can't be lined up with account activity by time.
- People are told what app info contains before they switch it on.

## Acceptance

- The button is reachable on every app listed above without signing in.
- Copy for an agent puts the exact prompt on the clipboard and confirms it.
- Send is disabled for an empty note, keeps the text on failure, and shows a thank-you on success; a 429 says to try later.
- With the switch off, the request has no `app` key.

## Status

- Nekko Cloud `POST /v1/feedback` and the `feedback` table: implemented 2026-10-24, tested against PGlite; not yet deployed to Fly.
- Desktop / Local Web UI, iOS, Android sheets: in progress in their own PRs (see #1004).
- Not built: reading the notes anywhere but the database, replying to a sender (there is no way to reach them, on purpose), screenshots or log attachments.
