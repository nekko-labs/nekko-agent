---
title: "Ask for a GitHub star after 10 and 50 prompts"
area: platform
---

# Ask for a GitHub star after 10 and 50 prompts

Issues: [#2422](https://github.com/nekko-labs/nekko-agent/issues/2422) (desktop and Local Web UI), [#2423](https://github.com/nekko-labs/nekko-agent/issues/2423) (iPhone and iPad), [#2424](https://github.com/nekko-labs/nekko-agent/issues/2424) (Android).

## Intent

Nekko Agent is open source, and stars on GitHub help people find it. Someone who uses the app regularly is asked, politely and at most twice, whether they want to star it. Keep it one action, in one click where possible, and never in the way.

Decided 2026-11-09:

- **A link, not a new login.** No "Sign in with GitHub" for this. Someone who already connected GitHub in Connectors stars in one click inside the app (the existing `support:star` action, [send feedback](send-feedback.md#optional-contact-and-github-support-2342)); everyone else gets the repository page in their browser, where starring is one click.
- **Twice, not three times:** after the 10th and the 50th prompt.
- **A card under the reply, not a modal.** A modal interrupts and gets closed unread.
- **One action per ask.** No X/Twitter alternative beside it.
- **Phones:** the same GitHub card for now. Once the apps are on the App Store and Google Play, the native rating request (`SKStoreReviewController`, Play In-App Review) takes the card's place there, with no pre-prompt of ours in front of it (planned, not built).

## Behaviour (desktop, Local Web UI, Docker)

`[Implemented 2026-11-09; the counting rules and storage are unit-tested; a hidden, off-screen Electron journey on the real App (16 checks) covers the 10th and 50th asks, ignoring, starring in place, opening GitHub, Don't ask again and an existing star; not yet tried in the packaged app or the Local Web UI in a browser]`

- **What counts.** A prompt sent from a chat pane (typed, an image prompt, or an edited message re-sent) whose reply finishes (`done`). A reply that fails or is stopped does not count, nor do turns the pane did not start: queued follow-ups, automations, goals, retries.
- **When it shows.** Under the reply to the 10th counted prompt, then under the reply to the 50th. Only in the pane that sent it, and only while that chat has no question, approval or failure showing and is not read-only.
- **The card.** A star, "Nekko Agent is open source", "If it helps you, a star on GitHub helps more people find it.", then **Star on GitHub** (**Star as @login** when the GitHub connector is connected and not yet starring), **Not now** and **Don't ask again**.
- **Each ask is used once.** It is used up when it shows: sending the next prompt without choosing removes it and counts as Not now. If the count has already passed 50 when the first ask shows (for example the card never got the chance), the second ask is used up too, so two never come back to back.
- **Ending it.** Star, Don't ask again, or a GitHub status that says the connected account already stars the repository: never asked again. A stargazer is never shown the card at all; it waits for GitHub's answer before showing, so it does not flash.
- **Star.** Connected: one `support:star` write, then "Thank you, @login! Nekko is happy you're here." in the card, with the existing one-time celebration. Not connected (or the write failed): opens <https://github.com/nekko-labs/nekko-agent> and thanks them. Opening GitHub does not claim a star was made.
- **Not now** closes the card; the next ask is at 50, the one after that never.

## Boundaries

- **Kept in this browser profile only** (`localStorage` key `nekko.star-ask`: prompts counted, asks shown, stopped). Never synced, never in settings, never sent to Nekko Labs. A second browser or a fresh profile counts again from zero. Without storage (some private web sessions) it never asks.
- **GitHub's rules.** No reward or feature in return for a star; nothing is starred without the person's click; the card never stars on its own. The connector token stays in the engine, as it already does for the Settings star.
- **Network.** Showing the card reads the star status through the engine only when the GitHub connector is connected (the same read Settings does); with no connector there is no request.
- **Numbers** live in `STAR_ASK_AT` (`packages/shared/src/support.ts`); the phone apps use the same 10 and 50.

## iPhone and iPad

[#2423](https://github.com/nekko-labs/nekko-agent/issues/2423). `[Implemented 2026-11-09; the rules and the counting are unit-tested in code that compiles locally, but the iOS app was not built or run on this machine (no Xcode): the app's unit tests and a fixture UI test (the 10th reply's card, the next send removing it, Not now, Don't ask again, Star on GitHub's thank-you) run in Native iOS CI; not tried on a device]`

- **What counts.** A prompt sent from the chat screen (typed, dictated, a photo, a saved prompt or a skill, the first message of a new chat, a Git action) whose reply then finishes (`done`). A reply that fails or is stopped does not count, nor do follow-ups queued while a reply runs, prompts sent later from the outbox after being offline, automations, or turns started on the computer or another device (`ChatModel.promptReplies`).
- **When it shows.** Under the reply to the 10th counted prompt, then the 50th, at the end of the transcript, only while that chat has no question, approval or failure showing and is not the phone's read-only saved copy. Not a sheet or modal.
- **The card.** The chat's own inline surface: a star, "Nekko Agent is open source", "If it helps you, a star on GitHub helps more people find it.", then **Star on GitHub**, **Not now** and **Don't ask again**. Translated in the app's catalog.
- **Each ask is used once,** exactly as on the desktop: used up when it shows, the next send removes it (Not now), and a late first ask uses up the second too. Leaving the chat also removes it.
- **Star on GitHub** opens <https://github.com/nekko-labs/nekko-agent> in the browser, thanks them in the card ("Thank you! Nekko is happy you're here."), and stops the asks for good. There is no GitHub connector star on the phone, so it is a link only: no login and no GitHub request. **Don't ask again** also stops it for good.
- **Kept on this device only:** UserDefaults `starAsk`, the same JSON as the desktop (`{"prompts":…,"asked":…,"stopped":true}`), through `Prefs`. Never synced, never sent. Malformed values read as a fresh start. UI test runs never see it unless a test passes `-starAskPrompts N`.
- **Rules:** `StarAsk` (`apps/ios/Protocol/Sources/NekkoKit/StarAsk.swift`), a port of `packages/shared/src/support.ts` with the same 10 and 50.
- **Not yet:** the native rating request (`SKStoreReviewController`) replaces the card once the app is on the App Store (planned, see Intent).

## Android

`[Implemented 2026-11-09; the counting rules and storage are JVM unit-tested (StarAskTest: asks at exactly 10 and 50 over 120 prompts, stop, a late first ask, defensive reading, and which turns count); StarAskEvidenceTest ran the real chat screen against a fake computer on a headless API 37 emulator (3 tests: the 10th reply asks, Star on GitHub opens the repository and thanks, the next send removes an ignored card, a late first ask at 50 uses up both, Don't ask again); not yet tried on a physical phone or against a real computer]`

- **What counts.** A prompt sent from the Android chat screen (typed, with photos, or a skill) whose reply then finishes (`done`). A failed or stopped reply (the computer ends a stop with an error), a prompt queued during a run, one waiting in the outbox, and turns the phone did not start (automations, retries, the computer's own sends) do not count.
- **The card.** Inline under the last reply in the transcript, never a dialog or bottom sheet, and only while the chat has no question, approval or failure showing and is not a saved copy or completed. A star, "Nekko Agent is open source", "If it helps you, a star on GitHub helps more people find it.", then **Star on GitHub**, **Not now** and **Don't ask again**. Material buttons in the app's themes, translated into the app's six other languages.
- **Same rules as the desktop.** Ported to Kotlin in `apps/android/app/src/main/java/com/nekko/android/data/StarAsk.kt` from `packages/shared/src/support.ts` (same 10 and 50). Used up when it shows; the next send removes it; a first ask that comes after 50 uses up the second too.
- **Star on GitHub** opens <https://github.com/nekko-labs/nekko-agent> in the browser, thanks them in the card ("GitHub opened in your browser. Starring there takes one click.") and ends the asks for good. The phone has no GitHub connector path: no login, no GitHub API call, and it never claims a star was made. **Don't ask again** ends it too.
- **Kept on this phone only**, in the app's own preferences (`nekko_phone`, key `star_ask`, the desktop's JSON `{prompts, asked, stopped}`), left out of backup and device transfer like every preferences file. Never sent to the computer or Nekko Labs. Off under instrumentation, so device and screenshot tests never see the card unless they pass their own store.
- **Planned, not built:** once the app is on Google Play, the Play In-App Review request takes the card's place, with no pre-prompt in front of it. The app is not on Google Play yet, so the API is not used and its dependency is not added.
