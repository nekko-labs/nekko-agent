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
| Voice without foregrounding | iOS 18+: authenticated LiveActivityIntent + AudioRecordingIntent path implemented, hardware unverified | Notification opens foreground sheet behind app lock; explicit Listen required; no background microphone | No-app goal remains unmet on Android. Track under dashboard #2046; validate supported native paths before claiming parity. |
| Older OS fallback | iOS 17: Open app for voice opens list without auto-listening | Foreground sheet as above | iOS 17 is an app handoff, not equivalent background voice or an app-wide voice sheet. |
| Recognition privacy | Computer transcription or on-device-only iOS recognizer | Existing Dictation engine; phone provider may use network recognition | Do not promise identical on-device-only guarantees. |
| Native proof | No new native test/evidence pass or physical-device proof claimed | No new native test/evidence pass or physical-device proof claimed | Run native builds/tests, inspect matched evidence and verify device auth/microphone/lifecycle before closing the verification gap. |
| Chat environment: repositories and question actions (desktop since #2404) | Actioned `ask_user` options show as plain answers; no repository list | Same | [#2415](https://github.com/nekko-labs/nekko-agent/issues/2415) |
| Run a suggested command in the chat's terminal ([spec](../chat/run-suggested-commands-in-a-terminal.md), desktop since #2595) | No Run on shell blocks | Same | [#2607](https://github.com/nekko-labs/nekko-agent/issues/2607) (iPhone), [#2608](https://github.com/nekko-labs/nekko-agent/issues/2608) (Android) |
| Nekko in the car: voice-first, active work, Results of voice commands ([spec](carplay.md)) | CarPlay app built 2026-11-14 ([#2781](https://github.com/nekko-labs/nekko-agent/issues/2781)): Linux-tested logic, not yet in CarPlay Simulator; waits on Apple's entitlement | Android Auto as a messaging app through notifications (2026-11-17): a finished reply read aloud in the car, with Reply. No Work list, Results, Allow/Deny or Stop: Android Auto has no category for a voice agent | [#2782](https://github.com/nekko-labs/nekko-agent/issues/2782) |
| GitHub star ask under the 10th and 50th reply ([spec](../platform/github-star-ask.md)) | Built 2026-11-09 ([#2423](https://github.com/nekko-labs/nekko-agent/issues/2423)): inline card, link to the repository only, verified in Native iOS CI, not on a device | Built 2026-11-09: inline card, link to the repository only, emulator-verified, not on a physical phone | Both: the native store rating request once on the App Store and Google Play (planned). |
| Open your own computer from an organization's list with no pairing ([spec](../platform/organizations.md), desktop since #2806) | Separate issue #2804 | Protocol layer only (`FleetLink`, unit-tested); no Cloud sign-in, keyring unlock or org list in the app | [#2835](https://github.com/nekko-labs/nekko-agent/issues/2835) |
| The account's computers connect without pairing: `reach` records, route merge by room, the account HELLO ([spec](iphone-account-computers-without-pairing.md), decision 0128) | Built 2026-11-28 ([#3610](https://github.com/nekko-labs/nekko-agent/issues/3610)): background sync, computers from your account, merged routes, plain refusals. NekkoKit and NekkoProtocol tested; app target and device not verified | Protocol and repository layers built 2026-11-28 (`reach` records in `CloudSync`, route merge, account HELLO, `AccountSyncLoop`; JVM tested). Not usable in the app: no Nekko Cloud sign-in on Android yet, so no records are read | [#3611](https://github.com/nekko-labs/nekko-agent/issues/3611), [#2835](https://github.com/nekko-labs/nekko-agent/issues/2835) |
| Paid cloud clip picker with a live total ([spec](../agents/media-tools-for-chat-agents.md), desktop since #2973 step 6) | Built 2026-11-20 (`ClipPickerCard`, logic in `ClipPicker`): segmented Length, Audio and Resolution, a Total that updates, the cannot-be-stopped warning with where the prompt goes, Cancel and **Make clip · $2.40**; answers carry the total, so no second approval. Logic Linux-tested; app target not built here and no simulator evidence yet | Built 2026-11-20 (`ClipPickerCard`, logic in `ClipPicker.kt`; JVM-tested, no emulator evidence yet) | None: both phones have it ([#3038](https://github.com/nekko-labs/nekko-agent/issues/3038)); visual evidence pending on both. |
| Agent-made pictures under the tool row, and the **Making a clip** chip ([spec](../agents/media-tools-for-chat-agents.md), desktop since #2973) | Built 2026-11-20: `generate_image` / `edit_image` pictures load on demand through `session:photo` and open in the image viewer; the clip chip shows stage and **Cancel clip**; clips are never a timed wake-up. Logic Linux-tested; no simulator evidence yet | Built 2026-11-20: the same pictures through `session:photo`, opened full screen on a tap; the clip chip with **Cancel clip**. JVM-tested; no emulator evidence yet | None: both phones have it; visual evidence pending on both. |
| Take back an always-allowed MCP tool or a known recipient (desktop since #2960, decisions 0054 and 0063) | Built 2026-11-17: Model panel → **Allowed without asking** (`ChatGrantsList`), each removal signed with Face ID or the passcode (`knownRecipients` joins `PHONE_GUARDED_OPTION_KEYS`); NekkoKit-tested, app target CI-built | Built 2026-11-18: Model sheet → **Allowed without asking** (`GrantsSheet`), each removal signed with the screen lock through `setRunOption`; controller JVM-tested | None: both phones have it. |

## New chat: model on device, the connect checklist, limits and picker detail (#2950)

| Feature | iPhone | Android | Gap / follow-up |
| --- | --- | --- | --- |
| Model ⟶ device on one line; the provider, then effort's word give way, then both names shorten | Built 2026-11-17 (#2952) | Built 2026-11-25: the device half opens Run on (Automatic, the computers, This phone); the Run on card is gone | Android's This phone opens the phone's own chats screen, as before: phone chats don't start from New chat |
| No "no tools" note; the open phone chat says model ⟶ This phone once | Built (#2952) | Built 2026-11-25 | None |
| Connect checklist over the first message, then the closeable note, with Undo | Built (#2952) | Built 2026-11-25 (`ConnectChecklist` ported with the same cases) | None |
| The limit line in New chat and above an open chat's message box; phone keys from the last answer's rate-limit headers | Built (#2953) | Built 2026-11-25 (`LimitLine`, `PhoneRateLimits.providerLimits`, same cases) | None |
| Model picker: size or context per model, dated snapshots folded, limits under each provider | Built (#2954) | Built 2026-11-25 (`ModelMeta`, `ModelSnapshots`, same cases) | None |

Both: JVM or Linux unit tests only; neither app's screens have been looked at on a device or emulator yet.

## Chat groups and tags (#3334)

| Feature | iPhone | Android | Gap / follow-up |
| --- | --- | --- | --- |
| Groups with colours and tags on chats ([spec](../agents/chat-groups.md), desktop since #3335): the list clusters chats by group and shows tags; the title reads group / #tags / title | Not built. `chatGroup` and `tags` already sync and are on the phone allowlist; the groups' names and colours are per-computer localStorage prefs the phone cannot read | Same | [#3478](https://github.com/nekko-labs/nekko-agent/issues/3478) (iPhone), [#3479](https://github.com/nekko-labs/nekko-agent/issues/3479) (Android) |

## Pending response messages (#2476, #2497)

Both phones keep in-chat answers and one-time Allow/Deny as pending response messages: the iPhone since #2499 (2026-11-13), Android since [#2497](https://github.com/nekko-labs/nekko-agent/issues/2497) (2026-11-16, JVM-tested and emulator-verified, not on a physical phone).

## Cloud models on the phone are a beta setting

Both phones: **Settings → Beta → Cloud models on This iPhone / This phone**, off for a new install, on for one that already used it. Same rule, same surfaces hidden, same wording. One difference, written down: with no computer paired the iPhone shows only its welcome screen (no Settings), so its welcome link says *(beta)* and turns it on; Android's Chats screen and Settings are there with no computer, so the switch is the way in. See [the beta setting](phone-cloud-models-beta-setting.md).

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
| Real brand marks on sign-in and provider headings (iPhone #2930, 2026-11-17) | Android has no Nekko Cloud sign-in yet; provider marks exist on chat rows only | [#2938](https://github.com/nekko-labs/nekko-agent/issues/2938) |
| Settings: Nekko Cloud profile on top (iPhone #2929, 2026-11-17) | Computers first, Models on This phone, avatar rows with a plus and the quiet design built 2026-11-26; the profile row waits for Nekko Cloud sign-in on Android (#2835) | [#2940](https://github.com/nekko-labs/nekko-agent/issues/2940) |

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

## The computer a synced chat came from (desktop first, #3143)

| Feature | iPhone | Android | Follow-up |
| --- | --- | --- | --- |
| A synced chat names the computer it belongs to, and chats group by computer | Not implemented: synced chats show without their computer | Not implemented: no Nekko Cloud sync screens yet (#2835) | [#3147](https://github.com/nekko-labs/nekko-agent/issues/3147) |

## Quiet transcript follow-up

| Feature | iPhone | Android | Follow-up |
| --- | --- | --- | --- |
| Collapsed progress notes and continuation summaries | Implemented on #2452 branch, native-unverified | Same folds (2026-11-13); the system bar hides the keyboard | None |
| Saved chats and chat lists written off the main thread, unchanged chats skipped (#3386) | Implemented, unit-tested in NekkoKit | Not implemented: `OfflineFileStore.save` writes synchronously on the caller's thread | https://github.com/nekko-labs/nekko-agent/issues/3419 |


## Performance pass (iPhone first, 2026-11-26)

| Feature | iPhone | Android | Follow-up |
| --- | --- | --- | --- |
| Relay reconnect backoff has 0 to 50% random jitter (#3385) | Implemented, unit-tested in NekkoProtocol | Not implemented: fixed 1, 2, 4 ... 30 s | https://github.com/nekko-labs/nekko-agent/issues/3392 |

## Performance pass (iPhone first, 2026-11-26)

| Feature | iPhone | Android | Follow-up |
| --- | --- | --- | --- |
| Streamed text is folded in once per display frame (#3387) | Implemented, unit-tested in NekkoKit | Not implemented: one state update per token | https://github.com/nekko-labs/nekko-agent/issues/3432 |
| Mermaid web view released when idle, disk cache pruned to 30 days and 64 MB (#3389) | Implemented, unit-tested in NekkoKit | Not implemented: the web view lives for the process and the disk cache grows | https://github.com/nekko-labs/nekko-agent/issues/3436 |

## Performance pass (Android, 2026-11-26)

| Feature | iPhone | Android | Follow-up |
| --- | --- | --- | --- |
| Chat re-reads skip the skills read | Implemented (#3388) | Implemented (#3415) | None |
| Paged chat open (`session:page`, tail first, older on scroll) | Waits for the engine | Waits for the engine | Engine: [#3439](https://github.com/nekko-labs/nekko-agent/issues/3439); client: iPhone [#3388](https://github.com/nekko-labs/nekko-agent/issues/3388), Android [#3415](https://github.com/nekko-labs/nekko-agent/issues/3415). Both use the contract in #3439. |
| Search inside chat messages (`sessions:finderText`, a snippet of the matching line) | Implemented (2026-11-27) | Implemented (2026-11-27) | None ([#3448](https://github.com/nekko-labs/nekko-agent/issues/3448): engine #3563, Android #3594, iPhone in the same stack). See [search-inside-chat-messages.md](search-inside-chat-messages.md). |

