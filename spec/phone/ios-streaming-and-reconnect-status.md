---
title: "Steady iOS streaming replies and reconnect status"
area: phone
---

# Steady iOS streaming replies and reconnect status

## Intent

Incoming reply text on iPhone and iPad should not bounce while it is written. New chat should separate the computer's connection status from what the reader can do while waiting. Tracked in [#2474](https://github.com/nekko-labs/nekko-agent/issues/2474).

## Branch implementation, not yet native-verified

- On iOS 18+, follow measured transcript height changes after layout rather than issuing a scroll for each token revision. Reader-driven scrolling changes follow intent; a lazy end sentinel disappearing during layout does not. A reader scrolling into history cancels pending structural settling. Jump to latest restores follow mode.
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

Native compilation, geometry assertions and visual/motion inspection are pending. Source inspection identifies the pre-layout scroll path as a candidate cause, not device-level proof. Physical devices, iOS 17 and actual foldable hardware remain unverified. Android notice parity is tracked separately in [#2475](https://github.com/nekko-labs/nekko-agent/issues/2475).
