---
title: "iOS and Android stay in step (2026-11-02)"
area: phone
---

# iOS and Android stay in step (2026-11-02)

Philip asked (2026-11-02) that the two phone apps do the same things, for what exists today and for everything new, and look like the same product while each feels at home on its own phone. Why this and not iOS first, Android later: [decision 0061](../../docs/decisions/0061-ios-and-android-stay-in-step.md).

## The rule

1. **Same features.** A feature on one app belongs on the other, existing or new. Someone who changes phones should lose nothing.
2. **Only a true OS exclusive stays on one app.** If the other OS has an equivalent, build that, the way Apple Pay on iPhone maps to Samsung Pay or Google Pay on Android. A feature stays one-sided only when the other OS has nothing that can do the job, and this file says so.
3. **Native manners, one look.** Each app follows its own platform's design guidance (Apple's Human Interface Guidelines, Material on Android) for navigation, controls, sheets, type and motion. The Nekko themes, mascot, wording and the order of what a screen shows stay the same, so the two read as one product. Icons follow the design system's colours and styles on both (#2451, `[implemented 2026-11-10; Android compiled and unit-tested locally, iOS checked on macOS CI]`): platform line symbols for controls in `inkSoft` at rest, the accent only for a selection, a link or the main action, our own status glyphs for agent status, and the theme's accent as the app-wide tint, so nothing shows the system blue.
4. **A gap is written down.** When one app gets a feature first, the same PR files a GitHub issue for the other app and adds a row to the gaps table below. Removing the row is part of closing the gap.

## Acceptance

- A PR that adds or changes a phone feature either changes both apps or records the gap as rule 4 says.
- A feature's spec file says what each app does, naming the counterpart where the OS feature differs.
- Shared behaviour keeps sharing its test data (the golden files under `crates/` and the fixtures both apps already read), so the apps cannot drift unnoticed.

## Counterparts in the apps today

| Job | iPhone | Android |
| --- | --- | --- |
| A running chat on the Lock Screen | Live Activity | Live Update (Android 16) |
| Counts at a glance | Home Screen and Lock Screen widgets | Home Screen widget |
| One-tap status | Control Center control | Quick Settings tile |
| Open a new chat from the icon | Home Screen quick action | Launcher shortcut |
| Send text from another app | Share extension | Share target |
| Find computers nearby | Bonjour (`NWBrowser`) | Network Service Discovery (`NsdManager`) |
| Device-held signing key | Secure Enclave | Android Keystore |
| Dictation fallback on the phone | Apple's speech recognizer | Android's speech recognizer |
| Stay connected in the background | Background time and grace | Keep-alive foreground service |

## Live dashboard voice gaps (current worktree, native-unverified)

Both implementations use scoped counts and initial English `status`, `send to NAME saying MESSAGE`, `confirm send to NAME saying MESSAGE`, `cancel` grammar. No focused-chat fallback, free-form assistant or approvals dispatcher is implemented. Exact confirmation expires after 60 seconds. See [dashboard behavior and pending checks](live-card-status-dashboard.md).

