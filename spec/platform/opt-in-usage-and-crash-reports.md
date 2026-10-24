---
title: "Opt-in usage and crash reports"
area: platform
---

# Opt-in usage and crash reports (2026-10-24)

`[implemented; unit-tested (engine allow-list, scrubbing, queue, onboarding step, Settings card); not yet sending: the build has no PostHog project key until the Nekko Agent project exists; not checked in the packaged app]`

**User intent:** let people who want to help send anonymous reports of which features get used and what breaks. Off unless they say yes, and never personal data, never sold.

## How people choose

- **Onboarding:** a skippable **Help improve Nekko Agent?** step, just before the last one. The switch starts off, and skipping leaves it off. People who finished onboarding before this step existed are not asked again: the choice is in Settings.
- **Settings > System > Help improve Nekko Agent:** the same switch, with the same promises.
- **Settings > Connections > Usage and crash reports:** every send appears in its log, and All connections off stops it.

## The promises (shown wherever the choice is offered)

- Off unless you turn it on. Turn it off any time in Settings.
- Anonymous: a random id, the app version and your OS. No name, email, IP location or account.
- Never your chats, prompts, files, folder names or model replies.
- Error reports are scrubbed of secrets, personal details and file paths.
- Never sold or shared. Used only to fix bugs and decide what to build.

## What is sent

Each event carries:
- **The install id:** random, and replaced each time the switch is turned on, so turning it off and on again starts a new, unlinked id.
- **The app's facts:** app, version, OS, OS version and CPU type, the same facts Send feedback may share.
- **Two flags for PostHog:** no person profile (`$process_person_profile: false`) and no location lookup (`$geoip_disable: true`).

| Event | Sent by | Properties |
| --- | --- | --- |
| `app_started` | engine, at start | none |
| `turn_started` | engine, at each turn's admission | provider kind (`openai`, `ollama`…), local or not, offline, chat mode, sandbox |
| `screen_viewed` | UI, when the main view changes | the view's name (`models`, `settings`…) |
| `error` | engine panics, uncaught UI errors and Electron main crashes | source, message, stack |

- The engine accepts only these events and properties; anything else is dropped. The UI cannot send `app_started` or `turn_started`.
- Every string is scrubbed in the engine:
  - secrets (the log redactor);
  - emails, phone and card numbers, IP addresses and the user's name (the Privacy Shield detectors);
  - folder paths, cut to their last part (`…/main.rs:12`).
- Events wait in memory (at most 500) and go to PostHog's batch endpoint once a minute through Settings > Connections (`telemetry`). A failed send is retried at the next minute. Turning reports off forgets anything queued.
- Nothing is written to disk.

## PostHog project

The Nekko Agent project in the Nekko Labs org (US cloud), with **Discard client IP data** on. Its public ingest key goes in `PROJECT_KEY` in `crates/nekkod/src/telemetry.rs`; `NEKKO_POSTHOG_KEY` overrides it for development. Until the key is set, nothing is sent and Settings says so.

Decision: [0021](../../docs/decisions/0021-opt-in-reports-sent-by-the-engine.md). User docs: [docs/usage-reports.md](../../docs/usage-reports.md).
