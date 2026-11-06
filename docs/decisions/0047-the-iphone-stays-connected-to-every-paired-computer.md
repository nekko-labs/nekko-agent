---
status: accepted
date: 2026-11-04
---

# 0047. The iPhone stays connected to every paired computer

## Context

The iPhone app was built around one relay connection at a time: the active
computer. The chat list showed that computer's chats, the computer menu had a
**Connect** item for every other one, and a computer's page asked to connect
before it showed anything. Philip asked (2026-11-04) for a main screen that is
not about one computer: every computer's chats together, filtered by computer,
New chat able to pick where it runs, and no Connect button: the phone should
reconnect by itself and stay connected to the computers it is paired with.
Spec: [every computer at once](../../spec/phone/iphone-every-computer-at-once.md).

## Options considered

1. **One connection, switched in turn to read each list.** No new sockets, but
   the list goes stale between rounds, a chat that starts to need you on
   another computer is seen late, and every switch costs a handshake.
2. **A full store per computer.** Everything the active computer has (models,
   settings, Files, terminals, the outbox) for every computer at once. The
   phone would hold several copies of state no screen shows, and every screen
   would have to say which computer it means.
3. **A light link per computer beside the active connection.** Every other
   paired computer keeps its own relay link that reads only what the list needs
   (chats, folders, what needs you) and follows the event stream for who is
   running. Making a computer active takes its link over as it is; the computer
   left behind gets the active connection back as its link.

## Decision

Option 3 (`ComputersStore` with `stayConnected`, `Fleet.swift`). One socket
per paired computer, never two: a computer is either the active one or a link.
Switching hands a socket over, so it never redials. Each link reconnects by
itself as the active connection does, closes with it in the background and
reopens with it. Screens that act on one computer (a chat, New chat, Files,
Settings, the computer's page) make it active first, which is now instant.
Chat actions in the list (complete, pin, rename, delete) go over the chat's own
computer's link. Push is registered on every link, so a chat that needs you on
any computer can notify.

## Consequences

- The phone holds one encrypted socket per paired computer while in the
  foreground (and for the background grace), not one. A few computers is
  the expected case; the cost grows with the number paired.
- The outbox and drafts stay per active computer: a prompt written for a
  computer that isn't active waits until it is active and online.
- Android still connects to one computer at a time.