| Capability | iPhone | Android | Gap / follow-up |
| --- | --- | --- | --- |
| Live card level preview ([#2928](https://github.com/nekko-labs/nekko-agent/issues/2928), 2026-11-17) | Settings shows the Lock Screen card built at the chosen level, with the chat lines that level sends under it | Radio rows with text only, no preview | [#2933](https://github.com/nekko-labs/nekko-agent/issues/2933) |
| Voice without foregrounding | iOS 18+: authenticated LiveActivityIntent + AudioRecordingIntent path implemented, hardware unverified | Notification opens foreground sheet behind app lock; explicit Listen required; no background microphone | No-app goal remains unmet on Android. Track under dashboard #2046; validate supported native paths before claiming parity. |
| Older OS fallback | iOS 17: Open app for voice opens list without auto-listening | Foreground sheet as above | iOS 17 is an app handoff, not equivalent background voice or an app-wide voice sheet. |
| Recognition privacy | Computer transcription or on-device-only iOS recognizer | Existing Dictation engine; phone provider may use network recognition | Do not promise identical on-device-only guarantees. |
| Native proof | No new native test/evidence pass or physical-device proof claimed | No new native test/evidence pass or physical-device proof claimed | Run native builds/tests, inspect matched evidence and verify device auth/microphone/lifecycle before closing the verification gap. |
| Chat environment: repositories and question actions (desktop since #2404) | Actioned `ask_user` options show as plain answers; no repository list | Same | [#2415](https://github.com/nekko-labs/nekko-agent/issues/2415) |
| Run a suggested command in the chat's terminal ([spec](../chat/run-suggested-commands-in-a-terminal.md), desktop since #2595) | No Run on shell blocks | Same | [#2607](https://github.com/nekko-labs/nekko-agent/issues/2607) (iPhone), [#2608](https://github.com/nekko-labs/nekko-agent/issues/2608) (Android) |
| Nekko in the car: voice-first, active work, Results of voice commands ([spec](carplay.md)) | CarPlay app built 2026-11-14 ([#2781](https://github.com/nekko-labs/nekko-agent/issues/2781)): Linux-tested logic, not yet in CarPlay Simulator; waits on Apple's entitlement | Android Auto as a messaging app through notifications (2026-11-17): a finished reply read aloud in the car, with Reply. No Work list, Results, Allow/Deny or Stop: Android Auto has no category for a voice agent | [#2782](https://github.com/nekko-labs/nekko-agent/issues/2782) |
| GitHub star ask under the 10th and 50th reply ([spec](../platform/github-star-ask.md)) | Built 2026-11-09 ([#2423](https://github.com/nekko-labs/nekko-agent/issues/2423)): inline card, link to the repository only, verified in Native iOS CI, not on a device | Built 2026-11-09: inline card, link to the repository only, emulator-verified, not on a physical phone | Both: the native store rating request once on the App Store and Google Play (planned). |
| Open your own computer from an organization's list with no pairing ([spec](../platform/organizations.md), desktop since #2806) | Separate issue #2804 | Protocol layer only (`FleetLink`, unit-tested); no Cloud sign-in, keyring unlock or org list in the app | [#2835](https://github.com/nekko-labs/nekko-agent/issues/2835) |
| Take back an always-allowed MCP tool or a known recipient (desktop since #2960, decisions 0054 and 0063) | Built 2026-11-17: Model panel → **Allowed without asking** (`ChatGrantsList`), each removal signed with Face ID or the passcode (`knownRecipients` joins `PHONE_GUARDED_OPTION_KEYS`); NekkoKit-tested, app target CI-built | Built 2026-11-18: Model sheet → **Allowed without asking** (`GrantsSheet`), each removal signed with the screen lock through `setRunOption`; controller JVM-tested | None: both phones have it. |

## Pending response messages (#2476, #2497)

Both phones keep in-chat answers and one-time Allow/Deny as pending response messages: the iPhone since #2499 (2026-11-13), Android since [#2497](https://github.com/nekko-labs/nekko-agent/issues/2497) (2026-11-16, JVM-tested and emulator-verified, not on a physical phone).

## Direct cloud text chats (#2414, not shipped)

[#2414](https://github.com/nekko-labs/nekko-agent/issues/2414) tracks both platform PRs and stays open until both land. Android is implemented on `feat/android-phone-cloud-2414`; the iPhone counterpart is separate [draft PR #2462](https://github.com/nekko-labs/nekko-agent/pull/2462), not shipped. Branch implementation is not release or visual approval.

| Capability | iPhone branch | Android branch | Verification / gap |
| --- | --- | --- | --- |
| No-computer entry | This iPhone in place/filter and Run on; empty model picker links to setup | This phone from Chats and first run, even without provider/computer | iPhone remains separate PR #2462; Android latest 91c5e4c1e synthetic matrix 18 pass / 2 expected skips plus 36 focused passes |
| Direct text providers | Claude API, OpenAI, OpenRouter, Mantle Messages, Foundry, Vertex, HTTPS compatible | Same seven kinds | No live paid authentication/entitlement checks; Foundry custom deployment names unsupported; Vertex tokens manually renewed |
| One-tap provider setup ([#2851](https://github.com/nekko-labs/nekko-agent/issues/2851)) | OpenRouter browser sign-in returns a key; Claude API, OpenAI, Gemini and Ollama Cloud open their key page and take the key back with one Paste; Gemini and Ollama Cloud kinds | The same, with a wrong key turned down at setup ([#2852](https://github.com/nekko-labs/nekko-agent/issues/2852), 2026-11-16; the browser opens outside the app, no Custom Tab) | OpenRouter sign-in not yet tried against a live account |
| Provider lifecycle and streaming | Setup, Test, rekey, disable/remove; Stop/Retry; stale callback fencing | Same behaviors | Android JVM regression tests plus native synthetic transport checks; not live provider proof |
| Privacy and retention | Device-held Keychain keys and local transcripts | Keystore-sealed separate credential slots and local transcripts | Direct HTTPS, no relay/computer/Nekko Cloud; provider may retain text; Forget is local only; storage is not transactional |
| Reply recovery | Persists partial text per delta with interrupted marker | Persists at attempt start/cleanup; process death can lose partial text | Durability differs; do not promise identical process-kill recovery |
| Layout and evidence | Native iPhone/iPad evidence pending | Narrow/folded, expanded, synthetic book/tabletop/unfolded captures | Parent inspected matched current-main a45e083f2 / after694cf532e first-run pairs and latest 91c5e4c1e light posture content/provider fields; 1 fps motion contact sheets inspected, not continuous playback or physical hardware; new provider/chat surfaces have no before |

Tools, attachments, local models, subscription harnesses and cross-device sync are outside direct-chat scope, not parity claims. New Android forms remain English-only. Physical folding/posture transitions and OEM keyboards remain untested. See [Android direct-chat specification](android-direct-cloud-chats.md) and [continuation disclosure](../../apps/android/docs/phone-cloud-2414-continuation.md), including the historical reset of an existing emulator AVD and the isolated continuation AVD.

## Android is behind the iPhone today

Checked on 2026-11-07 against every iOS change on `main` since 2026-10-30 ([report](../../reports/android-ios-parity-2026-11-07.md)), again on 2026-11-09, and on 2026-11-16 against every iOS change since 2026-11-13, by reading the code, not on a device.

| Feature | Android side | Tracked by |
| --- | --- | --- |
| Computer controls: Cloud fleet group | Waits with Nekko Cloud (#2122); service management, the Models filter and Connect to <computer> landed (2026-11-12/13) | [#2059](https://github.com/nekko-labs/nekko-agent/issues/2059) |
| Push notifications | No push; the keep-alive service covers an open connection | [#2121](https://github.com/nekko-labs/nekko-agent/issues/2121) |
| Nekko Cloud machines | Deferred until proven on the iPhone | [#2122](https://github.com/nekko-labs/nekko-agent/issues/2122) |
| Apple Watch glance | No Wear OS app; needs a decision | [#2123](https://github.com/nekko-labs/nekko-agent/issues/2123) |
| Background grace period | The keep-alive service holds the socket instead | AN-28 |
| CarPlay: voice-first, active work across computers, command results (iPhone #2783, 2026-11-14) | Replies read aloud and answered by voice in Android Auto (notifications); no Work list, Results, approvals or Stop | [#2782](https://github.com/nekko-labs/nekko-agent/issues/2782) |
| New chat: model ⟶ device on one line, the connect checklist and note, the limit line, picker size and context (iPhone #2921-#2925, 2026-11-17) | Still two rows and the "no tools" note | [#2950](https://github.com/nekko-labs/nekko-agent/issues/2950) |

Android features the iPhone lacks have not been audited yet.

Nothing is recorded as a true OS exclusive yet.

## Reconnect status wording

| Capability | iPhone / iPad | Android | Gap / follow-up |
| --- | --- | --- | --- |
| Two-line New Chat reconnect status with fixed-width animated ellipsis | `NAME is reconnecting...` plus `Prompts you send wait on this iPhone.`; verified on iPhone 18 Pro / iOS 27.0 simulator ([spec](ios-streaming-and-reconnect-status.md)) | Same existing dots with `Prompts you send wait on this phone.`; verified on Pixel 5 / API 32 emulator | None |

## Secret box (desktop first, #2594)

| Feature | iPhone | Android | Follow-up |
| --- | --- | --- | --- |
| The chat's secret box when the agent asks for a secret (`request_secret`) | Not implemented: the chat looks busy while it waits | Not implemented: the chat looks busy while it waits | [#2603](https://github.com/nekko-labs/nekko-agent/issues/2603), [#2604](https://github.com/nekko-labs/nekko-agent/issues/2604) |

## Quiet transcript follow-up

| Feature | iPhone | Android | Follow-up |
| --- | --- | --- | --- |
| Collapsed progress notes and continuation summaries | Implemented on #2452 branch, native-unverified | Same folds (2026-11-13); the system bar hides the keyboard | None |
