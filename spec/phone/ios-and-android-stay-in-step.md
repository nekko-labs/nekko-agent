---
title: "iOS and Android stay in step (2026-11-02)"
area: phone
---

# iOS and Android stay in step (2026-11-02)

Philip asked (2026-11-02) that the two phone apps do the same things, for what exists today and for everything new, and look like the same product while each feels at home on its own phone. Why this and not iOS first, Android later: [decision 0061](../../docs/decisions/0061-ios-and-android-stay-in-step.md).

## The rule

1. **Same features.** A feature on one app belongs on the other, existing or new. Someone who changes phones should lose nothing.
2. **Only a true OS exclusive stays on one app.** If the other OS has an equivalent, build that, the way Apple Pay on iPhone maps to Samsung Pay or Google Pay on Android. A feature stays one-sided only when the other OS has nothing that can do the job, and this file says so.
3. **Native manners, one look.** Each app follows its own platform's design guidance (Apple's Human Interface Guidelines, Material on Android) for navigation, controls, sheets, type and motion. The Nekko themes, mascot, wording and the order of what a screen shows stay the same, so the two read as one product.
4. **A gap is written down.** When one app gets a feature first, the same PR files a GitHub issue for the other app and adds a row to the gaps table below. Removing the row is part of closing the gap.

## Acceptance

- A PR that adds or changes a phone feature either changes both apps or records the gap as rule 4 says.
- A feature's spec file says what each app does, naming the counterpart where the OS feature differs.
- Shared behaviour keeps sharing its test data (the golden files under `crates/` and the fixtures both apps already read), so the apps cannot drift unnoticed.

## Counterparts in the apps today

| Job | iPhone | Android |
| --- | --- | --- |
| A running chat on the Lock Screen | Live Activity | Live Update (Android 16) |
| Counts at a glance | Home Screen and Lock Screen widgets | Home Screen widget |
| One-tap status | Control Center control | Quick Settings tile |
| Open a new chat from the icon | Home Screen quick action | Launcher shortcut |
| Send text from another app | Share extension | Share target |
| Find computers nearby | Bonjour (`NWBrowser`) | Network Service Discovery (`NsdManager`) |
| Device-held signing key | Secure Enclave | Android Keystore |
| Dictation fallback on the phone | Apple's speech recognizer | Android's speech recognizer |
| Stay connected in the background | Background time and grace | Keep-alive foreground service |

## Android is behind the iPhone today

Found by comparing the two codebases on 2026-11-02, not a full audit: a gap missing here may still exist.

| Feature | Android side | Tracked by |
| --- | --- | --- |
| Apple Watch glance | No Wear OS app | needs an issue |
| Push notifications | No push; the keep-alive service covers an open connection | AN-6 |
| Nekko Cloud machines | No Cloud screens (the iPhone's `CloudViews.swift`) | needs an issue |
| Plan sheet on the composer | Missing (the iPhone's `PlanSheet.swift`) | needs an issue |
| Voice mode | Dictation only (the iPhone's `VoiceRunner.swift` does more) | needs an issue |
| Spooky seasonal icon | Missing; Android can swap launcher icons with an activity alias | needs an issue |
| Languages and theme presets | In progress | T201a |
| Background grace period | The keep-alive service holds the socket instead | AN-28 |

A full feature-by-feature audit, including anything Android has that the iPhone lacks, also needs an issue.

Nothing is recorded as a true OS exclusive yet.
