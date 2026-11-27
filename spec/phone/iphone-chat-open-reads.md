---
title: "iPhone: fewer reads when a chat is open and re-read (2026-11-26)"
area: phone
---

# iPhone: fewer reads when a chat is open and re-read (#3388)

`[partly implemented 2026-11-26: the skills re-read is gone and unit-tested in NekkoKit (ReloadFanOutTests); the paged open is planned and blocked on the engine (#3439)]` From the phone apps performance audit, item 10.

## User intent

Opening a chat, and the chat catching up after a turn, should not make the computer send 300 messages and answer four or five more questions every time.

## Implemented

- A chat re-read reads the runnable skills only when it is the first read of that screen, the connection came back, or no earlier read succeeded. The turn ending, a card answered and a setting change re-read the chat, its pending cards and its context (and its watches or sub-agents when it delegates), but not the skills, which none of those can change.

## Planned, blocked on the engine

A phone cannot call `session:page` today: it is in the paired-computer class only, its reply is the raw stored messages (no redaction, no thumbnails) and it carries none of the chat's own fields. See [#3439](https://github.com/nekko-labs/nekko-agent/issues/3439) for the verified details and the proposed contract, which both phones use:

- Open with `session:page [id]` and a `limit` of about 40: the phone's `session:get` view of the chat (title, model, mode, queue, `clientMessageIds`, `activeRun`, thumbnails) holding only the newest page, with `omittedMessages` counting the rest.
- When the person scrolls to the top, `session:page [id, firstLoadedMessageId, 40]` returns the older page, redacted like `session:get`; the transcript grows upward without jumping.
- A re-read after a turn reads the loaded window, not 300.
- A computer that does not advertise it keeps the `session:get` path, so nothing costs a refused round trip.

Android does the same against the same contract ([#3415](https://github.com/nekko-labs/nekko-agent/issues/3415)); neither app ships the paged open before the engine does.
