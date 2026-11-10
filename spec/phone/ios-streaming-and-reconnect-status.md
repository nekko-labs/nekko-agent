---
title: "Steady iOS streaming replies and reconnect status"
area: phone
---

# Steady iOS streaming replies and reconnect status

## Intent

Incoming reply text on iPhone and iPad should not bounce while it is written. New chat should separate the computer's connection status from what the reader can do while waiting. Tracked in [#2474](https://github.com/nekko-labs/nekko-agent/issues/2474).

## Branch implementation, not yet native-verified

- On iOS 18+, follow measured transcript height changes at the scroll-content edge after layout rather than issuing a scroll for each token revision. Reader-driven scrolling changes follow intent; a lazy end sentinel disappearing during layout does not. A reader scrolling into history cancels pending structural settling. Jump to latest restores follow mode.
- Keep the existing lazy-row settling for initial transcript loads and structural changes. iOS 17 retains the prior token/sentinel fallback; this branch does not claim to fix that OS.
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
