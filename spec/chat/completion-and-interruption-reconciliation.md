---
title: "Completion and interruption reconciliation"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Completion and interruption reconciliation

Implemented and verified with 1,124 desktop tests, typecheck, and 80 isolated renderer assertions plus matched completion screenshots: an explicit successful terminal record (`turnStats.stop: complete`) takes precedence over unmatched historical tool bookkeeping when inferring a persisted interruption. An explicit interrupted marker still wins, and unresolved tool calls without successful terminal evidence remain recoverable. A transient inferred interruption banner clears when the completed transcript arrives; provider errors and user-requested stops are not silently cleared. No transcript or private app data is rewritten. Acceptance: completed and genuinely interrupted fixture cases, delayed transcript reconciliation, and isolated light/dark wide/narrow evidence. The exact triggering transcript in the reported screenshot was not accessible in the workspace sandbox.

## Replies that reach the output limit `[implemented 2026-10-28; provider and loop unit-tested; Anthropic-family providers only]`

A reply can stop because it reached the model's output cap (`max_tokens`) rather than because the model finished. Thinking counts against that cap, so at a high effort on a long chat a Claude model can spend all of it thinking and write nothing. That reply used to be treated as an empty response: it was sent once more with "Please continue", which spent the whole cap again, and then it showed "the model returned an empty response". The user had no hint that a lower effort would help.

- The provider reports a stop at the output cap (Anthropic's `stop_reason: max_tokens`, also over Bedrock, Vertex and Foundry).
- An empty reply that hit the cap is **not retried**. It reads: "The model used its whole output budget thinking and stopped before answering. Try a lower effort level, or ask for something smaller."
- A text reply cut off at the cap keeps its text and ends with "Cut off: the reply reached the model's output limit."
- An empty reply that did not hit the cap is still retried once with the nudge, as before, because local models can stall mid-loop.
- `turnStats.stop` stays `complete`; the transcript text is what says the reply was cut off.

Planned: the OpenAI-compatible, ChatGPT and Ollama providers do not yet report their own length stops (`finish_reason: length` and equivalents).
