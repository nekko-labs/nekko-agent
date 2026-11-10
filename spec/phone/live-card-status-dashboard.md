---
title: "Live card: status dashboard and app-wide voice"
area: phone
---

# Live card: status dashboard and app-wide voice

**Status: implemented in the current worktree, native-unverified; not shipped.** The dashboard and deterministic voice paths supersede the chat-row card described historically in [native iOS](native-ios-app.md). Native builds/tests, matched native before/after evidence and physical-device checks for this redesign remain pending. The [editable visual proposal](live-card-status-dashboard.html) is design reference, not native evidence.

## Dashboard replacement decision

For PR #2047, the user explicitly chose this dashboard over main's tappable
Live Activity chat chips (#1912). Main's chip helpers/protocol tests and single-card
lifecycle safeguards remain compatible, but the rendered card and its Settings
preview stay counts-first with Talk to Nekko and Open app. See
[decision 0070](../../docs/decisions/0070-live-activity-dashboard-replaces-chat-chips.md).
Extra visual/device verification is skipped for this repair at the user's request;
that is not a waiver of required CI or evidence checks, nor a claim that the
hardware and accessibility limitations below have been verified.

The main-merge repair also keeps the Swift phone channel registry in parity with
the host allow-list, including main's `chat:generateImage` and `engine:models`.
Image generation remains a signed Change-class call, matching the host's policy;
`engine:models` remains a read. This is protocol metadata synchronization, not
image generation through the dashboard voice grammar; exact allow-list and
Change-class equality tests remain unchanged.

## The three goals

1. **See what is happening.** The card is a status dashboard of agents, not a miniature chat list. Lead with counts such as **3 Building**, **2 Need input**, and **20 Done**. Make attention distinguishable without relying on color alone.
2. **Control Nekko by voice without opening the app.** **Talk to Nekko** is the main CTA. Voice is app-wide, as explicitly selected by Philip, not implicitly directed to whichever chat happens to be focused. Authentication and platform microphone restrictions still apply.
3. **Open the app when needed to handle statuses.** **Open app** is a visibly secondary action leading to the agent list, where the user can review work, answer questions, and handle approvals. Chat-specific controls must not compete with voice on the resting card.

The goals are retained, not all proven met: no-app voice has an implemented but hardware-unverified iOS 18+ path; Android requires foreground UI, and iOS 17 offers an app handoff only.

## Implemented resting-card hierarchy

- Small Nekko Agent header and named computer scope.
- Building, Need input and Done count columns, including zero. Building includes non-code work, not just compilation.
- Secondary Watching and Failed counts when nonzero; failures are not Done. Stale status takes precedence over optional detail. Legacy clipped payloads show a partial-count warning, not guessed totals.
- Primary accent-filled **Talk to Nekko** on iOS 18+, secondary **Open app** to the chat list. On iOS 17 the primary label is **Open app for voice**, also opening the list without automatic capture.
- **Nekko plum palette** `[2026-11-08; contrast computed; native render pending in the deploy:ios batch]`: user intent: the card should match the app's new design, not the old grey and violet. On the Lock Screen and in the Settings preview the card sits on the brand plum ground `#190019` (the app icon's tile and launch screen), washed with the accent from the top (16% to 4%, as the app's coloured ground does in dark). The header carries the pixel Nekko mark instead of a dot. Talk to Nekko is the Dark Nekko accent `#C084B5` with ink `#0C0C11` (6.7:1); secondary buttons are the plum of the app's message bubbles `#3A1438`. Soft text `#A3A1B0` reads 6.4:1 and the attention amber 9.4:1 on the wash's brightest part. The expanded Dynamic Island keeps iOS's black. The widget extension can't see the user's chosen theme, so the card always uses the default Dark Nekko palette.
- No default chat rows, elapsed timers, Allow/Deny/Stop strip or close celebration. Those actions remain in the app, not in the voice dispatcher. Main's notification “Always allow this tool” deep link and authenticated in-app approval handler remain available; this does not add an approval strip to the dashboard.
- Android adapts counts to its ongoing notification/Live Update, with Talk to Nekko first and Open app second. Android owns action styling; notification actions are not an iOS-style custom card.

## Count correctness and scope

- Rust, Swift and Kotlin builders carry optional authoritative per-state totals computed before the eight-chat detail limit and payload-budget trimming. Relay privacy filtering and trimming retain totals.
- Eligibility remains running, needs-input, watching and finished within the last two hours. Done is not an all-time counter. Completed/archived or deleted chats leave under existing rules. Waiting for input takes precedence over running; a chat contributes once to its status.
- **iPhone (2026-11-09, [decision 0073](../../docs/decisions/0073-live-card-counts-the-whole-chat-list.md)):** while the app runs, the counts cover the same chats the chat list shows: every paired computer's and this iPhone's, with each computer's events tracked for Done. The header names that scope ("All computers", or "<computer> + iPhone"), so it is never silent; with one computer and no phone chats it shows the computer's name as before. A local whole-list card wins over the active computer's relay push while the app runs; while it is suspended, the push (that computer only, headed with its name) stands. Before this, a chat building on a non-active computer was missing from the card's Building count though the list showed it.
- The card, its push token and app-wide voice stay the active computer's. App-wide voice does not authorize unrelated computers: `send to` resolves that computer's chats only.
- Old payloads without totals use known detail counts, explicitly partial when `more` is nonzero. Hidden statuses are never guessed.
- Foreground/pushed state reconciliation retains counts and local voice state through detail trimming. Cache expiry and count-change refresh paths are implemented; native lifecycle validation remains pending for this redesign.

## Implemented voice grammar and boundaries

The initial command grammar and dispatcher replies are **English**, separate from composer dictation commands:

| Command | Behavior |
| --- | --- |
| `status` | Summarizes the same scoped dashboard; offline/stale and partial data are labeled. Aliases include `agent status` and `what is happening`. |
| `send to NAME saying MESSAGE` | Resolves a unique full chat name and stages a confirmation; sends nothing yet. A colon can replace `saying`. |
| `confirm send to NAME saying MESSAGE` | Requires the same computer, target id/name and exact message within 60 seconds. |
| `cancel` | Clears pending confirmation/current input, not previously queued or dispatched work. |

Missing, ambiguous, changed or expired targets/confirmations are refused with an app handoff, not guessed. Plain speech never becomes a prompt to `focusId`. No free-form assistant, tool approvals, stop-work command, destructive operation or other general action executor is implemented. Existing in-app authorization still applies.

- **iOS 18+:** `TalkToNekkoIntent` is an authenticated `LiveActivityIntent` conforming to `AudioRecordingIntent`. Authentication precedes bounded capture. Protected-data and computer-scope checks guard dispatch. Background Lock Screen recording is a source implementation, not a physical-device claim.
- **iOS microphone permission (2026-11-09):** iOS cannot show the microphone or speech-recognition prompt from the Lock Screen; it holds the prompt until the app opens, so the first tap used to appear dead (and left the runner busy, so later taps, Cancel and Finish did nothing visible). Now a Lock Screen capture never waits on a prompt: without the microphone permission, the card's main button is **Allow microphone**, a link that opens the app and asks at once (speech recognition too, while unasked), or opens Settings when the microphone was turned off there. The app publishes whether the microphone is granted to the App Group (`VoiceReadiness`) on launch and each return to the foreground and redraws the card when it changes. A tap that still finds a prompt needed (stale flag, or speech recognition unasked while the computer can't transcribe) stops with "Microphone access needed. Tap Allow microphone." The app never starts listening on its own after the permission is granted.
- **iOS listening feedback (2026-11-09):** one tap listens until the first pause, no second tap needed. While listening the card shows "Listening… speak now" with what to say (`status`, or `send to` a chat name, `saying`, the message), then "Hearing you…" once speech starts (amber mic, "Pause when you’re done. Nothing is sent until you confirm."), a running timer from when the mic opened, and Cancel and Finish speaking throughout; then Processing (Cancel, Open app) and Sending (Open app). The collapsed Dynamic Island shows a microphone while listening. What was said is never drawn.
- **iOS Cancel and Finish speaking (2026-11-09):** Talk to Nekko returns once the microphone is open (or the attempt ended) instead of after the whole capture and delivery, so Finish speaking and Cancel, intents of their own, never wait behind it; a background task carries the capture and delivery, and the app declares the `audio` background mode for Lock Screen recording. A start that has not opened the microphone in 15 s (60 s in the app, where a prompt may be up) cancels with "Not sent. The microphone didn’t start. Open app to try again."
- **iOS 17:** Open app for voice opens the chat list, without automatic listening or an app-wide voice sheet. No no-app voice promise applies.
- **Android:** the notification opens a foreground sheet behind the app lock, then requires an explicit Listen tap. No background microphone. Capture and dispatch require the resumed, unlocked, uncovered app on the original computer; pause, cover, disposal or computer change cancels capture and invalidates late results. The existing Dictation engine is used; phone recognition may use its provider's network service, unlike iOS's on-device-only phone fallback.
- **iOS capture scope:** capture pins the intent's computer and its transcription caller before capability/permission waits. The active computer must still match and must not be explicitly denied before opening the microphone, dispatching words or uploading audio. Capability and upload calls share the pinned caller, never a fresh mutable-selection lookup. Archived chats are excluded and the confirmed id/name, archive state, card scope and authorization are checked again at persistence.
- **Delivery:** iOS distinguishes queued from confirmed delivery and explicitly says delivery is not completion. Legitimate offline delivery still queues. Processing keeps the card alive and remains cancellable throughout preparation, including the connection wait. A generation guard runs synchronously immediately before outbox persistence; once committed, Sending replaces Processing and hides Cancel; Cancel cannot recall it or claim nothing was sent. Android reports queued, not yet confirmed sent or completed. No secret, credential, raw error or full captured transcript belongs in the Lock Screen payload; dispatcher guidance/results do not echo the full target/message.

