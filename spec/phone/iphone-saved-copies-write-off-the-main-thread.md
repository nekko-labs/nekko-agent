---
title: "iPhone: saved chats and chat lists are written off the main thread (2026-11-26)"
area: phone
---

# iPhone: saved chats and chat lists are written off the main thread (#3386)

`[implemented 2026-11-26, iPhone only; unit-tested in NekkoKit (CoalescedWriterTests, SavedTranscriptsTests, FleetTests); not profiled on a device]` From the phone apps performance audit, item 11. Android has the same synchronous write (`OfflineFileStore.save`): see [the gaps table](ios-and-android-stay-in-step.md).

## User intent

Reading a chat again after a turn, or the chat list refreshing, must not cost the main thread an encode, a hash and a file write each time. What the offline copies keep does not change.

## Behaviour

- **A chat that has not changed is not rewritten.** `SavedTranscripts.save` compares the chat's counts, last message and update time with its last save; if they match, the chat only moves to the front of the recent list.
- **Saves coalesce.** A changed chat is filed away on the main thread and encoded, hashed and written on a background queue about 0.25 s later, newest copy per chat. A burst of re-reads is one write. The index of saved chats and the chat list files are coalesced the same way (`CoalescedWriter`).
- **Reads see the newest copy.** A chat still waiting to be written is read from memory; reading from disk first waits for the writes before it.
- **Removal wins.** Removing a chat, wiping the copies (Settings turned off, Forget), or switching computers never lets a queued write bring a chat back or lose it: a switch lands what was waiting, in the old computer's index, first; a wipe drops what was waiting.
- **The app going to the background hands waiting writes to the queue at once.**
- The limits are unchanged: 20 chats, 5 MB together, 1 MB each; no photos.
