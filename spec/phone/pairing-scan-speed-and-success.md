---
title: "Pairing: a code phones read quickly, and a celebration when it works"
area: phone
---

# Pairing: a code phones read quickly, and a celebration when it works

`[implemented 2026-11-08; desktop unit-tested; iOS and Android build and test only in macOS / Android CI; not yet tried on a device]`

## User intent

The owner reported that the phone's *Pair a computer* scanner "does not pick up very fast", and asked that a successful scan and connection show "a fun animation and success illustration". iPad rotation was reported in the same breath; it was already fixed on `main` (camera preview follows the rotation, see [native-ios-app.md](native-ios-app.md), *Smaller fixes*).

## Why scanning was slow

The pairing link carries the relay, room, key, the computer's 88-character host key, the one-time code and up to four LAN routes: about 230-300 characters, a version 9-12 QR code (53-65 modules a side). The desktop drew it as a 220 px PNG and showed it at 132 px, so each module was about 2 CSS px (under half a millimetre on a laptop), with blurred edges from the downscale. Phones had to come so close that the main camera of a recent iPhone (nearest focus about 20 cm) could not focus.

## What changed

- **Desktop** (`RemoteAccess.tsx`, `pairingQr`): the code is an SVG (crisp at any zoom or display scale), shown at 232 px, with low error correction (a screen is never smudged, so fewer, larger modules) and a two-module white margin that keeps a quiet zone in the dark theme. Each module is now at least 3.5 CSS px for a realistic link, checked by `RemoteAccess.pairingQr.test.tsx`. The link format is unchanged.
- **iPhone / iPad scanner** (`PairView.swift`): codes are delivered on their own queue instead of the main queue, which was busy laying out the list around the preview; any pairing code in view counts, not only the first code found; and when the camera cannot focus close enough, it zooms (`PairScanZoom`: enough that a 4 cm code fills half the frame at the nearest focus, at most 2x, never past the format's maximum; iPads and older iPhones stay at 1x). This is Apple's AVCamBarcode approach.
- **Android scanner**: unchanged. It is the Google code scanner with auto-zoom; the larger desktop code helps it the same way.

## The celebration

Right after a pairing succeeds (from the scanner, a pasted link or a confirmed deep link, first pairing or a re-pair), both phones show the same full-screen moment over whatever is underneath:

- the computer and the phone as two tiles, a dotted line drawing between them in the accent colour;
- the pixel cat popping onto the line, happy, with a green check badge, hopping gently;
- one burst of confetti in the theme's accent, success, warning, running and danger colours (fixed seed, the same burst every time, gone in about three seconds);
- *You're connected!* and *<computer name> is paired. Its chats are on their way.* (*Your computer is paired…* until the computer's name arrives);
- **Let's go**.

It closes after about 3.4 seconds, on a tap anywhere, on **Let's go**, or with Back on Android. With VoiceOver (iOS) or TalkBack (Android: the recommended timeout for content with controls) it stays until **Let's go**. With Reduce Motion (iOS) or animations removed (Android), there is no confetti, hop or spring: the finished picture fades in. A success haptic plays as it opens. On the first run, step 3 (notifications) waits until it closes. While the app lock covers the app, it waits too.

Where: iOS `PairSuccessView.swift`, shown by `RootView` from `AppModel.justPaired`; Android `PairSuccess.kt`, shown by `NekkoNavHost` (`PairScreen` now reports the paired computer's id). Android gained a Compose `PixelCat`, drawn from the same 32 x 32 grid as the iPhone's.

## Acceptance

- [x] The desktop pairing QR is an SVG at 232 px with error correction L; module size test passes.
- [ ] A recent iPhone (13 Pro or later) reads the desktop code from about 20 cm within a second. (Device check outstanding.)
- [ ] iPad reads the code in landscape and portrait. (Device check outstanding.)
- [ ] The celebration shows on iPhone, iPad and Android after scanning, pasting and confirming a deep link, then the first run's step 3 follows. (UI tests updated; screenshots outstanding.)
- [ ] Reduce Motion / Remove animations shows the still version; VoiceOver / TalkBack keep it until *Let's go*.

## Privacy and security

Nothing new leaves the phone or the computer. The celebration reads only the computer's display name already stored on the phone. The link and the one-time code are unchanged.
