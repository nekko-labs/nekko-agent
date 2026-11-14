# Nekko Agent for iOS

Native SwiftUI iPhone and iPad app, independent of JavaScript and Expo. The former
Expo app has been removed. Android lives separately in `apps/android`.

## Current scope and status

The app pairs with your computer over the end-to-end encrypted relay and supports
streamed chats, approvals, questions, queue/stop, model selection, photos and
dictation. Native surfaces include Live Activities, notifications, widgets,
Shortcuts and a share extension. Pairing material is stored in Keychain and app
lock protects access.

The app is in limited TestFlight beta, not a public App Store release. For precise
implemented, planned and unverified capabilities, security boundaries and device
verification limitations, see the [native iOS specification](../../spec/phone/native-ios-app.md).
Removing Expo does not claim full native parity or complete outstanding device tests.

## Direct cloud text chats (no computer)

Use **Settings → Models on this iPhone → Add a provider**, or choose **This iPhone** in New chat’s Run on menu and add a provider from its model picker. Bring your own provider API key; subscriptions are not API credentials. Direct chats have no tools, photos or sync. See the [setup and troubleshooting guide](docs/direct-cloud-chat.md).

## Build and verification

Use macOS with Xcode, the iOS SDK and XcodeGen. See `project.yml`, `scripts/`,
`.github/workflows/ios-native.yml` and `.github/workflows/ios-testflight.yml` for
the current build, tests and signed distribution procedures.

```sh
cd apps/ios/Protocol
swift test
cd ..
xcodegen generate
xcodebuild -project NekkoNative.xcodeproj -scheme NekkoNative \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath DerivedData CODE_SIGNING_ALLOWED=NO build
```

Native protocol, app and UI checks remain in the Native iOS workflow. A headless
protocol check does not establish physical-device, APNs delivery or store readiness.

## Failed native test diagnostics

The existing `native-ios-evidence-<shard>` workflow artifact includes
`diagnostics/<result-name>/summary.json` and Xcode's diagnostic export for failed
or unreadable results, including a failed first attempt when its retry passes.
Clean passing results and Xcode’s host-wide `simctl_diagnostics` archive are
excluded. Raw staging stays outside upload paths and is removed. `export-error.txt` records an export problem
without masking the test verdict. These are CI fixture logs; review their content
before copying them into an issue or publishing media. To collect from isolated
local results: `node scripts/ios-failure-diagnostics.mjs <results-directory>`.
The collection adds no retry and does not establish that #831/#1048 are fixed.

## Simulator Keychain tests (#1096)

Runtime tests need ad-hoc signing, unlike the build-only command above. On an
isolated iPhone 17 Pro / iOS 26.5 simulator with Xcode 27.2,
`CODE_SIGNING_ALLOWED=NO` makes `SecItemUpdate`, `SecItemAdd` and
`SecItemCopyMatching` all return **-34018 (`errSecMissingEntitlement`)**; the
original save/overwrite assertions read `nil`. With identical code and assertions,
ad-hoc signing passes. No plaintext fallback or weaker Keychain attributes are
needed. `KeychainStoreTests.testSecurityFrameworkAccess` reports actual status
codes using a disposable item, never stored credentials.

From the repository root, after `xcodegen generate --spec apps/ios/project.yml`,
use a disposable simulator:

```sh
xcodebuild -project apps/ios/NekkoNative.xcodeproj -scheme NekkoNative \
  -destination 'platform=iOS Simulator,id=YOUR_DISPOSABLE_SIMULATOR_UDID' \
  -derivedDataPath /tmp/nekko-keychain-signed \
  -parallel-testing-enabled NO \
  -only-testing:NekkoNativeTests/KeychainStoreTests \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY="-" DEVELOPMENT_TEAM="" test
```

An unsigned negative control uses a different derived-data path and
`CODE_SIGNING_ALLOWED=NO`; it is expected to fail, not a supported runtime test
mode. An unsigned build can compile but does not prove Keychain access. This
comparison does not verify hardware, distribution signing, managed relay
availability or independent live-journey reliability.

## Local image chats (#2162)

Implemented in source (native verification still pending):

