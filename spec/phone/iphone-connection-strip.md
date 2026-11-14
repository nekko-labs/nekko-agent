---
title: "iPhone: the connection row replaces the connection banners (2026-11-12)"
area: phone
---

# iPhone and Android: the connection row replaces the connection banners (2026-11-12)

`[implemented 2026-11-12, iPhone only: the wording and state rules are unit tested in NekkoKit (ConnectionNotesTests); the row was built and photographed in the iPhone 17 Pro simulator (iOS 27.0) from the -uiTestConnectionStrip fixture, not yet against a real computer, a real Tailscale switch or on a device. Android: built 2026-11-14 as `ConnectionRow` (see Android below)]` Design: [reports/ios-connection-strip-design.html](../../reports/ios-connection-strip-design.html).

## User intent

Philip asked (2026-11-12): update the iPhone's message banners to the quiet design. The Tailscale one is text heavy: it needs a simple message that can expand for more detail. For connecting, a slim row at the top shows the connected computers with their connection status, so it is easy to tell what is connected, what can't connect, and when Tailscale is having trouble.

## What the user sees

- **One slim row under the Chats title**, whenever a computer is paired (hidden while the list shows only this iPhone's own chats). Each paired computer is a dot and its name, in the order of Computers:
  - online: a filled `success` dot, nothing else;
  - dialing for the first time, or waiting on Tailscale: a hollow `running` ring, nothing else;
  - switched off by the user (#2053), or not started: a hollow faint ring, nothing else;
  - a problem: a `warning` or `danger` dot and **one word**: *offline*, *no answer*, *not found*, *refused*, *key changed*, *stopped*, *quit* or *update*, with a small chevron.
- **Tailscale off** leads the row, with the crossed-out network glyph, only when Tailscale is off on this iPhone and at least one enabled computer routed over the tailnet is dialing or offline. Those computers then wait quietly (hollow ring) instead of saying a word each. When Tailscale is on but the computer is silent, the word moves to the computer (*no answer*).
- **Tap a word to open it**: the item takes a wash pill and one line opens under the row (height opens, text fades, 200 ms), in `inkSoft`, with a quieter tail in `inkFaint` (how to fix it, and *N prompts wait to send* for the active computer's outbox). Under it, the fixes as text buttons, the first in the accent: **Retry**, **Try again** (after a safety exit), **Pair again**, **Open Tailscale**, **Details** (the Connection screen, active computer only), and **⋯** with the safety exits (SK-8, active computer only). Tap again, or another word, to close or switch. A healthy item does nothing when tapped.
- **The version difference** (IO-32) is the word *update* on the active computer, opening to which side to update. In **Settings → About** it is one quiet line (*Update Studio* or *Update this app*) that opens to the sentence.
- **Files and Monitors** show only the items that have something to say, so nothing at all while every computer is fine.
- Gone: the tinted connection card, the card per unreachable computer (with Reconnect), and the tinted protocol card on the chat list.

## Rules

- Healthy says nothing beyond the dot. Full sentences live only behind a tap; the collapsed row never wraps (it scrolls sideways when the names don't fit).
- Colour: state tokens for dots and words, the accent only for the first fix. No card, border or tint behind the row or the opened line.
- VoiceOver: a problem item reads its name and word as a button ("Shows how to fix it"); a healthy one reads its name and state. The opened line and its buttons are ordinary elements. The identifiers `open-tailscale`, `banner.pair-again`, `banner.menu`, `fleet.reconnect` and `protocol-banner` are kept.

## How it works

- `ConnectionNotes.make` (NekkoKit, `ConnectionNotes.swift`) turns each computer's `ConnectionFacts` (state, detail, deny reason, route, protocol check, safety exit, outbox count) and the phone's Tailscale state into the row's items. `ComputersStore.connectionFacts` reads them from the active connection and the fleet links.
- `ConnectionStrip` (App, `ConnectionStrip.swift`) draws them and runs the fixes against the store and `AppModel`.
- Removed: `ConnectionBanner`, `FleetBanner`, `AppModel.tailnetHint` and `AppModel.offersTailscale`.

## Acceptance

- Three computers online: three dots and names, no words, nothing opens.
- Tailscale off with a tailnet computer dialing: *Tailscale off* first, that computer a hollow ring; opened, *Turn on Tailscale to reach Studio.* with **Open Tailscale** and **Details**.
- Tailscale on, computer silent: *no answer* on the computer, opening to **Retry**, **Open Tailscale**, **Details** and ⋯.
- A computer that removed this iPhone: *refused*, opening to **Pair again** only.
- Unit tests: `ConnectionNotesTests` (NekkoKit).

## Not verified yet

- Against a real paired computer, a real Tailscale off/on switch, and on a device.
- Large Dynamic Type sizes (the row scrolls sideways; the opened line wraps).

## Android (2026-11-14, #2633)

`[implemented 2026-11-14: the state-to-row mapping is unit tested (ConnectionNotesTest, JVM) and the row was photographed and driven in an Android 12 (API 32) emulator by ConnectionRowTest and ProtocolBannerTest; not yet against a real computer, a real Tailscale switch or a device]`

Same words, states and priority rules as above, as Material text rather than iOS controls:

- `ConnectionNotes.make` (`connection/ConnectionNotes.kt`) is the Kotlin twin of the iPhone's mapping; `ConnectionRow` (`ui/components/ConnectionRow.kt`) draws it under the Chats title and replaces `ConnectionBanner` and the chat list's protocol notice. Android had no separate fleet banner. Words and lines are string resources in all six languages (`strings_connection.xml`).
- The row is hidden while the list shows only this phone's own chats. It scrolls sideways; each item is a 48 dp target, the opened line animates over 200 ms.
- Differences: *Open Tailscale* opens the Tailscale app, or its Google Play page (package visibility declared in the manifest); *update* says "Update it from Google Play"; an address a phone can never reach (localhost, public `ws://`) shows as *not found* with its own sentence and **Pair again**; *Details* opens Computers; the safety exits are the active computer's ⋮ and what they did is still said under the row. Quit is now remembered like stop (`remoteQuitAt`), giving the *quit* word.
- Test hooks kept from the old banners: `open-tailscale`, `banner.pair-again`, `banner.menu`, `fleet.reconnect`; items are `strip.<computer id>`.
- Not done: Settings → About still shows the version difference as before (the iPhone's one quiet line); Files and Monitors do not show problem-only items on Android.
