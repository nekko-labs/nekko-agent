# 0080. Bind pending phone responses to the original request

Status: accepted behavior; native implementation and verification tracked in [#2476](https://github.com/nekko-labs/nekko-agent/issues/2476).

## Context

A disconnected phone currently refuses question answers and approvals without retaining a response message. The requested behavior is to retain those responses, automatically deliver on reconnect, and allow Retry or Cancel. Cancel removes the unsent message rather than hiding a transport error.

## Decision

Persist answers and one-time Allow/Deny responses per computer, separately from the prompt outbox. Give each response a stable local identifier and display its original request identifier. Before each dispatch, read `chat:pending` and require the same session, call identifier, and question/approval snapshot. Do not apply an old answer to a replacement question or approval. Unchanged requests use the existing `chat:answer` and `tool:approve` channels; this adds no host authorization or policy bypass.

Retry performs the same fresh check. Cancel removes an unsent response, but a dispatched request cannot be recalled. A missing or changed request is shown as no longer pending, not as proof of delivery after a lost acknowledgement. Single-flight dispatch prevents concurrent duplicate sends; no exactly-once transport guarantee is claimed.

Guarded Always allow settings changes, notification/voice actions, and Monitors remain online-only. Only a foreground chat response enters this queue. The existing OS-protected offline storage and Forget lifecycle apply.

## Consequences

This replaces the blanket never-queue rule for in-chat answers and one-time approvals. It does not add an offline authority to change security policy. Response data stays local until delivery and must remain scoped through computer switches, navigation, and restart. Tests must cover cancellation, stale/changed requests, malformed pending reads, lost acknowledgements, and scope changes during an in-flight preflight.
