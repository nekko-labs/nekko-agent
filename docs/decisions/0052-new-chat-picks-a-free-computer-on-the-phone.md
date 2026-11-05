---
status: accepted
date: 2026-11-05
---

# 0052. New chat picks a free computer on the phone, for local models

## Context

With every paired computer connected at once ([0047](0047-the-iphone-stays-connected-to-every-paired-computer.md)),
the person starting a chat still had to know which computer was free. The ask
(2026-11-05): people may pick, but by default the app picks an available
machine for a local model, then the model, then sends the chat there. Spec:
[New chat picks a free computer](../../spec/phone/iphone-new-chat-picks-a-free-computer.md).

## Options considered

1. **A broker in Nekko Cloud.** Every computer reports its presence to Nekko
   Cloud, and the phone asks Nekko Cloud where to go. It works for computers
   the phone isn't connected to, and it is where the CI runners' fleet (P4)
   is headed. But it needs a Nekko Cloud account, sends usage signals off the
   computers, and does nothing the phone can't already learn over its own links.
2. **The phone picks, over the links it already holds.** At New chat the phone
   asks each online computer `activity:state` and `providers:list` in parallel
   and ranks them. No account, no new server, no data leaves the end-to-end
   encrypted links.

## Decision

Option 2. `activity:state` joins the phone's read channels with a yes/no
projection (`PHONE_ACTIVITY_VIEW`: `userActive`, `chatActive`, `headless`,
`strain`): never idle seconds, the battery level or temperatures, and the
phone cannot set the idle threshold. The ranking is pure (`MachinePicker`,
NekkoKit): free (no chat replying, nobody at the keyboard) first, then the one
used last, then not on battery or hot, then pairing order; with none free, the
one used last.

Approved defaults (Davide, 2026-11-05): only chats on a local model move;
a chosen folder decides the computer; everything busy or offline falls back to
the computer used last and says so; the iPhone first.

## Consequences

- A computer older than this answers `channel-denied`; it counts as "didn't
  say", ranked after one that says it is free and before one that is busy.
- Computers the phone isn't paired with are never considered. Option 1 stays
  open for teams and CI runners and would replace the probe, not the ranking.
- Android and the desktop don't pick yet.
