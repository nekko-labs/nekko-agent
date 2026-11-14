---
title: "Opt-in usage and crash reports"
area: platform
---

# Opt-in usage and crash reports (2026-10-24)

`[implemented; unit-tested (engine allow-list, scrubbing, queue, onboarding step, Settings card); sends to the Nekko Agent PostHog project (686111), Discard client IP data on; a hand-sent `app_started` in the engine's batch shape arrived on 2026-10-24 with no IP or location stored; not yet sent from a running app or the packaged app]`

**User intent:** let people who want to help send anonymous reports of which features get used and what breaks. Off unless they say yes, and never personal data, never sold.

## How people choose

- **Onboarding:** a skippable **Help improve Nekko Agent?** step, just before the last one. The switch starts off, and skipping leaves it off. People who finished onboarding before this step existed are not asked again: the choice is in Settings.
- **Settings > General > Help improve Nekko Agent:** the same switch, with the same promises. It is the first card in General (moved from System on 2026-10-28 so it is easy to find).
- **Settings > Connections > Usage and crash reports:** every send appears in its log, and All connections off stops it.

## The promises (shown wherever the choice is offered)

- Off unless you turn it on. Turn it off any time in Settings.
- Anonymous: a random id, your app version, OS and hardware, and which features, models and modes you use. No name, email, IP location or account.
- Never your chats, prompts, files, folder names or model replies.
- Error reports are scrubbed of secrets, personal details and file paths.
- Never sold or shared. Used only to fix bugs and decide what to build.

## What is sent

Each event carries:
- **The install id:** random, and replaced each time the switch is turned on, so turning it off and on again starts a new, unlinked id.
- **The app's facts:** app, version, OS, OS version and CPU type, the same facts Send feedback may share.
- **Two flags for PostHog:** no person profile (`$process_person_profile: false`) and no location lookup (`$geoip_disable: true`).
- `[added 2026-11-12, #2678; unit-tested]` **When, locally:** `local_hour` (0 to 23) and `weekday` (`Mon`…), for time-of-day use. Never the time zone or offset.

`[updated 2026-11-12, #2678: hardware, opens and closes, models, modes, voice, CI runners and clicks; engine and renderer unit-tested; not yet seen arriving from a running app]` Philip asked for as much as can help decide what to build, anonymous only.

| Event | Sent by | Properties |
| --- | --- | --- |
| `app_started` | engine, at start | hardware from `machine:profile`: `cpu` (model), `cpu_cores`, `ram_gb`, `gpu` (first GPU's name), `gpu_count`, `vram_gb` (all GPUs), `unified`, `backends` (`metal,cpu`). Gigabytes are whole numbers; never serial numbers or host names |
| `app_opened` | Electron main, once the engine starts | none |
| `app_closed` | Electron main, on quit | `running_seconds` (how long the app ran). The engine sends it at once; quitting waits at most two seconds |
| `turn_started` | engine, at each turn's admission | provider kind (`openai`, `ollama`…), `local`, `offline`, `mode` (execution: `worktree`, `sandbox` or `unified`), `sandbox`, `model` (the model id, scrubbed: a path keeps only its last part), `permission` (`ask`, `guardrails`, `yolo`, `plan`), `subagent`, `running_agents` (other chats with a turn running), `connectors` (connected kinds, `github,gitlab`), `mcp_servers` (a count) |
| `voice_used` | engine, at each dictation | `engine` (`apple` or `whisper`) |
| `runner_job` | engine, when a CI runner job ends | `result` (`finished`, `stopped`, `lost`, `failedToStart`…), `seconds`. Never the repository, workflow or job |
| `screen_viewed` | UI, when the main view changes | the view's name (`models`, `settings`…) |
| `click` | UI, on any click | `screen`, `control`: the nearest control's `data-testid` or `aria-label`, only when it is fixed text in the source (`apps/desktop/src/renderer/clickLabels.json`, made by `apps/desktop/scripts/click-labels.mjs`; a test fails while it is stale). A label built from a file, chat or person's name is never in the list, so that click is not reported. Controls with neither attribute are not reported |
| `feature_used` | UI | `feature` |
| `error` | engine panics, uncaught UI errors and Electron main crashes | source, message (class and first line only), stack (frame names only) |

- The engine accepts only these events and properties; anything else is dropped. The UI cannot send `app_started`, `turn_started`, `voice_used` or `runner_job` (`ENGINE_ONLY`).
- **Desktop only so far.** The iPhone and Android apps send no reports of their own; turns, voice and runner jobs they start on a computer are reported by that computer's engine.
- Every string is scrubbed in the engine:
  - secrets (the log redactor);
  - emails, phone and card numbers, IP addresses and the user's name (the Privacy Shield detectors);
  - folder paths, cut to their last part (`…/main.rs:12`).
- `[updated 2026-11-03, GD12; unit-tested]` **An error never carries free text beyond its first line.** The message is the error's class and the first non-empty line of its message (`TypeError: x is undefined`), scrubbed, then cut to 200 characters; the rest of a message, which could echo a prompt, is dropped. The stack keeps only its frames, each as the function and the file's last part (`Object.send (send.ts:12:5)`), at most 30, with the message lines a JavaScript stack starts with removed. An engine panic sends `panic: <its first line>` and where it happened (`at …/x.rs:4:9`). The engine applies this to every `error` event, whoever sends it, so the UI (`errorReport` in `renderer/telemetry.ts`) and Electron main only add the class in front of the message.
- Events wait in memory (at most 500) and go to PostHog's batch endpoint once a minute through Settings > Connections (`telemetry`). A failed send is retried at the next minute. Turning reports off forgets anything queued.
- Nothing is written to disk.

## PostHog project

Project 686111, **Nekko Agent**, in the Nekko Labs org (US cloud). **Discard client IP data** is on (turned on 2026-10-24). Its public ingest key is `PROJECT_KEY` in `crates/nekkod/src/telemetry.rs`. `NEKKO_POSTHOG_KEY` overrides it for development; set it empty to send nothing, and Settings then says nothing is sent.

Decision: [0021](../../docs/decisions/0021-opt-in-reports-sent-by-the-engine.md). User docs: [docs/usage-reports.md](../../docs/usage-reports.md).
