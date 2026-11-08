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

- **Always there:** the choice of **Good** or **Needs improvement** (nothing preselected) and the contributing line linking to `CONTRIBUTING.md`. Nothing else shows until a choice is made.
- **After choosing Needs improvement:** Summary, Description, Screenshots, Include app info (its switch at the far right), **Other ways** (collapsed, with the agent prompt, the GitHub issue forms and the email line as separate options inside one border) and Send.
- **After choosing Good:** Summary, Description, optional contact details, **Give us a GitHub star!**, the email line and Send. Both kinds offer optional contact details.
- **The email line:** plain text, "Email us at feedback@nekkoagent.com". A Copy button appears on hovering the address, or on keyboard focus.
- **Good and screenshots:** Praise rarely needs screenshots or app info, so they are not offered, and any set before changing to Good are not sent. Text typed before changing the choice stays.
- **Screenshots:** optional, by drop, paste or the file picker. Up to 3, each up to 5 MB, so at most 15 MB a note. PNG, JPG and JPEG only, proven by the file's first bytes as well as its extension (`feedbackScreenshotProblem`). A refused file says why, in view, and the rest are kept. Each added screenshot shows a thumbnail; one that can't be drawn shows a picture icon instead of a broken image, and stays on the note. The sheet warns that screenshots can show names, chats or file paths.
- **Required:** the choice, Summary (up to 120 characters) and Description. Send names the first thing missing, and pressing it with something missing shows each problem and moves focus to the first.
- **The note's text is unchanged on the wire.** The form joins everything into `message`, as `Needs improvement: <summary>`, a blank line, then the description (`feedbackNote` in `packages/shared/src/feedback.ts`). The 4,000 limit therefore covers the whole note, and the count under the description shows the whole note from the start.
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
- Answers: `202 {"ok":true}`; `400 {"error":"bad-feedback"}` (also when the body has a `screenshots` key, so images are never dropped silently); `429 {"error":"rate-limited"}` after 10 notes per IP per hour.

### With screenshots

`POST /v1/feedback/screenshots`, the same body plus `screenshots`. `nekkod` sends here only when a note has screenshots. A separate route means a Nekko Cloud from before screenshots answers 404, and `nekkod` turns that into an error ("Nekko Cloud can't take screenshots yet") rather than a note that arrives without its images.

```json
{ "message": "Needs improvement: …", "screenshots": [{ "type": "image/png", "data": "<base64>" }] }
```

- The renderer passes `{ name, type, data }` to `feedback:send` as its third argument. `nekkod` forwards only `type` and `data` (the file name never leaves the machine), refuses more than 3, a type other than `image/png` or `image/jpeg`, and `data` that isn't base64 of at most 5 MB, and gives the upload 5 minutes instead of the usual 60 seconds.
- Nekko Cloud checks again (`apps/nekko-agent-api/src/screenshots.ts`), since the app's checks run on the sender's machine. The file must be a whole image of the type it claims: a PNG with every chunk's CRC right, IHDR first, IEND last with nothing after it, and image data that inflates to exactly the size IHDR gives; a JPEG with SOI, segments that fit, a frame header, at least one scan with data, and EOI. A file with a valid header but corrupt contents is refused. JPEG pixel data is not decoded, so a JPEG whose scan bytes are garbage but well-formed still passes. At most 40 megapixels.
- **Metadata is stripped before storing.** A PNG keeps only the chunks that draw it (IHDR, PLTE, IDAT, IEND, tRNS, gAMA, cHRM, sRGB, iCCP, sBIT, pHYs, cICP): text, `eXIf`, `tIME` and private chunks go. A JPEG loses EXIF, XMP, IPTC, comments and every APPn segment except JFIF, the ICC profile and Adobe's colour transform, and anything after EOI (a phone's extra images). EXIF orientation goes with EXIF, so a rotated phone photo may arrive sideways.
- Abuse limits: the body may be about 20 MB; the note counts against the same 10 per IP per hour, plus at most 3 notes with screenshots per IP per hour, and at most 2 uploads at once (the machine has 256 MB). These run before the body is read, so a refused upload costs no memory.
- Answers: `202 {"ok":true,"screenshots":<n>}`; `400 {"error":"bad-feedback"}` for a malformed note or list; `400 {"error":"bad-screenshot","index":<i>}` for a file that isn't a real image (nothing is stored); `413` over the body limit; `429 {"error":"rate-limited"}`; `503 {"error":"busy"}` when 2 uploads are already running.
- Storage: `feedback_screenshots` (migration `0013`): `feedback_id`, `position`, `type` and the cleaned bytes, in the same Postgres as the note and in the same transaction. No file name. Deleted with the note, and on their own 90 days after the note arrived (`purgeFeedbackScreenshots`, every 6 hours); the note itself stays.

