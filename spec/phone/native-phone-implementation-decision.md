---
title: "Native phone implementation decision (2026-10-07)"
area: phone
split-from: SPEC.md (2026-10-22)
---

# Native phone implementation decision (2026-10-07)

**Target:** actual platform-specific apps: SwiftUI on iOS first, Kotlin/Jetpack Compose on Android second. The Expo/React Native app has been retired and removed, including its dedicated CI. Native parity is no longer a prerequisite for retaining the old implementation. Native feature gaps remain explicitly tracked, not implicitly solved by this removal. The pocket-app behavior below remains the acceptance target, not a claim that the new SwiftUI app already supports it.

`[superseded 2026-10-16 by "Native iOS app" below: the direct-HTTPS reader was replaced by the relay client]` **Foundation implemented; simulator verification passed:** macOS CI passed five Foundation tests, a simulator build, two Keychain/host-binding tests and a first-run UI test with ad hoc signing. Full-height light/dark simulator captures were inspected. Live authenticated-host and physical-device acceptance remain unverified.  apps/ios contains a SwiftUI read-only host client and a Foundation protocol/test package, XcodeGen app definition and macOS build/test workflow. The user explicitly connects to a user-configured HTTPS origin using a host bearer; system TLS trust and redirect rejection prevent silent insecure routing. Bearer is saved only in device-only Keychain, bound to its origin; no automatic connection on launch, no provider settings/API-key fetch or persistence. Disconnect clears in-memory connection/chat state; Forget also removes the saved bearer and origin. This limited direct-host development path does not implement or replace the end-to-end encrypted relay boundary. Sending, pairing, notifications and phone inference are unavailable and labeled as such.

**Acceptance/release gates:** real authenticated-host integration, native iPad screenshots, VoiceOver/Dynamic Type/lifecycle tests and physical-device testing remain required. This Windows implementation is not marked shipped. Then implement relay crypto parity and pairing/revocation, streaming/reconciliation and exact approvals/questions before enabling send, and finally offline Metal inference and signed TestFlight distribution. Android follows using the same fixture-backed wire, not a web wrapper. See TASKS.md for ordered tasks and credential/device dependencies.
