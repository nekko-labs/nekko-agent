# Standalone native iOS foundation

> **Status (2026-10-12):** this is a read-only foundation, not the app you install. The phone app that ships today (pairing, streamed chats, approvals, on-device models) is the Expo app in [`apps/mobile`](../mobile/README.md), built and distributed through EAS. The SwiftUI port continues behind it; see the *Native phone migration* section of [TASKS.md](../../TASKS.md).

SwiftUI iOS first; a separate Kotlin Android foundation is a future step. This directory is independent of Expo `apps/mobile`: no JavaScript runtime, relay implementation, external Swift dependencies, or provider configuration screens.

## Current scope (implemented, not yet native-verified)

- SwiftUI connection form, chat list, and read-only text transcript snapshots, iOS 16+ (iPhone/iPad).
- A self-contained Foundation package at `Protocol/`, with request, decoding, filtering, timestamp, and error tests.
- Explicit user-configured **direct HTTPS host origin** and **host bearer token**. Connect is the only initial network trigger. No launch-time connection, discovery, background polling, automatic retry, or relay fallback. Opening a chat fetches it after connection; Refresh is explicit.
- Successful Connect saves one host bearer in non-synchronizing, `WhenUnlockedThisDeviceOnly` Keychain storage. Only the origin goes in UserDefaults. Token entry is cleared after connection/disconnect. A saved bearer is reused only for the same saved origin; changing hosts requires a newly entered token.
- Disconnect cancels requests and clears in-memory transcripts but keeps saved access. Forget deletes saved access and the host origin. Chat bodies are not intentionally persisted. OS process memory is not a secure erasure boundary.
- Ephemeral URLSession, no cookies or persistent HTTP cache; redirects refused; default system TLS trust. No certificate bypass, HTTP fallback, or insecure ATS exceptions. No provider/settings API calls and no provider secret persistence. Do not paste an inference-provider API key into the host-token field.

**Unsupported:** pairing/QR links, encrypted relay, push, on-device/local inference, live agent event streaming, sending/creating/deleting chats, tool approvals, question responses, resumptions, attachments rendering, reasoning rendering, model/provider selection, and Android. This is not a working inference client or a drop-in native replacement for the Expo app. Tool names/results are text snapshots, not controls. No external content, Markdown links, or image URLs are fetched by transcript rendering.

Sending is deliberately absent: the host's `chat:send` awaits an agent run and exposes progress, approvals, and errors through separate events. A lone HTTP POST with no event/approval lifecycle would falsely imply reliable send support. Implement streaming, pending input handling, cancellation, and authorization-aware tests before adding send.

## Compatible host wire contract

Sources inspected:

- `../../server/src/index.ts`: `POST /api/:channel`, JSON `{ "args": [...] }`, direct result (including `null`), HTTP 400 `{error}` on dispatcher failure.
- `../../server/src/request-security.ts`: host bearer authentication and host/origin validation.
- `../../../packages/shared/src/ipc.ts`: `sessions:summaries` and `session:get`.
- `../../../packages/shared/src/chat.ts` and `session-summary.ts`: milliseconds since Unix epoch, summaries and transcripts.
- `../../mobile/src/lib/protocol.ts`: top-level unarchived list filtering; Expo's separate relay protocol is **not** implemented here.

Requests are restricted to `sessions:summaries` with `args: []` and `session:get` with `args: [id]`. Decoding uses narrow projections and ignores additional fields. Archived, child, task, and training sessions are excluded from the list. No provider or settings endpoint is requested. HTTP failures and decoding errors are sanitized instead of displaying server error bodies.

This direct transport has **TLS protection to your host, not relay end-to-end encryption**. Use a trusted host with an authentication token: the bearer may grant broad host capabilities, although this UI is read-only. The server normally listens on HTTP; expose it through a correctly configured HTTPS reverse proxy with a publicly/system-trusted certificate and allowed-host configuration. Do not expose an unauthenticated host publicly. Only an origin such as `https://host.example.com:8443` is accepted (no embedded credentials, path prefix, query, or fragment). Redirecting origins and HTML login gateways do not work. No live host integration has been verified in this change.

## Build on macOS

Requirements: Xcode 15+ with iOS Simulator SDK, selected command-line tools, Swift 5.9+, and XcodeGen 2.38+.

```sh
# From repository root
cd apps/ios/Protocol
swift test
cd ..
brew install xcodegen
xcodegen generate
plutil -lint Info.plist
xcodebuild -project NekkoNative.xcodeproj -scheme NekkoNative \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath DerivedData CODE_SIGNING_ALLOWED=NO build
open NekkoNative.xcodeproj
```

Choose an iPhone or iPad simulator in Xcode and Run. For a physical device, select your signing team and use a unique bundle identifier as needed. The generated project and build artifacts are ignored. There is no app icon/distribution configuration yet: this is a development foundation, not an App Store-ready product.

`.github/workflows/ios-native.yml` defines macOS package tests and an unsigned simulator build. It does not execute UI/Keychain/real-host tests or supply screenshot evidence, and has not been run from this Windows worktree.

## Verification and release blockers

Local Windows checks passed: plist XML parsing, absence of an ATS override, native channel-name parity with shared IPC, and trailing-whitespace inspection of all added files. YAML syntax validation was attempted but the local `yaml` module was unavailable; XcodeGen and Actions validation remain pending. Swift tests were authored but could not be executed because Swift is not installed.

This is a **new native surface**, so there is no before screenshot. Windows has no Swift, Xcode, XcodeGen, iOS SDK, or native simulator in this environment. Native compilation, execution, Keychain behavior, interaction, and visual appearance remain unverified. Web captures would not verify this app; none are provided.

Before landing as a verified native foundation:

1. Run the macOS tests/build above (or the native workflow) and fix any compiler/runtime issues.
2. Use an isolated simulator, not a user-owned app/data profile, and a disposable HTTPS host/test token. Verify no requests before Connect, authentication rejection, null/deleted sessions, invalid JSON, trusted/untrusted TLS, and redirect rejection without forwarding the bearer. Inspect request destinations, including changing the saved host.
3. Verify Keychain save/reuse, relaunch without connecting, Forget, cancellation during Disconnect, and fetch failures. Add automated URLSession and Keychain tests; existing package tests do not prove these app behaviors.
4. Capture and inspect actual iPhone/iPad screenshots in light/dark at setup, chat list, transcript, and errors. Record navigation/loading timing; verify Dynamic Type, VoiceOver, landscape, long transcripts, and empty states. Publish native evidence in the parent PR using repository media conventions.
5. The parent owns `SPEC.md`/`TASKS.md` updates and PR/release decisions. Those files and wall code were intentionally not edited here. No commits were requested.

The source has no external package dependencies. Request payload/model tests are useful foundations, not evidence that relay, inference, send, or a native release is ready.
