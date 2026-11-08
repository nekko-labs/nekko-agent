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
[decision 0069](../../docs/decisions/0069-live-activity-dashboard-replaces-chat-chips.md).
Extra visual/device verification is skipped for this repair at the user's request;
that is not a waiver of required CI or evidence checks, nor a claim that the
hardware and accessibility limitations below have been verified.

The main-merge repair also keeps the Swift phone channel registry in parity with
the host allow-list, including main's `chat:generateImage` and `engine:models`.
This is protocol metadata synchronization, not image generation through the
dashboard voice grammar; exact allow-list equality tests remain unchanged.

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
- No default chat rows, elapsed timers, Allow/Deny/Stop strip or close celebration. Those actions remain in the app, not in the voice dispatcher.
- Android adapts counts to its ongoing notification/Live Update, with Talk to Nekko first and Open app second. Android owns action styling; notification actions are not an iOS-style custom card.

## Count correctness and scope

- Rust, Swift and Kotlin builders carry optional authoritative per-state totals computed before the eight-chat detail limit and payload-budget trimming. Relay privacy filtering and trimming retain totals.
- Eligibility remains running, needs-input, watching and finished within the last two hours. Done is not an all-time counter. Completed/archived or deleted chats leave under existing rules. Waiting for input takes precedence over running; a chat contributes once to its status.
- The scope is the card's computer, not silently every paired computer. App-wide voice does not authorize unrelated computers.
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

- **iOS 18+:** `TalkToNekkoIntent` is an authenticated `LiveActivityIntent` conforming to `AudioRecordingIntent`. Authentication precedes bounded capture. Protected-data and computer-scope checks guard dispatch. Listening, Processing, Finish speaking, Cancel and generic result/failure states are implemented. Background Lock Screen recording is a source implementation, not a physical-device claim.
- **iOS 17:** Open app for voice opens the chat list, without automatic listening or an app-wide voice sheet. No no-app voice promise applies.
- **Android:** the notification opens a foreground sheet behind the app lock, then requires an explicit Listen tap. No background microphone. Capture and dispatch require the resumed, unlocked, uncovered app on the original computer; pause, cover, disposal or computer change cancels capture and invalidates late results. The existing Dictation engine is used; phone recognition may use its provider's network service, unlike iOS's on-device-only phone fallback.
- **iOS capture scope:** capture pins the intent's computer and its transcription caller before capability/permission waits. The active computer must still match and must not be explicitly denied before opening the microphone, dispatching words or uploading audio. Capability and upload calls share the pinned caller, never a fresh mutable-selection lookup. Archived chats are excluded and the confirmed id/name, archive state, card scope and authorization are checked again at persistence.
- **Delivery:** iOS distinguishes queued from confirmed delivery and explicitly says delivery is not completion. Legitimate offline delivery still queues. Processing keeps the card alive and remains cancellable throughout preparation, including the connection wait. A generation guard runs synchronously immediately before outbox persistence; once committed, Sending replaces Processing and hides Cancel; Cancel cannot recall it or claim nothing was sent. Android reports queued, not yet confirmed sent or completed. No secret, credential, raw error or full captured transcript belongs in the Lock Screen payload; dispatcher guidance/results do not echo the full target/message.

## Levels and localization

None disables the card. All enabled iOS levels draw counts and voice, with an inert Settings preview of the same view. Minimal removes chat text from pushed state. Standard/Detailed still permit their existing chat detail payloads through the relay and Apple's push service even though the dashboard does not draw those details. Choose Minimal for counts without chat text; a counts-only view is not a new transport privacy guarantee.

Dashboard and Settings catalog labels have the existing seven-language coverage. Command parsing and dispatcher replies remain initially English; adding catalog entries does not localize dynamically returned English replies. Android notification action labels are localized, not the entire foreground voice sheet.

## Verification still pending

Source changes include producer/relay/protocol/dispatcher tests and native UI evidence fixtures. Their presence is not a passing native run.

The reviewed iOS voice boundaries have 20 passing focused tests in an isolated Swift 6.1 Docker harness: the real voice/outbox/draft sources, protocol module, and extracted App delivery helper (four App integration tests plus sixteen voice tests, including read-only routing API compatibility). The native-only Dictation discard/late-result integration test is added but unrun. Linux syntax parsing of the changed App sources is not native typechecking. A direct package-wide build is blocked by unrelated Linux `String(localized:)` availability and `PreviewLoader` isolation errors; native builds, microphone permission/capture, Lock Screen interaction and visual evidence remain pending.

- [ ] Run focused producer/relay/model/dispatcher tests and native iOS/Android build, unit and UI suites on supported hosts.
- [ ] Capture and inspect matched native before/after evidence at the same runtime, theme and data: zero/mixed totals, 20+ Done, stale/partial payloads, finished-tail expiry, Settings, compact/expanded Island and Android notification adaptation.
- [ ] Validate accessibility, large text, hit areas and long translations on native surfaces.
- [ ] Physical iPhone: auth refusal, Face ID then Lock Screen/background recording, cancellation/late results, reconnect, outbox results, push reconciliation and real APNs delivery. Simulator rendering cannot prove these capabilities.
- [ ] Verify iOS 17 Open app fallback does not auto-listen; verify iOS 18+ recording-intent behavior on hardware.
- [ ] Android device: notification entry, lock/permission refusal, explicit Listen, microphone lifecycle, background cancellation and recognition privacy.

No native evidence is supplied yet. Foreground-only Android voice and the iOS 17 app handoff remain explicit limitations; see [parity gaps](ios-and-android-stay-in-step.md).

## Implementation references

- `apps/ios/App/Shared/LiveCardView.swift`: dashboard and fallback links.
- `apps/ios/App/Views/LiveActivitySettingsView.swift`: preview and level privacy footers.
- `apps/ios/App/Shared/AgentRunActivity.swift`: authenticated Talk to Nekko, Finish/Cancel intents.
- `apps/ios/App/AppModel.swift`, `wireTalk`, and `apps/ios/Protocol/Sources/NekkoKit/NekkoVoice.swift`: capture, dispatcher and outbox delivery.
- `apps/ios/Protocol/Sources/NekkoProtocol/LiveCard.swift` and Kotlin counterpart: totals and eligibility.
- `crates/nekko-remote/src/card.rs`, `apps/relay-server/src/push.ts`: pushed totals, privacy and byte budget.
- `apps/android/app/src/main/java/com/nekko/android/connection/StatusDashboard.kt`, `Notices.kt`, `ui/screens/NekkoVoiceSheet.kt`, `voice/NekkoVoice.kt`: notification and foreground voice adaptation.
