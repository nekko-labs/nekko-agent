# Voice and phone image-chat readiness

Tracking: [#2162](https://github.com/nekko-labs/nekko-agent/issues/2162). Scope confirmed: both voice across platforms and the four quoted phone image-chat gaps. This is a source audit and implementation checkpoint, **not an all-platform functional certification**.

## Findings and implementation

| Surface | Finding | Status in this change |
| --- | --- | --- |
| Desktop / Local Web UI voice | Pending transcription could execute a command after abort; lock during microphone startup also needs to invalidate the startup | Generation-fenced transcripts, commands, pending actions and startup; normal stop still flushes its tail |
| Shared browser capture | Audio-node setup failure could leave the acquired microphone track alive | Cleanup covers partial initialization and tolerates individual cleanup failures |
| Settings microphone test | Late startup after unmount or a second click could retain a live capture | Generation-owned startup and teardown, including voice-off |
| Android dictation | Repeated tap during host-status lookup could start overlapping jobs; cancelled jobs could update a newer run | Synchronous job reservation, coroutine cancellation and generation checks around suspended work and callbacks |
| Android privacy lifecycle | LockGate keeps the chat composed, so disposal was not enough to stop dictation | Cancel on ON_STOP, app lock and disposal; discard stale permission callbacks |
| iOS host transcription | 60-second deadline and blind retry conflicted with host single-flight inference | 300-second deadline; one request, propagate cancellation, retain offline-only fallback |
| Android host transcription | 150-second deadline left no transport margin after cold start + inference | 300 seconds, matching iOS |

The host allows up to 105 seconds to start Whisper (150 health checks, each allowing 500 ms plus 200 ms sleep) and 120 seconds for inference (`crates/nekkod/src/voice.rs`). A client deadline does not cancel host computation; no fix here claims otherwise. An action already invoked before an abort cannot be undone.

## Remaining feature gaps

### Android voice parity

[#2110](https://github.com/nekko-labs/nekko-agent/issues/2110) remains open: Android records one clip per tap and inserts text into the draft. It does not yet implement iOS's hands-free send / wait / spoken reply / listen-again loop, or desktop-style always-on command segmentation. Desktop and Local Web UI support dictation and addressed commands, not a conversational TTS loop. These differences prevent an honest claim of full feature parity.

### Phone image chats

All four quoted Android gaps are confirmed:

1. `NewChatScreen.kt` and `Outbox.kt` create ordinary sessions. The daemon's `session:create` route accepts a workspace argument, not a chat-kind/params object. Desktop uses `session:setOptions` after creation; extending the create API is not required merely to select a kind.
2. Android `Session` decodes `chatType`, but no `imageParams` model exists in `Wire.kt`.
3. No explicit phone host capability for image generation is available.
4. Android `SessionSummary` drops list-level `chatType`; the store already emits it. A badge additionally needs a UI change and matching evidence.

The iOS protocol similarly decodes session-level `chatType` without a complete image-chat creation/send flow. Both phone implementations must be updated together.

**Additional permission boundary:** `crates/nekko-remote/src/phone-access.json` does not allow `chat:generateImage` or `engine:models`. Adding a picker or passing `chatType` through `chat:send` is not sufficient. Full support needs an explicitly reviewed phone permission change, request validation and proof classification, capability discovery that distinguishes supported from installed/ready, image-only model selection, correct image-turn routing, response display and offline/outbox behavior. The existing image flow is `chat:generateImage` with `{sessionId, prompt, params}`; `image:fetch` remains explicitly denied to phones. Do not open arbitrary image/file access to implement this.

Before widening phone permissions, obtain the project-required approval. Proposed boundary: paired phones may list eligible image models and generate into their own authorized chats, subject to the existing phone Change proof; no model/runtime install, removal, arbitrary file reads or new cloud upload rights.

## Verification

- Baseline desktop suite: 216 tests passed; mocked reproductions demonstrated post-lock send and an initialization-failure track leak.
- Changed desktop code: **248 tests across seven suites passed** using the normal worktree config after `npm run build:core`; desktop TypeScript check passed. Covers capture, commands, segment ordering, actions, engine selection, local dictation and Settings microphone ownership.
- Android: startup, stale callback/result, stop-and-transcribe and lifecycle regression tests added; native compilation/tests pending CI.
- iOS: one-request, no-online-fallback, cancellation and deadline regression cases added; native compilation/tests pending CI.
- No visual redesign. These changes alter microphone ownership/cancellation behavior, not control layout or styling. Unit tests do not prove physical-device lifecycle behavior.
- No real microphone, speaker, Bluetooth, route-change, interruption or OS-lock test performed in this checkpoint.
- Local host is Windows. Android SDK access was denied by the workspace sandbox; no alternate access was attempted. Swift/Xcode is unavailable locally. Use the existing Android/iOS hosted workflows for compilation and simulator tests; physical-device audio still needs hardware.
- Folded, unfolded and tabletop/posture transitions remain part of required Android hardware follow-up, not claimed as verified.

## Acceptance before claiming fully functional

1. Pass focused native regression tests and platform builds.
2. Complete Android #2110 parity with explicit start/stop, interruption safety, local playback and no accidental sends.
3. Approve and implement the phone image permission boundary, then both clients' capability/model selection, parameters, send path, badges and recoverable failure states.
4. Capture and inspect matching native evidence for new UI, including narrow and foldable layouts.
5. Exercise actual microphone/playback and permission denial/recovery on Windows, macOS, Linux, secure-context Local Web UI, iOS and Android, including Bluetooth, calls, lock/background and reconnection. Record precise supported OS/runtime versions and any limitations.
