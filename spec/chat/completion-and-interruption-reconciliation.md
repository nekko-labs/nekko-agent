---
title: "Completion and interruption reconciliation"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Completion and interruption reconciliation

Implemented and verified with 1,124 desktop tests, typecheck, and 80 isolated renderer assertions plus matched completion screenshots: an explicit successful terminal record (`turnStats.stop: complete`) takes precedence over unmatched historical tool bookkeeping when inferring a persisted interruption. An explicit interrupted marker still wins, and unresolved tool calls without successful terminal evidence remain recoverable. A transient inferred interruption banner clears when the completed transcript arrives; provider errors and user-requested stops are not silently cleared. No transcript or private app data is rewritten. Acceptance: completed and genuinely interrupted fixture cases, delayed transcript reconciliation, and isolated light/dark wide/narrow evidence. The exact triggering transcript in the reported screenshot was not accessible in the workspace sandbox.

## Failed replies keep their recovery after a restart `[implemented; daemon and renderer tests; not tried against a real provider limit or in a packaged app]`

A reply can fail between steps, for example when the account runs out of usage right after a tool finishes. The transcript then looks finished: no `interrupted` marker, no unanswered tool call. The error only ever reached open windows as an event, so closing the app lost the failure notice along with Retry and Delete last message, and the user had no way to tell the reply never finished.

- When a turn ends on an error, the host saves `turnFailure` on the chat: the error text and the id of the transcript's last message. It is not a message, so it is never sent to a model.
- Opening the chat shows the same notice with the original error, Retry and Delete last message.
- The notice applies only while that message is still the last one, so deleting or restarting past it retires it. Starting the next turn clears the record, and Dismiss clears it for good.
- A Stop is recorded the same way, with the message `Stopped`, and reads "Reply paused" rather than as a failure. A Stop that lands between steps, during a model call that has not streamed anything, leaves no partial reply to mark, so without this record the chat just ended with nothing to say why or to retry. A stopped reply with partial output also keeps its `interrupted` marker.
- A transcript that ends on a tool result, with no run active and no `turnStats.stop: complete`, reads as interrupted even with no record, because a finished reply ends with the model's word. This covers chats stopped before the record existed. Dismiss saves `turnFailure: null`, so a dismissed notice of either kind stays gone after reopening, until the next turn.
- Incognito chats are never written to disk, so their failures still end with the app.

## Replies that reach the output limit `[implemented 2026-10-28; provider and loop unit-tested; Anthropic-family providers only]`

A reply can stop because it reached the model's output cap (`max_tokens`) rather than because the model finished. Thinking counts against that cap, so at a high effort on a long chat a Claude model can spend all of it thinking and write nothing. That reply used to be treated as an empty response: it was sent once more with "Please continue", which spent the whole cap again, and then it showed "the model returned an empty response". The user had no hint that a lower effort would help.

- The provider reports a stop at the output cap (Anthropic's `stop_reason: max_tokens`, also over Bedrock, Vertex and Foundry).
- An empty reply that hit the cap is **not retried**. It reads: "The model used its whole output budget thinking and stopped before answering. Try a lower effort level, or ask for something smaller."
- A text reply cut off at the cap keeps its text and ends with "Cut off: the reply reached the model's output limit."
- An empty reply that did not hit the cap is still retried once with the nudge, as before, because local models can stall mid-loop.
- `turnStats.stop` stays `complete`; the transcript text is what says the reply was cut off.

Planned: the OpenAI-compatible, ChatGPT and Ollama providers do not yet report their own length stops (`finish_reason: length` and equivalents).
