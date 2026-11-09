---
status: accepted
date: 2026-11-09
---

# 0073. The iPhone Live Activity counts the whole chat list; voice stays on one computer

## Context

Since 2026-11-04 the iPhone chat list shows every paired computer's chats (and
chats run on the iPhone itself) at once. The Live Activity card still counted
only the active computer, so a chat shown as building in the list could be
missing from the card's Building count. The dashboard spec had said the card's
scope is its computer, "not silently every paired computer".

## Decision

While the app runs, the iPhone builds the card's counts from the same chats the
chat list shows: every paired computer's, plus this iPhone's. The header then
names what the counts cover ("All computers", or "<computer> + iPhone") instead
of the active computer's name, so the wider scope is never silent. A local
whole-list card wins over the active computer's relay push while the app is
running to rebuild it.

The card itself, its push token and app-wide voice stay scoped to the active
computer: `send to` resolves only that computer's chats, and the Lock Screen
microphone never reaches another computer.

## Consequences

- While the app is suspended, the active computer's relay push is what iOS
  shows: its counts cover that computer only and the header shows its name.
  The two scopes are labelled, not merged; a relay-side whole-fleet card would
  need every computer to push to one card and is not built.
- Spoken `status` reports the card's (whole-list) counts under the same label.
- Android has no multi-computer list yet, so its notification already counts
  what its list shows; no Android change.
