# Voice and image-chat readiness

Tracking: [#2162](https://github.com/nekko-labs/nekko-agent/issues/2162). Updated 2026-11-08. **Implementation and verification checkpoint, not all-platform functional certification. Keep the umbrella open.**

## Delivery

- Desktop/browser voice safety [#2188](https://github.com/nekko-labs/nekko-agent/pull/2188) merged as `4cc3b1317`. Abort/lock/voice-off fence stale transcription and commands; partial capture initialization and Settings microphone ownership clean up correctly. Ordinary Stop flushes its tail. Already invoked actions cannot be undone.
- Native dictation safety [#2190](https://github.com/nekko-labs/nekko-agent/pull/2190): synchronous Android startup ownership, stale/cancelled callback fencing, lock/background cancellation; both phones allow one 300-second host request. iOS does not silently change recognizers after an online host failure. Merged as `64df66cde`; full feature-layer acceptance remains outstanding.
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
- Android command grammar and core fallback/error copy remain English; voice/image UI resource strings now cover all six additional supported locales. Speech recognition language selection does not translate command grammar. Native localized layout and linguistic review remain unverified.
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

## Latest checkpoint

Feature head `47b213eb6db2536571fded23e945db261d236423`, host head `9c41189cb`.

- Windows production desktop/web build passed; all nine isolated Local Web UI/daemon turn-variant assertions passed, including explicit refusal to generate in a text chat, image-kind selection through options, fake-runtime image output and persisted metadata/status stages.
- Android native voice interaction fixture passed on `a275c0cb9` ([run42435913917](https://github.com/nekko-labs/nekko-agent/actions/runs/42435913917)): composer entry, draft preservation, lock dismissal and voice-off controls, without send/queue side effects. This is not a physical audio test.
- [Conversation screenshot](https://github.com/nekko-labs/nekko-agent/releases/download/pr-media-6/pr-2212-after-phone-voice-conversation-ready.png) and [composer screenshot](https://github.com/nekko-labs/nekko-agent/releases/download/pr-media-6/pr-2212-after-phone-voice-composer.png) captured and published; uploader verified public bytes/URLs. **Not visually inspected**: browser screenshot timed out, native capture returned `UnknownVizError`. New conversation sheet has no before state; existing composer baseline and motion/foldable evidence remain required.
- Initial native fixture compilation failures were fixed, not skipped. Latest matched image/new-chat evidence [run42436236581](https://github.com/nekko-labs/nekko-agent/actions/runs/42436236581); final iOS native [run42435898482](https://github.com/nekko-labs/nekko-agent/actions/runs/42435898482). Mac runner queue is not a passing build.
- The permission approval and checkpoint are recorded in project memory, obsurdian commit `436b40f`.

## Current evidence diagnosis (2026-11-08)

- At `2cbb486ba`, Android app and instrumentation compiled. [Native run 42436986175](https://github.com/nekko-labs/nekko-agent/actions/runs/42436986175) executed **494 app tests, one failure** (`TranslationsTest:48`); this is not a passing native suite.
- [Matched image run 42437031397](https://github.com/nekko-labs/nekko-agent/actions/runs/42437031397) failed `imageSummaryBadge` on both revisions. Its exported semantics tree has the header and mode pill but no `chats.list`. The fixture paired without `repo.load()`, leaving the screen's `ready` guard false. Adding a recent timestamp alone did not fix this. The fixture now follows app startup and waits for readiness; row visibility/clickability and after-only badge assertions are retained.
- The same run's after-side `imageReplyAndSignedSend` crashed at `ChatScreen.kt:344`: `scrollToItem` forced measurement from the first item-layout snapshot notification. Initial positioning now uses `requestScrollToItem`, scheduling the jump for the next measure. The generated-image tile assertion now requires visibility. Native execution of these corrections is pending; no baseline classification or crash-fix verification is claimed yet.
- [Voice run 42437033586](https://github.com/nekko-labs/nekko-agent/actions/runs/42437033586) passed both Android interaction tests on both jobs. Both revision manifests identify `2cbb486ba`, so they are repeated new-surface checks, **not** a baseline comparison. Downloaded after motion is H.264, 1080x1920, 37.407944 seconds (ffprobe). This verifies media structure, not appearance or audio.
- Visual inspection remains blocked: a fresh local evidence viewer loaded the captured PNG, but the browser screenshot timed out again. Viewer/browser stopped. Required matched composer, foldable layouts, motion inspection and iOS evidence remain unfinished.
- #2211 current-head build, itests, perf, CodeQL and gate passed. It still depends on unmerged #2190; do not merge the feature layer around that dependency.

### Keyboard regression and upstream reconciliation

- Native run `42436986175` live-relay failures are at `LiveRelayTest.kt:108` (hello reply) and `:118` (subagent prompt), **not** the prior `hideKeyboard` failure. The captured semantics tree gives the transcript only 13 pixels of height at 320×640 with the IME open; persistent idle voice controls consume the composer space. Treat this as a feature regression, not #2209.
- Idle voice controls now collapse with the software keyboard; active capture controls, pending confirmations/notices and safety collectors remain. New instrumentation explicitly waits for native IME visibility, checks controls disappear and the existing reply remains displayed, dismisses the IME, then checks controls return and draft remains. Before-mode assertions retain the old controls for matched evidence; screenshot names now correctly use the recorded revision rather than always `after`.
- Upstream #2130 and #2210 merged while verification continued. Merged `origin/main` at `67f49140d` into this feature branch without conflicts; primary checkout untouched. Downloaded current translation report has exactly the 30 old missing card-detail keys fixed by #2130. Final current-head native tests are still required.
- Corrected image fixture/initial-scroll run [42437960313](https://github.com/nekko-labs/nekko-agent/actions/runs/42437960313) tests `ac4d56d18` against `defd60015`; **both Android jobs passed all four instrumented tests**, confirmed from downloaded reports/manifests. The missing-ready and initial-layout failures no longer reproduce in this matched run; captures await pixel inspection. iOS remains queued. This predates the keyboard layout correction; do not call it final-head evidence.

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

## Latest native lint and fixture checkpoint (2026-11-08)

- On `39c7d9a8b`, Android 42438407217 unit/integration checks and light/dark live-relay emulator journey passed; lint/build failed with 48 feature-owned errors. Downloaded full lint report: 45 missing localized keys, two Compose resource lookups and one audio device flag annotation. Corrections are implemented, awaiting native rerun.
- Added 270 translations (45 keys × six locales), with exact key/format argument checks and XML parse validation. Native localized layout and linguistic review are not certified.
- Matched keyboard 42438428592 ran three tests per Android revision, one failure each at line95. Revision-argument mismatch sent the baseline through after-only assertions. Corrected the argument and motion filenames and matched the fixture activity to production edge-to-edge/adjustResize. After-side behavior still requires execution.
- Merged latest #2211/main as `623803f3d`; resolved ChatController projection conflict by retaining both upstream QuestionReplies projection and positive image-running status.
- Removed artificial CFG4.5 fallback for missing Android image settings: sending now explicitly refuses until settings are saved; opening settings starts with protocol default CFG4. Existing saved fractional values remain untouched and rejected, never rounded. Added a controller regression.
- #2211 reconciled head `504aa315d` now fails one desktop Settings Customize test (About you unexpectedly also in General); 4406 tests passed. Matching-base reproduction on main cf9779145 confirmed the identical failure (1 passed/1 failed); tracked as #2218. No test weakened and no gate bypassed. Host integration/performance passed. #2212 stays draft and #2162 stays open.
- iOS native/evidence jobs remain queued on xcode-27. Existing screenshots/videos remain captured but not pixel/motion-inspected.

- Corrected local batch: **144 SDK-free JVM tests passed**, **16 harness/resource checks passed**, 12 translated XML files parsed; spec-index and whitespace checks passed. These do not replace native lint, UI, motion or audio verification.

## Verified interaction checkpoint at 8a3c51b15

- Matched voice/keyboard run42439886975: 3 Android tests passed on each revision; app base ac4d56d18, after/harness 8a3c51b15. After-side IME hiding, draft/reply visibility and keyboard dismissal assertions now pass.
- Matched image run42439942876: 4 Android tests passed on each revision; app base defd60015, after/harness 8a3c51b15. Downloaded revision manifests and instrumentation logs inspected.
- Native Android42439884618: live-relay emulator and live-update jobs passed. All 48 previously diagnosed lint errors cleared; lint now reports one error in upstream ComposerPhotosTest (StateFlow.value inside composition). The fixture now collects its state; no production surface changes. Native rerun is still required.
- Published 18 new native stills/recordings to PR2212 via pr-media-6; uploader checked downloaded SHA256 and public URL bytes, then PR readback. Browser screenshot again timed out and native capture returned UnknownVizError; media is captured/published but NOT pixel/motion-inspected. Isolated read-only viewer/browser stopped.
- PR2212 CI42439865845 fails exactly the Settings Customize baseline assertion tracked by #2218 (462 other files passed; integration job passed). No assertion disabled, no blind rerun or gate bypass. iOS build42439944654/new image surfaces42439964686 remain queued; repository runner inventory returned zero self-hosted runners, which does not establish availability of organization/hosted capacity.

## Landed host dependency and main refresh (2026-11-08)

- #2211 merged normally at b3f17e57eb5bba35eec69261353faeb2f0ac322b after new-head build, integration, performance, gate and CodeQL analysis passed. #2218 is fixed upstream.
- Merged main into the UI branch without conflicts as ff97e5f801a3dda5bfeae9f3c9dbb11af02bd296. Settings Customize unchanged suite passes 2/2; 16 resource/harness checks, shared build, spec-index and whitespace checks pass.
- Android tree is unchanged from c12df243e: inspected native run42440610346 passed 502 app +436 protocol tests, zero failures/skips, lint0 errors/105 warnings/4 hints, relay/security/Live Update checks.
- iOS now includes upstream first-prompt intro, pairing rotation and pane interaction changes, including an automatic merge in NewChatView. Earlier8a3 iOS run42439944654 is no longer final-head proof; fresh native verification is required. No visual inspection or hardware certification is claimed. #2212 remains draft and #2162 open.
