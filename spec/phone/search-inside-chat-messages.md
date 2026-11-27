---
title: "Phones: search inside chat messages (2026-11-27)"
area: phone
---

# Phones: search inside chat messages (#3448)

`[engine side implemented 2026-11-27: the phone channel, its argument check and its reply view, unit-tested in packages/shared and nekko-remote; the iPhone and Android search planned in the same stack]`

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
- iPhone and Android search: planned in the same stack, with the same screens and wording on both (see [ios-and-android-stay-in-step.md](ios-and-android-stay-in-step.md)).
