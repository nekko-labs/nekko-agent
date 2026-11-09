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

## iPhone, iPad and Android

Not built yet: [#2423](https://github.com/nekko-labs/nekko-agent/issues/2423), [#2424](https://github.com/nekko-labs/nekko-agent/issues/2424). Same card, same numbers, opening the repository in the browser.
