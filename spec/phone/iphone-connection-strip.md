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
  - dialing for the first time: a hollow `running` ring, nothing else;
  - switched off by the user (#2053), or not started: a hollow faint ring, nothing else;
  - a problem: a `warning` or `danger` dot and **one word**: *offline*, *no answer*, *not found*, *refused*, *key changed*, *stopped*, *quit* or *update*, with a small chevron.
- **Tailscale off is the computer's own word, not a page-wide item** (#3346). Nothing about Tailscale leads the row. A computer that only Tailscale reaches (by its saved routes, or because the user chose *Tailscale* alone for it, see below) and that is dialing or offline while Tailscale is off on this iPhone says *Tailscale off* in the warning tone. Opened: *Turn on Tailscale to reach Studio.*, the quieter tail (*N prompts wait to send.* for the active computer), and **Open Tailscale** (plus **Details** and **⋯** when it is the active computer). When Tailscale is on but the computer is silent, the word is *no answer*. `[implemented 2026-11-26, iPhone: ConnectionNotesTests; photographed in the simulator from -uiTestConnectionStrip]`
- **Connect through, per computer** (#3346, iPhone; Android in step). On a computer's page (Settings, Computers, the computer), a *Connect through* group with two checkmark rows, *Tailscale* (Tailscale and local network routes) and *Nekko Cloud Relay* (internet routes), multi-select. Both on is `auto`, only Tailscale is `direct`, only Nekko Cloud Relay is `cloud`, the desktop's names for the per-device route. At least one stays on: the last one on is disabled. A kind the pairing link did not carry is disabled with one quiet line, *Pair again from Studio with Nekko Cloud Relay on to add it.* (or Tailscale). The choice is stored per computer on the phone, default `auto`, and old saves load as `auto`. The route supervisor dials only the chosen kinds (a choice that would leave nothing falls back to every saved route), and *Check routes* checks only those. Changing it reconnects that computer at once. With `direct` the computer is not "off the tailnet", so *Tailscale off* applies; with `cloud` Tailscale never matters. `[implemented 2026-11-26, iPhone: unit tested in ConnectionNotesTests and RouteStoreTests; photographed in the simulator]`
- **A route the computer refuses** (`denied: route`, #3243): the phone treats it like a failed route and moves to the next saved route of the allowed kinds. When every saved route has been refused, the computer says *refused* in the warning tone, opening to *Studio only lets this iPhone in through another route.* and *Pair again, or change it on Studio.* with **Pair again**. `[implemented 2026-11-26, iPhone: RouteTests (RelayClient) and ConnectionNotesTests; not yet against a real computer that enforces the route]`
- **A computer the phone can also reach through Nekko Cloud Relay** (or another internet relay; a saved route with a public address, decision 0116) is never blamed on Tailscale: with Tailscale off it says its own word (*offline*, or *no answer* with *Can't reach X right now.* and **Retry**), no **Open Tailscale**. A LAN route doesn't count, since it is no use away from home. On the Connection screen, *Open Tailscale to reconnect* is hidden for such a computer too. `[implemented 2026-11-25: unit tested in ConnectionNotesTests (NekkoKit) and ConnectionNotesTest (Android JVM); not yet seen on a device]`
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
- Removed: the page-wide Tailscale item (`ConnectionNote.tailscaleId`), `ConnectionBanner`, `FleetBanner`, `AppModel.tailnetHint` and `AppModel.offersTailscale`.

## Acceptance

- Three computers online: three dots and names, no words, nothing opens.
- Tailscale off with a tailnet-only computer dialing: no item leads the row; that computer says *Tailscale off*; opened, *Turn on Tailscale to reach Studio.* with **Open Tailscale** and **Details**. A second computer that Nekko Cloud Relay also reaches says its own word.
- A computer set to *Nekko Cloud Relay* only is never blamed on Tailscale; set to *Tailscale* only, with Tailscale off, it says *Tailscale off*.
- Tailscale off, computer paired over Tailscale with Nekko Cloud Relay as its fallback, offline: no *Tailscale off* item; *offline* on the computer, opening to **Retry** (and **Details** when active).
- Tailscale on, computer silent: *no answer* on the computer, opening to **Retry**, **Open Tailscale**, **Details** and ⋯.
- A computer that removed this iPhone: *refused*, opening to **Pair again** only.
- Unit tests: `ConnectionNotesTests` (NekkoKit).

## Not verified yet

- Against a real paired computer, a real Tailscale off/on switch, and on a device.
- A computer that enforces `denied: route` (only fake relays in tests so far).
- A route the computer refused is retried when the better route probes healthy again; there is no permanent memory of the refusal beyond the cooldown.
- Large Dynamic Type sizes (the row scrolls sideways; the opened line wraps).

## Android (2026-11-14, #2633)

`[implemented 2026-11-14: the state-to-row mapping is unit tested (ConnectionNotesTest, JVM) and the row was photographed and driven in an Android 12 (API 32) emulator by ConnectionRowTest and ProtocolBannerTest; not yet against a real computer, a real Tailscale switch or a device]`

Same words, states and priority rules as above, as Material text rather than iOS controls:

- `ConnectionNotes.make` (`connection/ConnectionNotes.kt`) is the Kotlin twin of the iPhone's mapping; `ConnectionRow` (`ui/components/ConnectionRow.kt`) draws it under the Chats title and replaces `ConnectionBanner` and the chat list's protocol notice. Android had no separate fleet banner. Words and lines are string resources in all six languages (`strings_connection.xml`).
- The row is hidden while the list shows only this phone's own chats. It scrolls sideways; each item is a 48 dp target, the opened line animates over 200 ms.
- Differences: *Open Tailscale* opens the Tailscale app, or its Google Play page (package visibility declared in the manifest); *update* says "Update it from Google Play"; an address a phone can never reach (localhost, public `ws://`) shows as *not found* with its own sentence and **Pair again**; *Details* opens Computers; the safety exits are the active computer's ⋮ and what they did is still said under the row. Quit is now remembered like stop (`remoteQuitAt`), giving the *quit* word.
- Test hooks kept from the old banners: `open-tailscale`, `banner.pair-again`, `banner.menu`, `fleet.reconnect`; items are `strip.<computer id>`.
- Not done: Settings → About still shows the version difference as before (the iPhone's one quiet line); Files and Monitors do not show problem-only items on Android.

### Route choice and per-computer Tailscale (#3346, Android)

`[implemented 2026-11-26: unit tested (ConnectionNotesTest, RelayClientTest, RouteSupervisorTest, ComputersRepositoryTest) and ConnectionRowTest and RouteChoiceGroupTest run in an Android 12 (API 32) emulator; not yet against a real computer on Nekko Cloud Relay]`

- Each paired computer stores a route choice, `auto | cloud | direct` (the desktop's names; old saves load as auto). `direct` dials only LAN, loopback and Tailscale routes, `cloud` only internet routes (Nekko Cloud Relay); a filter that would leave nothing uses every route. The supervisor and the route checks use the filtered list, and changing the choice reconnects that computer at once.
- The computer's page has a "Connect through" group (`RouteChoiceGroup`): Tailscale and Nekko Cloud Relay checkboxes, both on is auto, the last one on cannot be turned off, and a kind the pairing link did not carry is off with one quiet line ("Pair again from <computer> with Nekko Cloud Relay on to add it.").
- There is no page-wide *Tailscale off* item any more. A computer that only Tailscale reaches (by its routes, or because the choice is `direct`) and is blocked by Tailscale being off says *Tailscale off* itself (warning), opens to "Turn on Tailscale to reach <name>." with **Open Tailscale** (`open-tailscale`) and Details when active. Under `cloud`, Tailscale never matters.
- `denied: route` is read as that route failing: the client moves to the next allowed saved route. With none left the row says *refused*, "<name> only lets this phone in through another route.", "Pair again, or change it on <name>." and **Pair again**.
