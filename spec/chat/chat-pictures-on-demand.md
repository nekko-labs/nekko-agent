---
title: "Chat pictures load on demand"
area: chat
---

# Chat pictures load on demand

## Intent

Opening a chat should cost its text, not every screenshot an agent took. Pictures are fetched as they scroll into view.

## Implemented (daemon, #pictures-daemon)

- `session:get(id, { pictures: 'refs' })` returns `nekko-blob:<name>` references instead of data URLs; the default reply is unchanged for every other client.
- `session:blob(name)` returns one picture as a data URL, or null. Names are strictly validated; the channel needs the per-launch token.
- Chats on other computers are always read inline.

## Planned (renderer)

- The window opts in, resolves pictures lazily with a bounded cache, and budgets its session cache by reference text. See [decision 0123](../../docs/decisions/0123-chat-pictures-load-on-demand.md).
