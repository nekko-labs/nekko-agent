---
title: "Phones: search inside chat messages (2026-11-27)"
area: phone
---

# Phones: search inside chat messages (#3448)

`[engine side implemented 2026-11-27: the phone channel, its argument check and its reply view, unit-tested in packages/shared and nekko-remote; Android and the iPhone implemented the same day]`

## User intent

On the desktop the chat finder matches what was said in a chat, not only its title and summary. On a phone, searching the chat list for a phrase someone said in the middle of a chat should find that chat too, with the line it was said in, without downloading every transcript.

## What the phone may read

`sessions:finderText` (from #3447) is a read-class phone channel: refused while the device's Read switch is off, like `sessions:summaries`. A phone sends one argument, a list of 1 to 20 chat ids (each non-empty, at most 128 characters), and nothing else. `PHONE_FINDER_VIEW` in `packages/shared/src/phone-access.ts` sets the limits; `nekko-remote` (`phone_finder.rs`) enforces them.

The reply has one entry per asked chat:
- `title` and `updatedAt`;
- its newest 300 messages, user and assistant only, each with its role, its text (a skill's input after it) cut to 8,000 characters, and up to 20 file paths its tool calls named (`path`, `file_path`);
- `omittedMessages` when older messages were left out;
- `null` for a chat the computer doesn't have.

The phone never receives pictures, reasoning, tool output, or where the chat's checkout lives (`workspaceId`, `gitWorktrees`).

Chats are answered in the asked order while the reply stays under 6 MB of JSON, well inside the 9 MB a phone frame may carry (`PHONE_MAX_FRAME_BYTES`). Chats that don't fit are absent from the reply, and the phone asks for them on its next call. A first chat too large on its own (only text in a three-byte script can get there) keeps its newest messages that fit.

## Acceptance

- A phone with Read on gets the view above. With Read off, or a bad argument, the call is refused with `read-off`, `value-invalid` or `option-denied`.
- The reply never exceeds the byte budget, and never carries a field outside the view.
- A computer without the channel refuses it with `channel-denied`. The phone then searches summaries only, as before.

## Status

- Engine side: implemented 2026-11-27, unit-tested (`phone-access.test.ts`; `phone_finder.rs` tests).
- Android: implemented 2026-11-27 (`FinderText.kt` in the protocol module, `FinderTexts.kt`, the chat list's search). JVM-tested, and checked on an API 37 emulator against a fake computer, including one that refuses the channel. Not yet on a physical phone.
- iPhone: implemented 2026-11-27 (`FinderText.swift` in NekkoProtocol, `ComputersStore.loadFinderTexts`, `ChatsView`). Unit-tested, and checked with `ChatSearchMessagesTests` on the iOS 27.2 simulator over a seeded fixture, including a computer without the channel. Not yet on a physical iPhone. Same behaviour and wording as Android.

## On the phone

While someone searches the chat list, the phone reads the text of the chats it lists from each chat's own computer, 20 at a time, only for chats it hasn't read yet or that changed since (their summary's `updatedAt`). Every word of the search, in any case or accent, must appear somewhere in the chat: title, first prompt, last reply, a message, or a file a tool call named. A row found beyond its title shows one line under it: the piece of the summary or of the message where a word the title lacks was found. That's 24 characters before the word and 90 in all, with … where text was cut, as the desktop chat finder does. Matching starts with the summaries and gets richer as text arrives. No new words in the interface.
