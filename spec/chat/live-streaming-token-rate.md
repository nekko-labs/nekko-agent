---
title: "Live streaming token rate"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Live streaming token rate

Implemented, focused regression verification complete; visual/runtime-provider verification pending. Agent reply stats display an approximate (~) tokens/sec rate during a current model call before provider usage arrives, using streamed text/reasoning character counts (four characters per token) and the first-to-latest chunk interval. The first chunk/interval under 100ms remains unavailable rather than inventing a rate. Prompt latency, tool execution and retry backoff are excluded by starting fresh timing windows; failed retry output is discarded. Usage clears the estimate and restores the provider-measured turn rate. No per-token parent ChatPane updates, extra provider requests or persisted telemetry are added. Acceptance: a multi-chunk stream shows a labeled estimate before usage; measured rates remain authoritative on completion; tool/retry waits do not dilute the next call rate.
