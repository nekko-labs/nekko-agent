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
