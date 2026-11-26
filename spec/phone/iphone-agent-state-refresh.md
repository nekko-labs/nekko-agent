---
title: "iPhone: delegating chats read the chat list only when it can have changed (2026-11-26)"
area: phone
---

# iPhone: delegating chats read the chat list only when it can have changed (#3384)

`[implemented 2026-11-26, iPhone only; unit-tested in NekkoKit]` From the phone apps performance audit, item 4. Android already refreshes on the same transitions.

- A tool result makes the chat re-read its agent state (watches, and the chat list for child chats) only when it belongs to a watch (`agent_watch`), a clip tool or a sub-agent (`spawn_agent`) call. A result whose call the phone never saw (it joined mid-turn) is read to be safe.
- One re-read runs at a time. Results that arrive while it is in flight are answered by one more read after it, not one each.
- A turn's end, a reconnect and a pull still re-read everything, as before, and an armed watch's chip still refreshes every 15 s.
