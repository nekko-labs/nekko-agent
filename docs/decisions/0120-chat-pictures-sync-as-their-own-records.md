---
status: accepted
date: 2026-11-25
---

# 0120. Chat pictures sync as their own sealed records, named by their bytes

## Context

Encrypted sync left pictures and attached files out of a chat's record and put a short note in their place, so a record stayed mostly text. On another computer the note reached the transcript as an image source and drew a broken image where a pasted screenshot had been. Philip asked (2026-11-25, #3298) for synced chats to show their pictures on the account's other devices.

A chat's record is capped at 16 MB of text, and the chat store already keeps each picture once, beside the chats, as `sessions/blobs/<sha256>.<ext>` with `nekko-blob:<name>` in the chat file ([decision 0072](0072-chat-pictures-beside-the-chat-and-held-turn-saves.md)).

## Options considered

1. **Inline the pictures in the chat record.** One record per chat, but screenshots would push long agent sessions past the cap, every edit of a chat would upload all its pictures again, and the same picture used in several chats would be stored once per chat.
2. **A record per picture, named by its bytes, per computer.** The chat record keeps `nekko-blob:<name>`; each picture travels once as a `picture` record whose local id is the chat's computer and the blob name.
3. **A record per picture shared by the whole account.** Stored once for every computer, but no computer could tell when it was safe to remove one another computer might still use.

## Decision

Option 2. A picture in a message's `images` or `toolResult.images` becomes a `picture` record, sealed with the account's keys like a chat, and pushed before the chat that refers to it. Another computer checks that the bytes hash to the name before writing them beside its chats, where the store already looks for them. A chat that arrives before its pictures shows them as they come; one still missing after a pull is fetched by itself. Each computer removes its own pictures (a sealed tombstone) once none of its chats refers to them, and re-seals the pictures of the chats it re-seals after a key rotation. Pictures over 8 MB, and inline data that isn't one of the store's picture types, still stay out with the note.

## Consequences

- Pictures count toward the plan's synced storage. A full plan holds pictures back without stopping chat sync, and they go up on a later pass.
- Nekko Cloud learns how many pictures an account syncs and their padded sizes, never which chat holds them (object ids are keyed hashes).
- Two computers with the same picture store it twice, once each.
- A chat synced before this keeps its note until its computer runs a version with this change, which sends that chat once more with its pictures.
- Phones read the `nekko-blob:` reference but don't fetch `picture` records yet; until they do, they show the picture as not here.
