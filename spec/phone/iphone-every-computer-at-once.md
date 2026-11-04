---
title: "iPhone: every computer at once, and no Connect button (2026-11-04)"
area: phone
---

# iPhone: every computer at once, and no Connect button (2026-11-04)

`[implemented 2026-11-04, iPhone only: the store's fleet links and the aggregate list are tested in NekkoKit (Linux Swift container); the SwiftUI screens build only on macOS CI and were not run on a device or in the simulator yet. Android still connects to one computer at a time]` Decision: [0047](../../docs/decisions/0047-the-iphone-stays-connected-to-every-paired-computer.md).

## User intent

Philip asked (2026-11-04):

- The main screen should not be about one computer. It is always an aggregate view of the fleet, and can be filtered to one computer.
- Starting a new chat, the user picks the computer it runs on, or Nekko Cloud, right from the phone. Opened from one computer's list, New chat starts on that computer.
- No **Connect** button for a computer (Reconnect is fine when it can't be reached). The phone reconnects by itself and stays connected to every paired computer.

## What the user sees

- **The chat list** shows the chats of every paired computer together, grouped and sorted as before (project folders of every computer, a Needs you group across all of them). With more than one computer paired, each row names its computer.
- **The computer pill** above the list reads *All computers* with how many are online (*2 of 3 online*), or the one computer it is filtered to. Its menu starts with **Show chats from**: *All computers* or one computer, each with its connection state. The filter is kept on the phone; forgetting the filtered computer goes back to all. Picking one computer also makes it the active one, so the menu's other items (Files, Logs, Automations, Usage, Settings, the safety exits) act on it.
- **No Connect anywhere.** Every paired computer stays connected and reconnects by itself. Opening a chat on any computer works straight away: the chat's computer becomes the active one over the link the phone already holds. A computer's page opens the same way. The computer menu's per-computer submenu (Connect, Forget) is gone; forgetting is on the computer's page and in Computers.
- **Reconnect** shows only while a computer can't be reached: a line above the list for each such computer (*Studio PC is offline. This phone keeps trying.* with **Reconnect**, or **Pair again** when it refused this phone), in Computers (touch and hold), and on the computer's page. It dials at once instead of waiting for the next try.
- **Computers** shows each computer's own state (Online, Connecting, Computer offline, Refused), not only the active one's.
- **New chat → Run on** is offered whenever more than one computer is paired (before, only for a local model), each with its state; Nekko Cloud stays beside it. New chat starts on the computer the list is filtered to, or with every computer in view on the one used last. Choosing another computer shows its models and folders at once.
- Swipe and touch-and-hold actions on a row (complete, restore, pin, rename, delete) work on any computer's chat, over that computer's link; a computer that isn't connected says so and nothing is sent.

## How it works

- `ComputersStore(stayConnected: true)` keeps a `PeerLink` for every paired computer other than the active one (`Fleet.swift`). A link reads `sessions:summaries`, `workspace:list`, `chat:pending` and `app:info` when it comes online, re-reads the list when a turn ends there, and tracks running and needs-you from the event stream. It registers the phone's push token, so a chat that needs you on any computer notifies.
- One socket per computer, never two. Making a computer active takes its link over with the socket still open (its list and activity stay on screen); the computer left behind gets its socket back as a link. Its Live Activity card registration is withdrawn as before.
- Links close with the active connection in the background (after the grace) and reopen with it; network changes reach every link.
- Unchanged: the outbox, drafts, saved transcripts, models, providers, settings, Files, terminals and the Live Activity card belong to the active computer.

## Acceptance

- With two computers paired and online, the list shows both computers' chats with their computer named, the pill reads *All computers · 2 of 2 online*, and filtering to one shows only its chats.
- Opening a chat on the computer that isn't active opens it with no Connect step and no new connection; the other computer stays online in the pill.
- A computer turned off shows its line with Reconnect within the relay's offline poll; turned on again, it comes back by itself.
- New chat from a list filtered to computer B starts on B; from the all-computers list, on the computer used last; Run on lists both with their state.
- Unit tests: `FleetTests` (NekkoKit).

## Not verified yet

- The screens on a phone or in the simulator (macOS CI builds them; no screenshots yet).
- Battery and data cost of several open sockets on a real iPhone.
