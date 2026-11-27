---
title: "Cloud models on the phone are a beta setting (2026-11-27)"
area: phone
---

# Cloud models on the phone are a beta setting (2026-11-27)

Issue: [#3606](https://github.com/nekko-labs/nekko-agent/issues/3606). Decision: [0126](../../docs/decisions/0126-cloud-models-on-the-phone-are-a-beta-setting.md). The feature itself: [iPhone](iphone-chats-on-this-iphone-and-group-by-computer.md), [Android](android-direct-cloud-chats.md).

## User intent

Philip asked for chats straight from the phone to a cloud provider, and the **Models** page that connects those providers, to be on iOS as a beta feature with its setting off by default, and on Android too.

## Behavior

- **Settings → Beta → Cloud models on This iPhone** (iPad: *This iPad*; Android: *This phone*), with the line *Chat with a cloud provider on your own key, with no computer. Turning it off keeps your keys and chats.* Saved on the phone only.
- **First value:** off for a new install. A phone that already has a provider (on or off) or a chat starts on and keeps it on (`PhoneProviders.betaOn`, the same rule on both phones). After that, only the switch changes it.
- **Off hides:** This iPhone / This phone in the chat list, its filter and the pill; Run on's This iPhone / This phone; New chat starting on the phone; the phone model picker; Settings → Models on This phone; the phone's tone in Customize (Android); the phone's chats in the Lock Screen card's counts (iPhone). A list filtered to the phone falls back to every place.
- **Off also:** stops a reply that is coming in (its text so far stays, marked *Stopped.*), and the store refuses new chats, sends and retries while off, so nothing reaches a provider from a hidden screen.
- **Off keeps:** providers, keys and chats. Turning it on shows them as they were.
- **iPhone with no computer:** only the welcome screen shows and it has no Settings, so its link reads *Or try a model provider on this iPhone (beta)* while off; tapping it turns the beta on and opens the Models page. Once on, the link reads as before.
- **Android with no computer:** the Chats screen and Settings are reachable, so the switch is the way in; the *This phone* button above the list shows only while on (now localized, it was hard-coded English).
- Strings are in all seven app languages on both phones.

## Acceptance

- A fresh install on either phone shows no This phone anywhere and no Models on This phone; Settings → Beta shows the switch off.
- An update over an install with a phone provider or chat shows everything as before, with the switch on.
- Turning the switch off during a streamed reply stops it and hides the place; turning it on restores providers and chats.

## Privacy and security

Nothing new is stored beyond one boolean per phone (UserDefaults `phoneCloudBeta` on the iPhone, `nekko_phone` prefs `phoneCloudBeta` on Android); nothing is sent. Turning it off does not delete keys: use a provider's Remove, or Forget everything, for that.

## Status

`[implemented 2026-11-27 on both phones; not built or run in the authoring container (no Swift toolchain, Gradle could not be downloaded): NekkoKit tests (PhoneCloudBetaTests), the Android protocol test (PhoneProvidersTest.betaIsOff…) and JVM test (PhoneCloudBetaTest), and the iPhone UI test (PhoneDirectCloudTests.testBetaOffWelcomeLinkTurnsItOn) wait on CI; no screenshots yet]`
