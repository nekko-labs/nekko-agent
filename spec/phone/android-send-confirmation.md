---
title: "Android: confirming a sent prompt without polling the chat"
area: phone
---

# Android: confirming a sent prompt without polling the chat

## Intent

A prompt leaves the phone's outbox only when the computer's copy of the chat lists its id. Checking that must not mean reading the whole chat twice a second for as long as a turn runs. Same as the iPhone's `Outbox`. Tracked in [#3411](https://github.com/nekko-labs/nekko-agent/issues/3411).

## Behaviour

- After `chat:send` is issued, the chat is re-read when the computer's first event for that chat arrives (it has started the turn, so it has the prompt), when `chat:send` answers, or on a backoff of 0.5, 1, 2 and then 4 seconds.
- Only the first event wakes the check; a streaming reply's later events do not.
- Delivery rules are unchanged: the prompt is delivered once the chat lists its id, refused with the computer's reason when the send is answered without it, and handed back to the outbox ("No answer from your computer yet") after 45 seconds.

## Acceptance

- With a prompt not yet listed, 5 `session:get` calls in the first 10 seconds (the read before sending included), not 20.
- The first event for the chat, and the answer of `chat:send`, each trigger one re-read at once; another chat's event does not.

## Status

Implemented 2026-11-26, JVM-unit-tested. Counts in [perf history](../../docs/perf-history.md).