## Levels and localization

None disables the card. All enabled iOS levels draw counts and voice, with an inert Settings preview of the same view. Minimal removes chat text from pushed state. Standard/Detailed still permit their existing chat detail payloads through the relay and Apple's push service even though the dashboard does not draw those details. Choose Minimal for counts without chat text; a counts-only view is not a new transport privacy guarantee.

Dashboard and Settings catalog labels have the existing seven-language coverage. Command parsing and dispatcher replies remain initially English; adding catalog entries does not localize dynamically returned English replies. Android notification action labels are localized, not the entire foreground voice sheet.

## Strict native acceptance follow-up (2026-11-09)

Test-only follow-up, not a new product capability: the security evidence checks the fixture's actual
**0 Building / 1 Need input / 0 Done** totals, the Open app handoff and absence of a dashboard
approval strip. It retains the authenticated notification-link execution and the refused-save
assertion that the call still waits; a container's presence alone is not authorization evidence.
The separate live notification journey retains its original **20-second** result deadline,
online-button precondition, yielding poll, actual result label and visible banner assertions.
Source-contract checks do not prove Swift compilation, delivery timing, or native accessibility
labels. Native execution of these strengthened checks remains **unverified**.

## Verification still pending

Source changes include producer/relay/protocol/dispatcher tests and native UI evidence fixtures. Their presence is not a passing native run.

