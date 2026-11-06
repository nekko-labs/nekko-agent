---
title: "Watch lifecycle and delegation failure recovery"
area: agents
---

# Watch lifecycle and delegation failure recovery

## Implemented

Stopping a chat cancels its durable active watches, clears pending wake payloads, aborts active turns/image turns, and terminates tracked processes. Detached delegated descendants are included, even after the parent turn has ended. Completing/archiving or deleting a chat invokes the same cleanup after the store mutation. Merely minimizing a window remains hide-only and intentionally does not cancel work.

Cancellation is persisted before the stop operation returns. A baseline PR read already in flight cannot arm a watch after its chat is stopped. A cancelled watch is reread before delivery and cannot be resumed from a stale poll snapshot. Other chats' watches are untouched. A later intentional run may register new watches normally. The authenticated `session:cancelWatch(sessionId, id)` route only cancels a watch belonging to that chat; no credentials or new scheduler is introduced. Native phone capability lists do not expose this mutation yet.

Delegation failure tool results include explicit recovery guidance: tell the user immediately, inspect saved work, continue directly if safe and the user has not stopped/paused, or report the concrete blocker. No automatic provider/model fallback or automatic restart is added. This guidance improves recoverability but does not guarantee a model obeys it.

## Verification

Rust scheduler tests cover cancellation and ownership isolation, pending wake persistence/restart, stale-snapshot delivery, cancellation during a blocked PR baseline read, and intentional rearming after a later run. Delegation golden fixtures intentionally add recovery guidance to existing failures; error codes and fallback behavior remain unchanged. Full provider-backed OS-close races and billing-provider token accounting are not verified. Already consumed tokens cannot be undone; stopping cancels future continuations, not past usage.