## Privacy boundary

- No account, token, device id, device name or model, locale, IP, chat content or file path is automatically sent or stored, apart from what a person includes in their note or chosen screenshots. Optional name and email are sent only when typed into those fields, as part of the note, for feedback follow-up only (no marketing/signup). The request is unauthenticated even when someone is signed in.
- Notes, optional contact details, and screenshots may identify their sender. The sheet says so beside the picker. Nekko Cloud strips image metadata, such as location in a phone photo, before storing a screenshot, never stores its file name, and deletes it after 90 days.
- The server does not request-log the route, keeps rate-limit counts in memory only, and stores each note with only the day it arrived (`feedback` table: `message`, `app_info`, `received_on`; screenshots hang off the note and add no time or sender), so a note can't be lined up with account activity by time.
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

- Screenshots on desktop and the Local Web UI: implemented 2026-11-06 (#1860) end to end: the form, `nekkod` forwarding them to `POST /v1/feedback/screenshots`, and Nekko Cloud checking, stripping and storing them. Tested: the API against PGlite with real PNG and JPEG bytes (metadata removed, a corrupt file refused with nothing stored, the per-IP limit, 90-day retention); Rust unit tests for the forwarding and the 404 and bad-screenshot errors. Not run against the deployed API, which needs a `fly deploy` before the app ships (until then the app shows "Nekko Cloud can't take screenshots yet" and stores nothing). The privacy policy page does not mention screenshots or their 90 days yet.

- Not built: reading the notes anywhere but the database, an integrated reply inbox (optional typed email now permits manual follow-up), log attachments, screenshots on the phone apps.

## Optional contact and GitHub support (#2342)

Implemented for desktop/shared Local Web UI renderer; native iOS/Android unchanged. Name (up to 200 characters) and email (up to 320) start blank, are independent and optional, are never prefilled from account/settings, and stay in the draft on failure. Entered email must be valid or cleared. The disclosure says “We don’t spam” and no mailing-list signup. Contact-only edits participate in discard confirmation. Contact labels and text append to the existing message and count toward the same 4,000 code-point limit; blank fields add nothing. The wire/schema/cloud deployment is unchanged.

Good feedback (including its success state) and the new first Settings group, **Help out the Nekko Team**, share one GitHub support control. Settings also moves the existing usage-report opt-in into that group, without changing its value or behavior.

The Rust daemon owns `support:starStatus` / `support:star`. It uses only an explicitly connected GitHub connector token, not environment variables, gh credentials or a cloud login. It calls GET /user then GET /user/starred/nekko-labs/nekko-agent; only an explicit star click can PUT that fixed path. Status reads never write; existing stars return without writing. Errors/permissions/network failure remain unverified, with an Open GitHub fallback. No credentials enter the renderer. Requests obey Settings → Connections → GitHub. Account login is shown before writing; an external browser star is not assumed successful and is rechecked on window focus or Check status.

A confirmed star appears selected with happy Nekko on both surfaces. Newly confirmed API stars animate once per account/browser profile; existing stars do not animate, and reduced motion disables the animation. A local thank-you marker is not proof of star status: remote status is always read again. No unstar action is provided.

Verification status: 4,210 shared/desktop tests pass, plus shared/profile builds, desktop production build and TypeScript check. A hidden, nonfocusable, network-blocked Electron journey passed 13 assertions covering explicit writes, shared state/no replay, optional email validation/focus, failed-send draft retention, contact payload, browser fallback and reduced motion. Desktop/narrow before/after pixels and a first-star GIF are captured and published in PR #2349, but inspection tools failed (browser screenshot timeout, native UnknownVizError), so visual approval remains blocked. Rust mock-server tests await CI; local cargo is unavailable. Live GitHub writes are intentionally not exercised on the developer’s account.
