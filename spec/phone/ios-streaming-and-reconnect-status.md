---
title: "Steady iOS streaming replies and reconnect status"
area: phone
---

# Steady iOS streaming replies and reconnect status

## Intent

Incoming reply text on iPhone and iPad should not bounce while it is written. New chat should separate the computer's connection status from what the reader can do while waiting. Tracked in [#2474](https://github.com/nekko-labs/nekko-agent/issues/2474).

## Branch implementation, not yet native-verified

- On iOS 18+, follow measured transcript height changes at the scroll-content edge after layout rather than issuing a scroll for each token revision. Reader-driven scrolling changes follow intent; a lazy end sentinel disappearing during layout does not. A reader scrolling into history cancels pending structural settling. Jump to latest restores follow mode.
- Keep the existing lazy-row settling for initial transcript loads. On iOS 18+, structural growth follows the measured content edge without an additional delayed sentinel scroll; iOS 17 retains structural settling. iOS 17 retains the prior token/sentinel fallback; this branch does not claim to fix that OS.
- For a remote text new chat with no supporting folders requiring confirmation, show `NAME is reconnecting...` and, below it, `Draft your message now and it will send when NAME reconnects`. NAME is the paired computer name, not a hardcoded Gomi.
- Animate only the visibility of three literal periods in their final-width space. Reduce Motion shows all three; inactive scenes pause updates. VoiceOver gets a stable status label rather than repeated punctuation announcements.
- Keep the specific image-chat and supporting-folder notices. No change to queuing, sending, transport, persistence or confirmations. Drafting alone does not submit a message: the reader must still choose Send.

## Acceptance and verification

- An append-only synthetic reply stays at the end without backward offset jumps greater than one point after initial settling.
- During streaming, scrolling into history exposes Jump to latest and does not force the reader back. Tapping it resumes following.
- The reconnect notice has the exact two-line wording and stable dimensions across the ellipsis cycle.
- Matched native iPhone and iPad screenshots and recordings use identical fixtures, default theme, OS runtime and viewport on base and head. Inspect captured pixels and motion before claiming the symptom fixed.
- `StreamingStabilityTests` and `StreamingGeometryProbe` exercise real views over an in-memory connection, without real providers, sockets, credentials or user data. Before runs record behavior without enforcing new acceptance thresholds.

Native evidence run 42826582337 compiled base and head on both simulators. The head iPad streaming journey passed, but iPhone measured a 12.667-point backward offset (acceptance remains one point); both reconnect tests failed their static-text title lookup despite the requested wording being visible on the inspected iPhone screenshot. The follow-up uses the iOS 18 scroll-content edge instead of the lazy sentinel for measured growth, and tests the grouped title by stable accessibility identifier and exact label. Follow-up native geometry assertions and matched visual/motion inspection are pending; these changes are not a verified fix. Source inspection identifies the pre-layout scroll path as a candidate cause, not device-level proof. Physical devices, iOS 17 and actual foldable hardware remain unverified. Android notice parity is tracked separately in [#2475](https://github.com/nekko-labs/nekko-agent/issues/2475).

### Follow-up native result and next experiment

Run 42866034319 still fails on iPhone: 13-point backward offset and missing grouped-title accessibility identifier. Content-edge scrolling alone did not solve the symptom. The next harness records all sampled offsets, content heights, viewport/insets and the failed notice accessibility hierarchy while retaining the same one-point threshold and sampling window. The notice explicitly contains its accessible children to avoid inheriting the outer notice identifier. This remains an unverified accessibility correction, not a verified streaming fix. Full-native Swift Testing termination also reproduces on exact unchanged base in 42872644644; tracked separately in #2531 (recursive test helper identified in that issue).

Diagnostic run 42883628075: both head reconnect tests passed after explicit accessibility containment. iPad streaming failed 12.5 points; trace shows backward correction with unchanged content size/insets (234 to 222 at height 1420), consistent with delayed structural sentinel scrolling excluding the 12-point bottom padding. The follow-up removes that competing structural scroll only on iOS 18+; initial-load settling and iOS 17 remain. This diagnosis is trace-supported but the correction still requires native proof. The head iPhone streaming journey passed, but its probe captured little growth, so a broader active-growth sampling interval is required before acceptance.

The strengthened harness samples 300 times rather than 75, waits for completed numeric results and requires more than 100 points of actual content-height growth on both base and head. It retains the one-point backward limit. This prevents a short, mostly pre-stream sampling interval from producing a misleading pass.

Run42894094554 at a3492d69a: both native probes collected300 samples, zero backward movement, and real growth746pt iPhone /747pt iPad. iPhone complete journey passed. iPad reconnect launch timed out in Xcode; subsequent streaming test passed growth/backward assertions but failed history-scroll intent (Jump absent; inspected history PNG still at end). This does not satisfy full acceptance. Follow-up diagnostic logs fixture-only phase/geometry/follow intent and extends synthetic output120 lines so history interaction occurs while output is still incoming on slower runners. No further production follow behavior changed pending those logs.

Run 42904559479: iPhone complete pass, both base legs pass, iPad fails last-message readiness text (stream replaces it) and Jump presence. App prints did not reach XCTest logs. Follow-up exposes a bounded 200-event phase/follow trace through the fixture accessibility probe and exports it after the gesture; drag uses 30%-70% transcript coordinates to avoid safe-area overlays. Readiness now waits on the transcript; real-growth assertions still prove content arrived. Production follow behavior and all geometry/Jump limits unchanged.

Android (2026-11-13, #2475): New chat shows the same two lines while the computer is away (`ReconnectingNotice`, in place of the single paragraph). The three dots keep their width and only their opacity cycles every 0.4 s; with animations off they stay, all shown; the cycle stops in the background. A screen reader hears "NAME is reconnecting…" once. Image chats keep their own offline note, and Android has no supporting-folders confirmation to preserve. Verified on an API 37 emulator (OutboxJourneyTest.newChatStartedOffline: both lines with the computer's name, the dots advancing with animations on and still with them off); not on a physical phone or an expanded layout.

### Every prompt bubble is reachable by VoiceOver (#2547)

A prompt bubble on screen is always in the accessibility tree, as one "You: ..." element. Nightly run 43282129948 shows a drawn "You: a long run please" bubble with a 69-point gap in the tree where it sits, while its neighbours were exposed; #2547 saw the same for the first prompt. A text-only prompt is now a single leaf element, a prompt with photos keeps its buttons as children. Status: implemented. In run 43358403309 the native iOS journey (`testQueueForkAutomationsAndUsageFromThePhone`) got past the fork step that failed on main; the run then lost the app to the simulator before the accessibility audit, so a full green journey is still to come.
