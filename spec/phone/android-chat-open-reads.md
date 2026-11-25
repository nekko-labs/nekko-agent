---
title: "Android: fewer reads when a chat is open and re-read (2026-11-26)"
area: phone
---

# Android: fewer reads when a chat is open and re-read (#3415)

`[partly implemented 2026-11-26: the skills re-read is gone and unit-tested (ChatControllerTest); the paged open is planned and blocked on the engine (#3439)]` From the phone apps performance audit, item 10. Matches the iPhone ([iphone-chat-open-reads.md](iphone-chat-open-reads.md), #3388).

## User intent

Opening a chat, and the chat catching up after a turn, should not make the computer send 300 messages and answer four or five more questions every time.

## Implemented

- A chat re-read (`ChatController.reload`) reads the runnable skills only when it is the first read of that screen, the connection came back, or no earlier read succeeded. The turn ending, a card answered and a setting change re-read the chat, its pending cards and its context (and its watches or sub-agents when it delegates), but not the skills, which none of those can change.

## Planned, blocked on the engine

A phone cannot call `session:page` today (verified in [#3439](https://github.com/nekko-labs/nekko-agent/issues/3439)): it is in the paired-computer class only, its reply is raw stored messages, and it carries none of the chat's own fields. Android will use exactly the contract proposed there, the same as the iPhone: open with `session:page [id]` and a limit of about 40, fetch older pages with `session:page [id, firstLoadedMessageId, 40]` when the person scrolls to the top, re-read the loaded window after a turn, and keep `session:get` for a computer that does not advertise it. Neither app ships the paged open before the engine does.

## Acceptance

- One open and four re-reads make one `skills:runnable` call; a reconnect, or an earlier failed read, reads them again (unit test).
