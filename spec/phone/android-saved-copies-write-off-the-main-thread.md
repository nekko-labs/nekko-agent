---
title: "Android: saved chats and chat lists are written off the main thread"
area: phone
---

# Android: saved chats and chat lists are written off the main thread

## Intent

Keeping a phone copy of the last chats and of the chat list (to read offline) must not cost the UI thread tens of milliseconds after every turn in a long chat. Same as the iPhone ([#3386](https://github.com/nekko-labs/nekko-agent/issues/3386), `iphone-saved-copies-write-off-the-main-thread.md`). Tracked in [#3413](https://github.com/nekko-labs/nekko-agent/issues/3413).

## Behaviour

- Saving a chat files the copy away and returns. The newest copy per chat is encoded, hashed and written on one background queue about a quarter of a second later, so a burst of re-reads is one write. A chat whose messages, last message, update time, settings and amount of text are unchanged since its last save only moves to the front.
- The chat list is saved the same way: the newest list per computer is written on the queue after the same pause.
- Removals, the index and evictions run on the same queue, in the order asked for, so a removal never overtakes the save before it. A chat removed, or a computer changed, while a save waits: that save is dropped, never written into another computer's folder.
- Reading a saved chat or list returns the newest copy still waiting to be written, so what the screen paints is current.
- When the app goes to the background the waiting writes are handed to the queue at once (Android may end the app before the pause is over). Turning *Keep recent chats to read offline* off waits for the deletions, so none is left behind.
- Privacy and limits are unchanged: at most 20 chats, 5 MB together and 1 MB each, photos never kept, the files stay in the app's no-backup folder.

## Acceptance

- A save returns before anything is on disk; a burst of five saves of one chat is one write of the newest, on the queue's thread (unit test).
- An unchanged chat is not written again, only moved to the front (unit test).
- A removal after a waiting save leaves nothing behind; a save waiting when the computer changes writes nothing (unit tests).
- Caller-thread time per save on a 300-message chat: see [perf history](../../docs/perf-history.md).

## Status

Implemented 2026-11-26, JVM-unit-tested; the files are written by the same `OfflineFileStore` and `ChatListFiles` as before. Not measured on a phone.
