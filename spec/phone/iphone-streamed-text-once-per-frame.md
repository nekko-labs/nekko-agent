---
title: "iPhone: streamed text is folded in once per display frame (2026-11-26)"
area: phone
---

# iPhone: streamed text is folded in once per display frame (#3387)

`[implemented 2026-11-26, iPhone only; unit-tested in NekkoKit (StreamThrottleTests); not profiled on a device]` From the phone apps performance audit, item 13. The parse-once, patch-the-last-block design of #1412 is unchanged. Android is being brought in line separately: see [the gaps table](ios-and-android-stay-in-step.md).

## User intent

A fast reply should not make the phone redraw the chat once per token. The text reads the same, and the first words still appear straight away; the work happens at most once per screen refresh.

## Behaviour

- Text and reasoning deltas that arrive between two display frames are collected and folded into the running turn in one write (`ChatModel.flushDeltas`), then the existing patch-the-last-block path updates the last block once. The frame is the screen's refresh interval (1/60 s, 1/120 s on a ProMotion display, never slower than 1/30 s).
- Any other event (a tool call or result, an approval, a question, the end of the turn, an error) folds the waiting text in first, so order is never changed. A reload, a send, Stop, an approval and an answer do the same. Leaving the chat folds in what was waiting.
- The character count behind the context gauge still counts every delta.
- `ChatModel.deltaInterval` of zero applies each delta as it arrives (used by tests that check the per-token path).
