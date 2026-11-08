# Voice and image-chat readiness

Tracking: [#2162](https://github.com/nekko-labs/nekko-agent/issues/2162). Updated 2026-11-08. **Implementation and verification checkpoint, not all-platform functional certification. Keep the umbrella open.**

## Delivery

- Desktop/browser voice safety [#2188](https://github.com/nekko-labs/nekko-agent/pull/2188) merged as `4cc3b1317`. Abort/lock/voice-off fence stale transcription and commands; partial capture initialization and Settings microphone ownership clean up correctly. Ordinary Stop flushes its tail. Already invoked actions cannot be undone.
- Native dictation safety [#2190](https://github.com/nekko-labs/nekko-agent/pull/2190): synchronous Android startup ownership, stale/cancelled callback fencing, lock/background cancellation; both phones allow one 300-second host request. iOS does not silently change recognizers after an online host failure. Pending landing and full native checks.
- Approved image host boundary [#2211](https://github.com/nekko-labs/nekko-agent/pull/2211): image-only safe model listing, support capability, exact bounded payloads, signed Change proof, existing image session/model preflight and transcript-scoped generated-photo retrieval. No installation/removal, arbitrary file/image access or new cloud-upload authority. See [image-chats](../spec/phone/image-chats.md).
- Native feature layer [#2212](https://github.com/nekko-labs/nekko-agent/pull/2212): Android hands-free, hold-to-talk and addressed commands; Android/iOS image kind/model/parameter selection, signed generation, badges, attachment-only replies and photo viewing. Offline image requests never enter the text outbox. See [Android voice](../spec/phone/android-hands-free-voice.md).

The host Whisper cold-start budget is up to 105 seconds plus 120 seconds inference. Client cancellation stops local waiting; it does not claim to cancel host computation.

## Platform matrix - what has actually been checked

| Platform/surface | Implemented | Verified evidence | Not yet established |
|---|---|---|---|
| Windows desktop | Existing image chats; hardened dictation/commands | 248 renderer tests, TypeScript check, merged safety CI; Windows production web/desktop build | Real microphone, speakers, device routing, lock; real GPU image inference in this task |
| macOS desktop | Shared desktop changes | Shared code tests only | Native build/runtime and physical audio on this platform |
| Linux desktop | Shared desktop changes | Shared code tests only | Native audio/runtime/permissions and physical audio |
| Secure-context Local Web UI | Shared browser capture/command safety; existing image UI | Shared capture/action tests; 9 isolated Windows Local Web UI/daemon integration checks including image generation using fake sd-server | Browser microphone permission/device matrix; real host image generation |
| iOS | Existing conversation voice; safer host dictation; new image flows | Full Linux-shim package suite: 738 XCTest (5 expected skips) + 21 Swift Testing; macOS package and live relay checks passed on 35fb0a6e6 | Final Xcode/SwiftUI build, new UI evidence, paired-host generation, physical microphone/TTS/Bluetooth/interruptions |
| Android | Legacy dictation plus new conversation/commands/hold; new image flows | 143 SDK-free JVM tests including controller correlation, live authority and image regressions | Compose app compiled on 35fb0a6e6; 486 app tests ran (only proven baseline translations fail). Final emulator interactions/evidence, real on-device STT/offline TTS, Bluetooth, lock/interruptions and foldable posture tests |
| Rust host / phone boundary | Approved local image protocol and authorization | 114 TS phone tests; 129 focused Rust phone tests; 4 image API tests; 2 app-info tests; fake-runtime generation/cancel/photo | Live paired relay generation with a real installed diffusion model/GPU |

Counts overlap: the separate 65 Android image tests and 51 initial voice core tests are included in the later integrated checks, not additional independent coverage.

## Explicit constraints

- Android's new modes require Android 12/API 31+ installed on-device recognition and offline TTS. No hidden online recognizer fallback. Older devices retain existing one-shot dictation; equal voice functionality on all supported Android versions is not claimed.
- Android voice commands and new fallback copy are English. Speech recognition language selection does not translate command grammar.
- Existing Change v1 signs integer numbers only. Phones default CFG to **4**, reject fractional saved CFG without rounding, and require explicit settings correction. Desktop fractional CFG (including 4.5) remains supported.
- Image capability means supported, not installed/healthy/ready. Model/runtime installation stays out of phone scope. Local GGUF diffusion only; no cloud upload or image-to-image input added.
- Image creation uses `session:create` followed by validated `session:setOptions`; a failed second call can leave an empty session, never a silently substituted text-generation request.
- Desktop/browser dictation and addressed commands are not a half-duplex conversational TTS loop. Full conversational feature parity across desktop/browser and phones is still a separate implementation gap, not certified by shared unit tests.
- Physical audio, incoming calls, Bluetooth/headset route changes, OS lock/background and foldable folded/unfolded/tabletop transitions require actual supported hardware. SDK-free/simulator tests are not substitutes.

## Native CI and evidence in flight

Feature source `35fb0a6e659641fef67c00dcd650d417184cf167`:

- [Android native build/tests](https://github.com/nekko-labs/nekko-agent/actions/runs/42433776558)
- [iOS native build/tests](https://github.com/nekko-labs/nekko-agent/actions/runs/42433778603)
- [Matched existing new-chat/image routes](https://github.com/nekko-labs/nekko-agent/actions/runs/42433820802), baseline `defd6001524a0419dbc404cec909f7cf95aa121a`
- [New iOS image surfaces](https://github.com/nekko-labs/nekko-agent/actions/runs/42433823077); both refs deliberately use the feature revision because these surfaces have no before state. Never label that run as a baseline comparison.

Required evidence is not passed until captured, inspected and linked in the PR. Android voice motion/posture evidence remains to be run. Baseline iOS screenshots exist but have not yet been inspected by the parent.

## Existing native baseline failures

- Android translations: same 30 missing entries on exact base and safety head; #2125, fix #2130.
- Android emulator keyboard-hide timeout also reproduces on main; #2209, separate experiment #2210.
- iOS onboarding/floating-pill failures: #2031 and #2157; exact-base verification pending. A cancelled native run or successful batch composer is not a passing app suite.

## Acceptance before closure

1. Pass native builds and focused/integration tests without weakening checks; prove unrelated failures against exact base.
2. Inspect matched native before/after, interaction and motion evidence, including foldable capability layouts.
3. Exercise actual paired-host signed image generation and photo retrieval with an installed model; record runtime/GPU versions.
4. Complete remaining supported-platform voice gaps and exercise actual audio permission, input/output, lock, interruption and reconnect cases on each platform.
5. Record precise tested OS/device/runtime versions, unsupported combinations and residual limitations; only then assess #2162 closure.
