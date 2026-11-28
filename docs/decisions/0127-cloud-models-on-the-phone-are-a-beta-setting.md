---
status: accepted
date: 2026-11-27
---

# 0127. Cloud models on the phone are a beta setting, off for a new install

## Context

Decisions [0050](0050-the-iphone-runs-chats-on-its-own-cloud-providers.md) and
the Android work for [#2414](https://github.com/nekko-labs/nekko-agent/issues/2414)
made each phone a place chats run, on cloud providers whose keys it keeps. Both
apps landed it on by default: This phone in Chats and Run on, and **Models on
This phone** in Settings. Philip asked for it on both phones as a beta feature,
with its setting off by default. Spec:
[the beta setting](../../spec/phone/phone-cloud-models-beta-setting.md).

## Options considered

1. **Off for everyone, including phones that already use it.** Simplest, but a
   phone that set up a key and kept chats would open to find them gone with no
   word of why, until someone finds the switch.
2. **Off for a new install, on for a phone that already set up a provider or
   kept a chat here.** The default the request names, and nobody who used it
   loses it. Chosen.
3. **A build flag instead of a setting.** Hides it from everyone, including the
   people who want to try it; not a beta anyone can join.

## Decision

- One switch per phone: **Settings → Beta → Cloud models on This iPhone / This
  phone**, saved on that phone only, never synced or sent.
- Its first value is `betaOn(stored, hasAnything)`: the user's choice once made,
  else on only when a provider (on or off) or a chat already exists. A phone
  that resolves on saves that, so removing its last provider later does not
  hide the place.
- Off hides every way in (This phone in the chat list and its filter, Run on,
  the phone model picker, the Models page, its tone in Customize, its chats and
  the Lock Screen card's counts), stops a reply that is coming in, and refuses
  new chats and sends in the store itself, not only in the screens. Providers,
  keys and chats stay; turning it back on finds them as they were.
- The iPhone with no computer shows only its welcome screen, which has no
  Settings, so the welcome link stays, says *(beta)*, and turns the beta on when
  tapped. Android's Chats screen and Settings are there with no computer.

## Consequences

- A new user meets computer chats first; cloud models on the phone are opt-in.
- The store refusing while off means a stray intent, voice target or deep link
  cannot send while the screens are hidden.
- Leaving beta is one change: flip the default in `betaOn` (or drop the setting).
