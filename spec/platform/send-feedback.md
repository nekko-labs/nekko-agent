---
title: "Send feedback from every app (2026-10-24)"
area: platform
---

# Send feedback from every app

Issues: [#1004](https://github.com/nekko-labs/nekko-agent/issues/1004), [#1725](https://github.com/nekko-labs/nekko-agent/issues/1725) (the desktop form below).

## Intent

Anyone using Nekko Agent, on any device, can tell Nekko Labs something is broken or missing in a few seconds, the way that suits them. One **Send feedback** button opens one sheet with three routes:

1. **Copy for an agent.** One button copies a ready-made prompt for the person's own coding agent (Claude Code, Codex, Nekko Agent itself). The prompt asks the agent to interview them, search existing issues for a duplicate, draft a title and description, and file the issue on `nekko-labs/nekko-agent` only after they approve, leaving out anything personal. The sheet shows the text before it is copied.
2. **Quick note.** A text box (up to 4,000 characters) that sends straight to Nekko Labs through Nekko Cloud. An **Include app info** switch, off by default, adds what the sheet lists: app, version, OS and its version, and CPU type.
3. **Open GitHub issues.** A link to <https://github.com/nekko-labs/nekko-agent/issues/new/choose>, which offers the bug report and feature request forms.

## The desktop and Local Web UI form (2026-11-05)

The sheet on desktop, the Local Web UI and Docker is one form that opens up as it is used, styled like the Scheduled Tasks editor. iPhone, iPad and Android keep the three-section sheet above.

- **Always there:** the choice of **Good** or **Needs improvement** (nothing preselected), **Other ways** (collapsed, with the agent prompt and the GitHub issue forms as two separate options), and the contributing line linking to `CONTRIBUTING.md`.
- **After choosing Needs improvement:** Summary, Description, Screenshots, Include app info and Send feedback.
- **After choosing Good:** Summary, Description and Send feedback. Praise rarely needs screenshots or app info, so they are not offered, and any set before changing to Good are not sent. Text typed before changing the choice stays.
- **Screenshots:** optional, by drop, paste or the file picker. Up to 3, each up to 5 MB, so at most 15 MB a note. PNG, JPG and JPEG only, proven by the file's first bytes as well as its extension (`feedbackScreenshotProblem`). A refused file says why, in view, and the rest are kept. The sheet warns that screenshots can show names, chats or file paths.
- **Required:** the choice, Summary (up to 120 characters) and Description. Send names the first thing missing, and pressing it with something missing shows each problem and moves focus to the first.
- **The wire is unchanged.** The form joins everything into `message`, as `Needs improvement: <summary>`, a blank line, then the description (`feedbackNote` in `packages/shared/src/feedback.ts`). The 4,000 limit therefore covers the whole note, and the count under the description shows the whole note from the start.
- **Wording stays positive:** "Needs improvement" and "needs work", never "broken" or a thumbs down. Good has a star-eyed Nekko and Needs improvement a wrench.
- **Sent:** the form gives way to "Your feedback was sent successfully" with a check beside it, a line that depends on the choice, and the contributing line. It has no buttons of its own: the X or Escape closes it.
- **Keyboard:** focus starts on the first choice and arrow keys change it. Enter in Summary moves to Description. Ctrl+Enter (⌘+Enter on a Mac) sends, and the sheet does not advertise it. Tab stays inside the sheet.
- **Closing:** there is no Cancel. Escape, the X and clicking outside ask before discarding anything typed; a choice on its own is not a draft.

## Where the button is

- **Desktop, Local Web UI and Docker** (one renderer, `FeedbackSheet.tsx`): a Send feedback button at the bottom of the left rail, a **Send feedback** command in the command palette, a button on the About page, Help → Send Feedback… on macOS, Send feedback… in the tray menu (the way in on Windows and Linux without the rail), and the `nekko-agent://feedback` link. It works whether or not anyone is signed in to Nekko Cloud. In the Local Web UI and Docker, `nekkod` runs on the server, so the OS fields describe the server, not the browser's machine.
- **iPhone and iPad** (native SwiftUI, `apps/ios`): **Send feedback** at the bottom of the computer menu on the Chats screen (the same menu in the iPad sidebar), and Settings → About → Send feedback.
- **Android** (native Compose, `apps/android`): Settings → Feedback → Send feedback, a bottom sheet.
- The Expo app has been removed; the native apps are the supported phone clients.

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

- No account, token, device id, device name or model, locale, IP, chat content or file path is sent or stored, apart from what a person shows in a screenshot they choose to add. The request is unauthenticated even when someone is signed in.
- Screenshots are the one thing a person can send that may identify them. The sheet says so beside the picker. Image metadata, such as location in a phone photo, must be stripped before a screenshot is stored (planned with the backend).
- The server does not request-log the route, keeps rate-limit counts in memory only, and stores each note with only the day it arrived (`feedback` table: `message`, `app_info`, `received_on`), so a note can't be lined up with account activity by time.
- People are told what app info contains before they switch it on.

## Acceptance

- The button is reachable on every app listed above without signing in.
- Copy for an agent puts the exact prompt on the clipboard and confirms it.
- Send is disabled for an empty note, keeps the text on failure, and shows a thank-you on success; a 429 says to try later.
- With the switch off, the request has no `app` key.
- On desktop and the Local Web UI, the fields and Send appear only after a choice, Good never sends app info, and a note over 4,000 characters can't be sent and says by how much.

## Status

- Nekko Cloud `POST /v1/feedback` and the `feedback` table: implemented 2026-10-24, tested against PGlite; not yet deployed to Fly.
- Desktop and Local Web UI sheet: implemented 2026-10-24. `nekkod` serves `feedback:info` and `feedback:send` (`crates/nekkod/src/feedback.rs`) and builds the app info itself, so the renderer can't add a field. Unit tested (Rust: field allow-list, body, a 429 against a local server; renderer: the three routes, app info off by default, Send disabled when empty) and captured in headless Chromium with a synthetic bridge. Not yet run in a packaged app or against the deployed endpoint.

- Desktop and Local Web UI form: implemented 2026-11-05 (#1725). Unit tested, and the real component driven by keyboard and mouse in headless Edge with a synthetic bridge. Not yet run in a packaged app or against the deployed endpoint.

- iPhone and iPad sheet: in progress (see #1004).

- Android sheet: in progress (see #1004).

- Screenshots on desktop and the Local Web UI: the section is implemented and passes them to `feedback:send` as `{ name, type, data }` with base64 `data`. Planned, and required before release: `nekkod` forwarding them, and Nekko Cloud accepting and storing them. Until then `nekkod` ignores them, so this must not ship alone.

- Not built: reading the notes anywhere but the database, replying to a sender (there is no way to reach them, on purpose), log attachments, screenshots on the phone apps.
