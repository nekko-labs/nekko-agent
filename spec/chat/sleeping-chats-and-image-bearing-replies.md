---
title: "Sleeping chats and image-bearing replies"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Sleeping chats and image-bearing replies

`[implemented; verification in progress on 2026-10-07]` An idle chat with an active durable watch displays **Sleeping · will check in N mins** instead of Done, using hours for waits over one hour. The host exposes only the earliest active watch deadline, not its continuation prompt. Running replies, errors, approvals and questions take precedence. Watch cancellation, delivery and restart are reflected by event refresh plus bounded polling. PR watches may wake before their deadline. Sleeping is informational: the user can send a new reply without cancelling the watch or changing permissions. Since 2026-10-12 the engine daemon owns the watches (`agent-watches.json`, its single writer), arms them from a turn it drives, serves the deadline, and runs the scheduler; the app still reads a PR's state (`gh pr view`) and continues the chat for it, until those move to the daemon too.

The local daemon accepts `loop:run` requests up to 64 MiB, including retained transcript images; other RPC requests retain the 2 MiB limit. The host rejects larger reply payloads explicitly rather than silently discarding history or attachments. Acceptance: an image-bearing request above the previous 2 MiB limit starts successfully, oversized requests remain bounded, and replying in a sleeping chat remains available. No new remote calls or permissions are granted. Focused Rust/host tests and isolated synthetic full-renderer interactions cover these behaviors; live provider/image conversation recovery and native mobile verification remain unverified.

Delegation presentation now uses a left-aligned, borderless branch-and-agent section with **Spawned subagent · task summary**. Expanding preserves the full task and matching result, including failure/missing-result labels. Multi-step groups retain counts; single delegation groups surface the task directly. Existing transcript ID association and permission/privacy boundaries remain unchanged. Matched component before/after evidence covers wide/narrow light/dark layouts; full-renderer interactions also check persisted expansion.
