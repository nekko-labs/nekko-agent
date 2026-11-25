---
title: "Android: streaming and chat-open performance"
area: phone
---

# Android: streaming and chat-open performance

## Intent

A long reply in a long chat must not make the Android app stutter or drain the battery. The work done per streamed token must not grow with the length of the chat. Matches what the iPhone already does (`ChatModel`). From the 2026-11-26 phone performance audit; tracked in [#3410](https://github.com/nekko-labs/nekko-agent/issues/3410).

## Behaviour

- The saved transcript, the question-reply projection and each reply's footer are worked out once when the chat is read, not on every token. A token that only grows the reply being written replaces just that last block; a tool call, a result, a reply for another turn or the end of the turn merges again.
- The screen keeps what it derived from the earlier blocks (list keys, rows, the voice of each reply) while a reply streams, so only the tail is rebuilt and rows already drawn are skipped. List keys stay what they were, so scroll position and open or closed rows are kept.
- Streamed words (text and reasoning) are applied once per display frame: the words that arrive between two frames are joined into one delta, in order, and any other event applies the held words first. What is shown is the same, only the number of updates changes.

## Acceptance

- Parsing the saved transcript happens once per read of the chat (unit test counts it).
- The blocks after any streamed event equal the whole merge done from scratch (unit test over text, reasoning, tool call, result and done events, including a reply that repeats a saved one).
- Joined deltas keep their order relative to other events (unit test).

## Status

Implemented 2026-11-26, JVM-unit-tested. Per-token CPU on a 300-message chat is recorded in [perf history](../../docs/perf-history.md). Not measured on a device: frame time while streaming.
