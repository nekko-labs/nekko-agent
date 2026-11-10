---
title: "iOS and Android stay in step (2026-11-02)"
area: phone
---

# iOS and Android stay in step (2026-11-02)

Philip asked (2026-11-02) that the two phone apps do the same things, for what exists today and for everything new, and look like the same product while each feels at home on its own phone. Why this and not iOS first, Android later: [decision 0061](../../docs/decisions/0061-ios-and-android-stay-in-step.md).

## The rule

1. **Same features.** A feature on one app belongs on the other, existing or new. Someone who changes phones should lose nothing.
2. **Only a true OS exclusive stays on one app.** If the other OS has an equivalent, build that, the way Apple Pay on iPhone maps to Samsung Pay or Google Pay on Android. A feature stays one-sided only when the other OS has nothing that can do the job, and this file says so.
3. **Native manners, one look.** Each app follows its own platform's design guidance (Apple's Human Interface Guidelines, Material on Android) for navigation, controls, sheets, type and motion. The Nekko themes, mascot, wording and the order of what a screen shows stay the same, so the two read as one product.
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
| Voice without foregrounding | iOS 18+: authenticated LiveActivityIntent + AudioRecordingIntent path implemented, hardware unverified | Notification opens foreground sheet behind app lock; explicit Listen required; no background microphone | No-app goal remains unmet on Android. Track under dashboard #2046; validate supported native paths before claiming parity. |
| Older OS fallback | iOS 17: Open app for voice opens list without auto-listening | Foreground sheet as above | iOS 17 is an app handoff, not equivalent background voice or an app-wide voice sheet. |
| Recognition privacy | Computer transcription or on-device-only iOS recognizer | Existing Dictation engine; phone provider may use network recognition | Do not promise identical on-device-only guarantees. |
| Native proof | No new native test/evidence pass or physical-device proof claimed | No new native test/evidence pass or physical-device proof claimed | Run native builds/tests, inspect matched evidence and verify device auth/microphone/lifecycle before closing the verification gap. |
| Chat environment: repositories and question actions (desktop since #2404) | Actioned `ask_user` options show as plain answers; no repository list | Same | [#2415](https://github.com/nekko-labs/nekko-agent/issues/2415) |
| GitHub star ask under the 10th and 50th reply ([spec](../platform/github-star-ask.md)) | Being built | Built 2026-11-09: inline card, link to the repository only, emulator-verified, not on a physical phone | iPhone: [#2423](https://github.com/nekko-labs/nekko-agent/issues/2423). Both: the native store rating request once on the App Store and Google Play (planned). |

## Pending response messages (#2476, not shipped)

The lower stack layer implements iOS pending in-chat answers and one-time Allow/Deny messages. Android parity is tracked in [#2497](https://github.com/nekko-labs/nekko-agent/issues/2497) and the upper stack layer. Neither branch implementation nor an uninspected capture is release verification.

## Direct cloud text chats (#2414, not shipped)

[#2414](https://github.com/nekko-labs/nekko-agent/issues/2414) tracks both platform PRs and stays open until both land. Android is implemented on `feat/android-phone-cloud-2414`; the iPhone counterpart is separate [draft PR #2462](https://github.com/nekko-labs/nekko-agent/pull/2462), not shipped. Branch implementation is not release or visual approval.

| Capability | iPhone branch | Android branch | Verification / gap |
| --- | --- | --- | --- |
| No-computer entry | This iPhone in place/filter and Run on; empty model picker links to setup | This phone from Chats and first run, even without provider/computer | iPhone remains separate PR #2462; Android latest 91c5e4c1e synthetic matrix 18 pass / 2 expected skips plus 36 focused passes |
| Direct text providers | Claude API, OpenAI, OpenRouter, Mantle Messages, Foundry, Vertex, HTTPS compatible | Same seven kinds | No live paid authentication/entitlement checks; Foundry custom deployment names unsupported; Vertex tokens manually renewed |
| Provider lifecycle and streaming | Setup, Test, rekey, disable/remove; Stop/Retry; stale callback fencing | Same behaviors | Android JVM regression tests plus native synthetic transport checks; not live provider proof |
| Privacy and retention | Device-held Keychain keys and local transcripts | Keystore-sealed separate credential slots and local transcripts | Direct HTTPS, no relay/computer/Nekko Cloud; provider may retain text; Forget is local only; storage is not transactional |
| Reply recovery | Persists partial text per delta with interrupted marker | Persists at attempt start/cleanup; process death can lose partial text | Durability differs; do not promise identical process-kill recovery |
| Layout and evidence | Native iPhone/iPad evidence pending | Narrow/folded, expanded, synthetic book/tabletop/unfolded captures | Parent inspected matched current-main a45e083f2 / after694cf532e first-run pairs and latest 91c5e4c1e light posture content/provider fields; 1 fps motion contact sheets inspected, not continuous playback or physical hardware; new provider/chat surfaces have no before |

Tools, attachments, local models, subscription harnesses and cross-device sync are outside direct-chat scope, not parity claims. New Android forms remain English-only. Physical folding/posture transitions and OEM keyboards remain untested. See [Android direct-chat specification](android-direct-cloud-chats.md) and [continuation disclosure](../../apps/android/docs/phone-cloud-2414-continuation.md), including the historical reset of an existing emulator AVD and the isolated continuation AVD.

## Android is behind the iPhone today

Checked on 2026-11-07 against every iOS change on `main` since 2026-10-30 ([report](../../reports/android-ios-parity-2026-11-07.md)), and again on 2026-11-09 against the changes since, by reading the code, not on a device.

| Feature | Android side | Tracked by |
| --- | --- | --- |
| Full system-permissions checklist in onboarding and Settings (no video) | Notifications-only onboarding; checklist not yet implemented | [#2251](https://github.com/nekko-labs/nekko-agent/issues/2251) |
| Computer controls: persistent connection opt-out, Models disclosure and filters, Cloud fleet group, and service management | Not implemented on Android | [#2059](https://github.com/nekko-labs/nekko-agent/issues/2059) |
| Watching and Done groups, collapsible groups (PR status on rows landed 2026-11-09) | Only a Needs you group | [#2107](https://github.com/nekko-labs/nekko-agent/issues/2107) |
| One chat list across every computer, group by computer | One computer's list at a time | [#2108](https://github.com/nekko-labs/nekko-agent/issues/2108) |
| Connectors page (with the brand logos the iPhone has had since 2026-11-09) | Missing | [#2109](https://github.com/nekko-labs/nekko-agent/issues/2109) |
| Full-screen photos, previews before and after sending | No photo viewer | [#2111](https://github.com/nekko-labs/nekko-agent/issues/2111) |
| Edit photos in image chats: attach photos to a prompt, Edit under a made picture | Not implemented on Android | [#2230](https://github.com/nekko-labs/nekko-agent/issues/2230) |
| Usage by computer and by this phone | One computer's totals | [#2114](https://github.com/nekko-labs/nekko-agent/issues/2114) |
| Plan sheet on the composer | Missing (the iPhone's `PlanSheet.swift`) | [#2115](https://github.com/nekko-labs/nekko-agent/issues/2115) |
| Live card: chats as chips that open the chat | Focused chat and its actions only | [#2116](https://github.com/nekko-labs/nekko-agent/issues/2116) |
| Dark launcher icon and Spooky seasonal icon | Neither; Android can swap launcher icons with an activity alias | [#2118](https://github.com/nekko-labs/nekko-agent/issues/2118) |
| Push notifications | No push; the keep-alive service covers an open connection | [#2121](https://github.com/nekko-labs/nekko-agent/issues/2121) |
| Nekko Cloud machines | Deferred until proven on the iPhone | [#2122](https://github.com/nekko-labs/nekko-agent/issues/2122) |
| Apple Watch glance | No Wear OS app; needs a decision | [#2123](https://github.com/nekko-labs/nekko-agent/issues/2123) |
| Customize page: view, this phone's tone, skills | Missing; Simple/Detailed is in the pill | [#2426](https://github.com/nekko-labs/nekko-agent/issues/2426) |
| Background grace period | The keep-alive service holds the socket instead | AN-28 |

Android features the iPhone lacks have not been audited yet.

Nothing is recorded as a true OS exclusive yet.