The reviewed iOS voice boundaries have 20 passing focused tests in an isolated Swift 6.1 Docker harness: the real voice/outbox/draft sources, protocol module, and extracted App delivery helper (four App integration tests plus sixteen voice tests, including read-only routing API compatibility). The native-only Dictation discard/late-result integration test is added but unrun. Linux syntax parsing of the changed App sources is not native typechecking. A direct package-wide build is blocked by unrelated Linux `String(localized:)` availability and `PreviewLoader` isolation errors; native builds, microphone permission/capture, Lock Screen interaction and visual evidence remain pending.

- [ ] Run focused producer/relay/model/dispatcher tests and native iOS/Android build, unit and UI suites on supported hosts.
- [ ] Capture and inspect matched native before/after evidence at the same runtime, theme and data: zero/mixed totals, 20+ Done, stale/partial payloads, finished-tail expiry, Settings, compact/expanded Island and Android notification adaptation.
- [ ] Validate accessibility, large text, hit areas and long translations on native surfaces.
- [ ] Physical iPhone: auth refusal, Face ID then Lock Screen/background recording, cancellation/late results, reconnect, outbox results, push reconciliation and real APNs delivery. Simulator rendering cannot prove these capabilities.
- [ ] Verify iOS 17 Open app fallback does not auto-listen; verify iOS 18+ recording-intent behavior on hardware.
- [ ] Physical iPhone (2026-11-09 fixes): Allow microphone with the permission unasked, refused and turned off in Settings; first-tap capture after granting; Hearing you, timer, Cancel and Finish speaking from the Lock Screen while listening; the `audio` background mode keeps Lock Screen capture alive after the intent returns; counts match the chat list with two computers and phone chats, and the header label.
- [ ] Android device: notification entry, lock/permission refusal, explicit Listen, microphone lifecycle, background cancellation and recognition privacy.

No native evidence is supplied yet. Foreground-only Android voice and the iOS 17 app handoff remain explicit limitations; see [parity gaps](ios-and-android-stay-in-step.md).

## Implementation references

- `apps/ios/App/Shared/LiveCardView.swift`: dashboard, listening phases, Allow microphone and fallback links; `VoiceReadiness.swift`: the App Group microphone flag.
- `apps/ios/App/Views/LiveActivitySettingsView.swift`: preview and level privacy footers.
- `apps/ios/App/Shared/AgentRunActivity.swift`: authenticated Talk to Nekko, Finish/Cancel intents.
- `apps/ios/App/AppModel.swift`, `wireTalk`, and `apps/ios/Protocol/Sources/NekkoKit/NekkoVoice.swift`: capture, dispatcher and outbox delivery.
- `apps/ios/Protocol/Sources/NekkoProtocol/LiveCard.swift` and Kotlin counterpart: totals and eligibility.
- `crates/nekko-remote/src/card.rs`, `apps/relay-server/src/push.ts`: pushed totals, privacy and byte budget.
- `apps/android/app/src/main/java/com/nekko/android/connection/StatusDashboard.kt`, `Notices.kt`, `ui/screens/NekkoVoiceSheet.kt`, `voice/NekkoVoice.kt`: notification and foreground voice adaptation.
