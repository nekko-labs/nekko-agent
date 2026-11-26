---
title: "iPhone: Settings with your Nekko Cloud profile first, Computers second (2026-11-17)"
area: phone
---

# iPhone: Settings with your Nekko Cloud profile first, Computers second

Issue: [#2929](https://github.com/nekko-labs/nekko-agent/issues/2929). `[implemented 2026-11-17 on the iPhone, native-unverified: no Mac was available to build or screenshot it]`

## User intent

Philip (2026-11-17, from app 0.10.1005): reorganise Settings like Apple's own Settings. Your Nekko Cloud account is its own section at the very top, like the Apple Account row (iCloud inside it). Computers come second. The screen moves to the quiet design. Computers and the providers on this iPhone show as avatar rows that open for more detail, each list with a simple plus.

## What the user sees

- **Profile**: an avatar (your initial, or the cat when signed out), your email and one line (plan and sync state, such as "Pro · Up to date"; signed out, an invitation to sign in). A tap opens Nekko Cloud: sign-in, sync, synced chats, devices.
- **Computers** (second): each paired computer is an avatar row (its icon, a dot for whether it can be reached, its name, "Online · Internet relay") that opens its page. **Add a computer** (plus) starts pairing. **Open at launch** shows when there is more than one computer. **Manage computers** opens the list with Nekko Cloud's computers, rename and forget.
- **Models on This iPhone**: each provider is an avatar row that opens its page; **Add a provider** (plus) opens the provider buttons ([#2931](iphone-provider-buttons-and-anthropic-choice.md)).
- Then Connectors and Connection, and the rest of Settings in its old order.
- The screen is a plain list: no grouped cards or rules, 20-point gaps between groups, groups told apart by their label.

## Status

Unverified on a device: the build, Dynamic Type, VoiceOver, light and dark. Not moved yet: the inner pages (Computers list, Cloud, Customize) keep their older grouped style. The Computers list keeps its older rows. Screenshots need `node scripts/ios-evidence-local.mjs` on a Mac. Android: [#2940](https://github.com/nekko-labs/nekko-agent/issues/2940).

## Android (#2940)

`[implemented 2026-11-26 on Android, without the profile; JVM tests and lint pass; not yet seen on an emulator or a phone]`

- **Computers** opens Settings: each paired computer as an avatar row (its icon, a dot for whether it can be reached, its name, "Online · Internet relay") opening its page, **Add a computer** (plus) for pairing, and **Manage computers** for the list. Open at launch stays under New chats, where Android already had it.
- **Models on This phone** comes second: each of the phone's providers as an avatar row with its mark (off and failing ones say so), and **Add a provider** (plus). Both open the phone's providers; Add opens the add form straight away. Android has no page per provider yet.
- The whole screen is quiet: cards become plain groups told apart by their label; a card with its own warning border stays a card.
- **Not yet: the profile row.** Android has no Nekko Cloud sign-in ([#2835](https://github.com/nekko-labs/nekko-agent/issues/2835)); the row goes on top once it does.