- New chat has **Chat / Image** controls. Image settings list only explicit image-capable local models from the selected paired computer's read-only `engine:models` projection. Discovery requires `app:info.capabilities.imageGeneration == true`; older hosts explain the update/reconnect requirement instead of guessing support. No install, remove, filesystem or cloud-model rights are added.
- Creation uses `session:create` with the existing optional workspace argument, then `session:setOptions(sessionId, {chatType: 'image', imageParams: {modelId, width, height, steps, cfgScale, seed}})`. A verified image-settings response is required before opening/sending the first prompt. The host remains responsible for runtime readiness and model/backend compatibility. Existing Change proofs accept integer numbers only, so iOS offers whole-number CFG (default 4); fractional desktop settings are retained but must explicitly be changed before phone generation. Extending cross-platform fractional-number proofs is not part of this change.
- Image turns use `chat:generateImage({sessionId, prompt, params})` through the existing **Change** registration/proof flow. They never use `chat:send` or the text outbox. Text prompts only: photos and skills are rejected; voice-conversation sending is unavailable in this mode. Image kind, parameters and first prompt remain durable in drafts/cached transcripts. Offline generation is explicitly disallowed, with no automatic retry of ambiguous turns.
- A send is reserved before model discovery. Stop fences pending discovery/Change authorization as well as requesting host abort, so late authorization cannot dispatch a cancelled image. Host error events fail the send even when its RPC returns null, keeping the prompt for retry. Live `image_status` events mark the chat busy. Reopening can recover positive busy state from the authorized, capped `monitor:summary` view; absence there cannot prove a turn ended. Raw `chat:running` is computer-only and is never called by the phone.
- Image chat summaries have an Image badge. Existing and generated assistant attachments render through the existing transcript thumbnail / `session:photo` viewer. No `image:fetch` or general file access is used. Attachment-only assistant messages are retained.

Focused tests: `cd apps/ios/Protocol && swift test --filter ImageChat`. Routing regressions include `ChatModelTests`, offline, photo preview, outbox, Change proof, and saved transcript/list tests. Native synthetic fixture: launch Debug with `-uiTestNewChat -uiTestImageChat`; `ImageChatEvidenceTests` captures controls, model/parameter selection, a signed synthetic generation, the existing photo viewer, and older-host refusal. The fixture uses in-memory stores and synthetic original artwork, never real generation or hardware authorization.

Evidence handoff: baseline source is `defd6001524a0419dbc404cec909f7cf95aa121a`. Unchanged `NewChatChoicesTests/testPermissionChoiceEvidence` capture was dispatched using `native-mode-evidence.yml` in [run 42424647941](https://github.com/nekko-labs/nekko-agent/actions/runs/42424647941). The workflow completed successfully. Both source refs are deliberately the original baseline; this is **not after evidence**. Parent owns final source publication and native workflow: use `ios_test_file=apps/ios/UITests/ImageChatEvidenceTests.swift`, `ios_only_testing=NekkoNativeUITests/ImageChatEvidenceTests`, and a source ref containing these iOS changes. The new image-specific controls have no pre-implementation state. Also run the existing baseline new-chat test against the final ref for a matched changed-surface comparison.

Checks performed in this Windows workspace: after integration through `35fb0a6e6`, the original full package suite passed (730 XCTest, 5 live-relay skips, zero failures; plus 21 Swift Testing). The earlier host-policy parity failures are resolved by the integrated host policy. Review reproduced four concrete lifecycle/running-state bugs, added eight regression/golden tests, and fixed them only within iOS. Final full package suite: **738 XCTest, 5 live-relay skips, zero failures; plus 21 Swift Testing passed**. The new golden test consumes Rust's actual `phone-image.json` model output and valid requests, checking canonical and serialized integer payloads. No tests or host allow-lists were weakened. See ignored local `evidence/image-chat-verification/REVIEW.md`, `review-repro.log`, `review-running-repro.log` and `review-full-verified.log`. Linux checks used the existing Docker harness with Swift 6.1 in a disposable copy, a test-only `String(localized:)` shim and `PreviewLoader.withThumbnailSlot<T: Sendable>` constraint because those existing sources do not compile directly on Linux. Those shims are not product edits or Apple-native verification. Earlier App/UITests frontend parsing is not native type checking. Original-baseline screenshots, manifest, revisions and xcresult are in ignored `apps/ios/evidence/image-chat-baseline-2162/`; their metadata was previously inspected, not their images. This review captured no native screenshots.

Unverified: final Xcode build/type checking, iPhone/iPad native visual inspection and interaction, real paired-host runtime/model generation, hardware Face ID/passcode, and device reconnect during an active generation. Parent must update canonical `spec/phone/native-ios-app.md` / issue #2162 integration notes outside this iOS-only write scope.
